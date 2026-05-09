// Health endpoint + API middleware for ElevenLabs voice tools
// Also used by the Discord bot's data-middleware for local API calls
import { createServer } from 'http';
import { PORT, API_SECRET_KEY } from '../shared/config.js';
import * as airtable from '../shared/airtable.js';
import * as google from '../shared/google.js';

let botOnline = false;
let lastActivity = Date.now();

export function markOnline() { botOnline = true; lastActivity = Date.now(); }
export function markActivity() { lastActivity = Date.now(); }

// --- Auth & body parsing ---

function checkAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${API_SECRET_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// --- API request handler (for ElevenLabs server tools) ---

async function handleAPIRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return true; }
  if (!path.startsWith('/api/')) return false;

  const noAuthPaths = ['/api/google/auth', '/api/google/callback'];
  if (!noAuthPaths.includes(path) && !checkAuth(req, res)) return true;

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Tasks
  if (path === '/api/tasks' && method === 'GET') {
    try {
      const tasks = await airtable.getTasks();
      json({ tasks, total: tasks.length, active: tasks.length });
    } catch (err) { json({ error: 'Failed to fetch tasks', details: err.message }, 500); }
    return true;
  }
  if (path === '/api/tasks' && method === 'POST') {
    const body = await parseBody(req);
    try {
      const record = await airtable.addTask(body);
      json({ message: `Task added: "${record.fields.name}"`, task: record.fields });
    } catch (err) { json({ error: 'Failed to add task', details: err.message }, 500); }
    return true;
  }
  if (path === '/api/tasks/complete' && method === 'POST') {
    const body = await parseBody(req);
    try {
      const result = await airtable.completeTask(body.name || '');
      json(result ? { message: `Task completed: "${result.fields.name}"` } : { message: `No active task matching "${body.name}"` });
    } catch (err) { json({ error: 'Failed to complete task', details: err.message }, 500); }
    return true;
  }

  // Habits
  if (path === '/api/habits' && method === 'GET') {
    try {
      const habits = await airtable.getHabits();
      json({ habits, completed_today: habits.filter(h => h.todayDone).length, total: habits.length });
    } catch (err) { json({ error: 'Failed to fetch habits', details: err.message }, 500); }
    return true;
  }
  if (path === '/api/habits/complete' && method === 'POST') {
    const body = await parseBody(req);
    try {
      const result = await airtable.completeHabit(body.name || '');
      json(result ? { message: `"${result.name}" marked done! Streak: ${result.streak} days` } : { message: `No habit matching "${body.name}"` });
    } catch (err) { json({ error: 'Failed to complete habit', details: err.message }, 500); }
    return true;
  }

  // Finance
  if (path === '/api/finance/bills' && method === 'GET') {
    try {
      const data = await airtable.getBills();
      json(data);
    } catch (err) { json({ error: 'Failed to fetch bills', details: err.message }, 500); }
    return true;
  }
  if (path === '/api/finance/add' && method === 'POST') {
    const body = await parseBody(req);
    try {
      const record = await airtable.addExpense(body);
      json({ message: `Expense logged: ${record.fields.amount} at ${record.fields.vendor}`, expense: record.fields });
    } catch (err) { json({ error: 'Failed to log expense', details: err.message }, 500); }
    return true;
  }
  if (path === '/api/finance/spending' && method === 'GET') {
    try {
      const data = await airtable.getSpending();
      json(data);
    } catch (err) { json({ error: 'Failed to fetch spending', details: err.message }, 500); }
    return true;
  }

  // Weather
  if (path === '/api/weather' && method === 'GET') {
    json(await airtable.getWeather());
    return true;
  }

  // Briefing
  if (path === '/api/briefing' && method === 'GET') {
    try {
      const data = await airtable.getBriefing(google);
      json(data);
    } catch (err) { json({ error: 'Briefing failed', details: err.message }, 500); }
    return true;
  }

  // Google Calendar & Gmail
  if (path === '/api/calendar' && method === 'GET') {
    if (!google.isGoogleConfigured()) {
      json({ error: 'Google not configured', setup: 'Visit /api/google/auth to connect' });
      return true;
    }
    const days = parseInt(url.searchParams.get('days') || '1', 10);
    json(await google.getCalendarEvents(days));
    return true;
  }
  if (path === '/api/emails' && method === 'GET') {
    if (!google.isGoogleConfigured()) {
      json({ error: 'Google not configured' }); return true;
    }
    const maxResults = parseInt(url.searchParams.get('max') || '10', 10);
    const query = url.searchParams.get('q') || '';
    json(await google.getEmails({ maxResults, query }));
    return true;
  }
  if (path === '/api/emails/stats' && method === 'GET') {
    if (!google.isGoogleConfigured()) {
      json({ error: 'Google not configured' }); return true;
    }
    const stats = await google.getEmailStats();
    json(stats);
    return true;
  }
  if (path === '/api/google/auth' && method === 'GET') {
    const redirectUri = `https://${req.headers.host}/api/google/callback`;
    res.writeHead(302, { Location: google.getAuthUrl(redirectUri) });
    res.end();
    return true;
  }
  if (path === '/api/google/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    const redirectUri = `https://${req.headers.host}/api/google/callback`;
    try {
      const tokens = await google.exchangeCodeForTokens(code, redirectUri);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Google Connected</title></head><body><h1>Google Connected!</h1><p>Refresh token: <code>${tokens.refresh_token || '(not returned)'}</code></p><p>Add as GOOGLE_REFRESH_TOKEN in Railway and redeploy.</p></body></html>`);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>OAuth Error</h1><pre>${err.message}</pre>`);
    }
    return true;
  }

  // 404
  json({ error: 'Not found' }, 404);
  return true;
}

// --- Start HTTP server ---

export function startAPIServer() {
  const server = createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(botOnline ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: botOnline ? 'ok' : 'offline',
        lastActivity: new Date(lastActivity).toISOString(),
        idleMinutes: Math.floor((Date.now() - lastActivity) / 60000),
      }));
      return;
    }
    const handled = await handleAPIRequest(req, res);
    if (handled) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => {
    console.log(`[API] Health: http://localhost:${PORT}/health`);
    console.log(`[API] Endpoints: http://localhost:${PORT}/api/*`);
  });
}
