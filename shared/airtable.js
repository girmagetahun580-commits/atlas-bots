// Airtable API helpers — direct access, no HTTP self-calls
// Used by data-middleware.js and api-server.js
import { AIRTABLE_PAT, AIRTABLE_BASE_ID } from './config.js';

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

export async function airtableFetch(path, options = {}) {
  if (!AIRTABLE_PAT) throw new Error('AIRTABLE_PAT not set');
  const res = await fetch(`${AIRTABLE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable ${res.status}: ${body}`);
  }
  return res.json();
}

export async function listRecords(table, params = {}) {
  const records = [];
  let offset;
  do {
    const qs = new URLSearchParams(params);
    if (offset) qs.set('offset', offset);
    const data = await airtableFetch(`/${encodeURIComponent(table)}?${qs}`);
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// --- Task operations ---

export async function getTasks() {
  const records = await listRecords('Tasks', {
    filterByFormula: "NOT({status} = 'done')",
    'sort[0][field]': 'priority',
    'sort[0][direction]': 'desc',
  });
  return records.map(r => ({
    id: r.id,
    name: r.fields.name,
    status: r.fields.status || 'todo',
    priority: r.fields.priority || 3,
    due_date: r.fields.due_date || null,
    project: r.fields.project || '',
  }));
}

export async function addTask({ name, priority, due_date, project }) {
  const fields = {
    name: name || 'Untitled task',
    status: 'todo',
    priority: priority || 3,
    last_touched: new Date().toISOString().slice(0, 10),
  };
  if (due_date) fields.due_date = due_date;
  if (project) fields.project = project;

  const data = await airtableFetch(`/${encodeURIComponent('Tasks')}`, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  return data.records[0];
}

export async function completeTask(nameQuery) {
  const records = await listRecords('Tasks', {
    filterByFormula: "NOT({status} = 'done')",
  });
  const target = records.find(r =>
    r.fields.name.toLowerCase().includes(nameQuery.toLowerCase())
  );
  if (!target) return null;

  await airtableFetch(`/${encodeURIComponent('Tasks')}/${target.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: { status: 'done', last_touched: new Date().toISOString().slice(0, 10) },
      typecast: true,
    }),
  });
  return target;
}

// --- Habit operations ---

export async function getHabits() {
  const records = await listRecords('Habits');
  return records.map(r => ({
    id: r.id,
    name: r.fields.habit,
    window: r.fields.target_window || 'anytime',
    streak: r.fields.streak || 0,
    todayDone: r.fields.completed || false,
  }));
}

export async function completeHabit(nameQuery) {
  const records = await listRecords('Habits');
  const target = records.find(r =>
    r.fields.habit.toLowerCase().includes(nameQuery.toLowerCase())
  );
  if (!target) return null;

  const newStreak = (target.fields.streak || 0) + 1;
  await airtableFetch(`/${encodeURIComponent('Habits')}/${target.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        completed: true,
        date: new Date().toISOString().slice(0, 10),
        streak: newStreak,
      },
      typecast: true,
    }),
  });
  return { name: target.fields.habit, streak: newStreak };
}

// --- Finance operations ---

export async function getBills() {
  const records = await listRecords('Finance', {
    filterByFormula: '{recurring} = TRUE()',
  });
  const bills = records.map(r => ({
    id: r.id,
    vendor: r.fields.vendor,
    amount: r.fields.amount || 0,
    category: r.fields.category || 'misc',
    due_date: r.fields.due_date || null,
  }));
  const total_monthly = bills.reduce((s, b) => s + b.amount, 0);
  return { bills, total_monthly };
}

export async function addExpense({ vendor, amount, category, notes }) {
  const fields = {
    vendor: vendor || 'Unknown',
    amount: parseFloat(amount) || 0,
    date: new Date().toISOString().slice(0, 10),
    category: category || 'misc',
  };
  if (notes) fields.notes = notes;

  const data = await airtableFetch(`/${encodeURIComponent('Finance')}`, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  return data.records[0];
}

export async function getSpending() {
  const records = await listRecords('Finance', {
    filterByFormula: "NOT({recurring} = TRUE())",
  });
  const expenses = records.map(r => ({
    vendor: r.fields.vendor,
    amount: r.fields.amount || 0,
    category: r.fields.category || 'misc',
    date: r.fields.date || null,
  }));
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const byCategory = {};
  expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
  return { expenses: expenses.slice(-10), total, by_category: byCategory };
}

// --- Weather ---

export async function getWeather() {
  try {
    const res = await fetch('https://wttr.in/Jinka+Ethiopia?format=j1');
    const data = await res.json();
    const current = data.current_condition[0];
    return {
      location: 'Jinka, Ethiopia',
      temperature: `${current.temp_C}°C`,
      feels_like: `${current.FeelsLikeC}°C`,
      condition: current.weatherDesc[0].value,
      humidity: `${current.humidity}%`,
      wind: `${current.windspeedKmph} km/h`,
    };
  } catch (err) {
    return { error: 'Weather unavailable', details: err.message };
  }
}

// --- Briefing (aggregated) ---

export async function getBriefing(googleModule) {
  const [tasks, habits, financeData] = await Promise.all([
    getTasks(),
    getHabits(),
    getBills(),
  ]);

  const topTasks = tasks.slice(0, 3).map(t => `${t.name} (priority ${t.priority})`);
  const doneCount = habits.filter(h => h.todayDone).length;
  const weather = await getWeather();
  const upcoming = financeData.bills
    .filter(b => b.due_date)
    .map(b => ({ vendor: b.vendor, due_date: b.due_date }));

  let calendar = 'not connected';
  let email_stats = 'not connected';

  if (googleModule && googleModule.isGoogleConfigured()) {
    try { calendar = await googleModule.getCalendarEvents(); } catch (err) { calendar = { error: 'Failed', details: err.message }; }
    try {
      const stats = await googleModule.getEmailStats();
      email_stats = { unread_count: stats.unread_count, urgent_count: stats.urgent_count };
    } catch (err) { email_stats = { error: 'Failed', details: err.message }; }
  }

  return {
    top_tasks: topTasks,
    habits: `${doneCount}/${habits.length} done`,
    weather: weather.error ? 'unavailable' : `${weather.temperature}, ${weather.condition}`,
    upcoming_bills: upcoming,
    calendar,
    email_stats,
  };
}
