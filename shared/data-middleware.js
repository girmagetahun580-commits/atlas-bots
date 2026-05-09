// Intent detection + live data fetching — shared across Discord and Telegram
// Calls airtable.js directly (no HTTP self-calls)
import * as airtable from './airtable.js';
import * as google from './google.js';

// --- Intent detection from natural language ---

export function detectIntent(message) {
  const lower = message.toLowerCase();
  const intents = new Set();
  const extractedParams = {};

  // Write intents (actions)
  if (/\b(add task|new task|create task)\b/.test(lower)) {
    intents.add('add_task');
    const nameMatch = message.match(/(?:add task|new task|create task)[:\s]+(.+?)(?:\s+by\s+|\s+due\s+|\s+for\s+|\s+priority\s+|$)/i);
    if (nameMatch) extractedParams.taskName = nameMatch[1].trim();
    const priorityMatch = lower.match(/\b(priority|pri)\s*[:\s]*(high|medium|low|\d+)/);
    if (priorityMatch) extractedParams.priority = priorityMatch[2];
    const dueMatch = message.match(/\b(?:by|due)[:\s]+([^\s,]+(?:\s+[^\s,]+)?)/i);
    if (dueMatch) extractedParams.dueDate = dueMatch[1].trim();
    const projectMatch = message.match(/\bfor\s+(?:project\s+)?([^\s,]+)/i);
    if (projectMatch) extractedParams.project = projectMatch[1].trim();
  }

  if (/\b(complete task|done with|finished|mark done)\b/.test(lower)) {
    intents.add('complete_task');
    const nameMatch = message.match(/(?:complete task|done with|finished|mark done)[:\s]+(.+?)(?:\s*$)/i);
    if (nameMatch) extractedParams.taskName = (extractedParams.taskName || nameMatch[1].trim());
  }

  if (/\b(complete habit|did my|finished my)\b/.test(lower)) {
    intents.add('complete_habit');
    const nameMatch = message.match(/(?:complete habit|did my|finished my)[:\s]+(.+?)(?:\s*$)/i);
    if (nameMatch) extractedParams.habitName = nameMatch[1].trim();
  }

  if (/\b(spent|bought|paid|log expense)\b/.test(lower)) {
    intents.add('log_expense');
    const amountMatch = message.match(/\$?([\d]+(?:\.\d{1,2})?)\s*(?:dollars?|birr|etb)?/i);
    if (amountMatch) extractedParams.amount = parseFloat(amountMatch[1]);
    const vendorMatch = message.match(/(?:\bat\b|\bfrom\b|\bto\b)\s+([A-Za-z0-9 &']+?)(?:\s+for\s+|\s+\$|\s+\d|\s*$)/i);
    if (vendorMatch) extractedParams.vendor = vendorMatch[1].trim();
    const categoryMatch = message.match(/\bfor\s+([A-Za-z]+)\b/i);
    if (categoryMatch) extractedParams.category = categoryMatch[1].trim();
  }

  // Read intents (queries)
  if (/\b(tasks?|to[\s-]?do|todo|what should i)\b/.test(lower)) intents.add('tasks');
  if (/\b(habits?|workout|meditate|meditating|reading|water|journal|phone before bed)\b/.test(lower)) intents.add('habits');
  if (/\b(bills?|finance|money|spend|expense|budget)\b/.test(lower)) intents.add('finance');
  if (/\b(weather|temperature|rain|hot|cold)\b/.test(lower)) intents.add('weather');
  if (/\b(briefing|brief me|morning|what'?s up|how'?s my day|summary|overview)\b/.test(lower)) intents.add('briefing');
  if (/\b(calendar|schedule|meeting|event|agenda)\b/.test(lower)) intents.add('calendar');
  if (/\b(email|inbox|mail|gmail|unread)\b/.test(lower)) intents.add('email');

  let finalIntents = [...intents];
  // Briefing subsumes individual data intents
  if (finalIntents.includes('briefing')) {
    finalIntents = finalIntents.filter(i => !['tasks', 'habits', 'finance', 'weather', 'calendar', 'email'].includes(i));
  }

  return { intents: finalIntents, extractedParams };
}

// --- Fetch live data for detected intents ---

export async function fetchDataForIntents(intents, params = {}) {
  const sections = [];

  for (const intent of intents) {
    switch (intent) {
      case 'tasks': {
        try {
          const tasks = await airtable.getTasks();
          if (tasks.length === 0) {
            sections.push('### Active Tasks\nNo active tasks found.');
          } else {
            const lines = tasks.map((t, i) => {
              const parts = [`${i + 1}. ${t.name}`];
              if (t.priority != null) parts.push(`priority: ${t.priority}`);
              if (t.due_date) parts.push(`due: ${t.due_date}`);
              if (t.project) parts.push(`project: ${t.project}`);
              return parts.join(' | ');
            });
            sections.push(`### Active Tasks\n${lines.join('\n')}`);
          }
        } catch (err) {
          sections.push(`### Active Tasks\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'habits': {
        try {
          const habits = await airtable.getHabits();
          if (habits.length === 0) {
            sections.push("### Today's Habits\nNo habits found.");
          } else {
            const lines = habits.map(h => `- ${h.name}: ${h.todayDone ? 'done' : 'pending'} (streak: ${h.streak})`);
            sections.push(`### Today's Habits\n${lines.join('\n')}`);
          }
        } catch (err) {
          sections.push(`### Today's Habits\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'finance': {
        try {
          const data = await airtable.getBills();
          const lines = data.bills.map(b => `- ${b.vendor}: $${b.amount || 0} (${b.category || 'misc'})`);
          sections.push(`### Recurring Bills\n${lines.join('\n')}\nTotal monthly: $${data.total_monthly || 0}`);
        } catch (err) {
          sections.push(`### Recurring Bills\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'weather': {
        try {
          const data = await airtable.getWeather();
          if (data.error) {
            sections.push(`### Current Weather\n[${data.error}]`);
          } else {
            sections.push(`### Current Weather\n${data.location}: ${data.temperature}, ${data.condition}, Humidity: ${data.humidity}, Wind: ${data.wind}`);
          }
        } catch (err) {
          sections.push(`### Current Weather\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'calendar': {
        if (!google.isGoogleConfigured()) {
          sections.push('### Calendar\nGoogle not connected.');
          break;
        }
        try {
          const events = await google.getCalendarEvents(1);
          if (Array.isArray(events) && events.length > 0) {
            const lines = events.map(e => `- ${e.title} (${e.start})`);
            sections.push(`### Today's Calendar\n${lines.join('\n')}`);
          } else if (Array.isArray(events)) {
            sections.push("### Today's Calendar\nNo events today.");
          } else {
            sections.push(`### Today's Calendar\n[${events.error || 'Unknown error'}]`);
          }
        } catch (err) {
          sections.push(`### Today's Calendar\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'email': {
        if (!google.isGoogleConfigured()) {
          sections.push('### Email\nGoogle not connected.');
          break;
        }
        try {
          const stats = await google.getEmailStats();
          if (stats.error) {
            sections.push(`### Email Stats\n[${stats.error}]`);
          } else {
            sections.push(`### Email Stats\nUnread: ${stats.unread_count}, Urgent: ${stats.urgent_count}${stats.oldest_unanswered_hours != null ? `, Oldest unanswered: ${stats.oldest_unanswered_hours}h` : ''}`);
          }
        } catch (err) {
          sections.push(`### Email Stats\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'briefing': {
        try {
          const data = await airtable.getBriefing(google);
          sections.push(`### Daily Briefing\n${JSON.stringify(data, null, 2)}`);
        } catch (err) {
          sections.push(`### Daily Briefing\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'add_task': {
        if (!params.taskName) { sections.push('### Add Task\n[Could not extract task name]'); break; }
        try {
          const record = await airtable.addTask({
            name: params.taskName,
            priority: params.priority,
            due_date: params.dueDate,
            project: params.project,
          });
          sections.push(`### Add Task\nTask added: "${record.fields.name}"`);
        } catch (err) {
          sections.push(`### Add Task\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'complete_task': {
        if (!params.taskName) { sections.push('### Complete Task\n[Could not extract task name]'); break; }
        try {
          const result = await airtable.completeTask(params.taskName);
          sections.push(`### Complete Task\n${result ? `Task completed: "${result.fields.name}"` : `No active task matching "${params.taskName}"`}`);
        } catch (err) {
          sections.push(`### Complete Task\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'complete_habit': {
        if (!params.habitName) { sections.push('### Complete Habit\n[Could not extract habit name]'); break; }
        try {
          const result = await airtable.completeHabit(params.habitName);
          sections.push(`### Complete Habit\n${result ? `"${result.name}" marked done! Streak: ${result.streak} days` : `No habit matching "${params.habitName}"`}`);
        } catch (err) {
          sections.push(`### Complete Habit\n[Error: ${err.message}]`);
        }
        break;
      }
      case 'log_expense': {
        if (!params.vendor || params.amount == null) { sections.push('### Log Expense\n[Missing vendor or amount]'); break; }
        try {
          const record = await airtable.addExpense({
            vendor: params.vendor,
            amount: params.amount,
            category: params.category,
          });
          sections.push(`### Log Expense\nExpense logged: ${record.fields.amount} at ${record.fields.vendor}`);
        } catch (err) {
          sections.push(`### Log Expense\n[Error: ${err.message}]`);
        }
        break;
      }
      default: break;
    }
  }

  if (sections.length === 0) return '';
  return ['--- LIVE CONTEXT DATA ---', sections.join('\n\n'), '--- END LIVE CONTEXT DATA ---'].join('\n');
}
