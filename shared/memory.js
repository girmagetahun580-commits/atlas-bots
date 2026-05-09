// Persistent conversation memory — shared across Discord and Telegram
// Saves to disk (survives restarts within same deploy)
// Channel keys: "discord-text-{id}", "discord-voice-{id}", "telegram-{id}"
import { readFileSync, writeFileSync, existsSync } from 'fs';

const MEMORY_FILE = './conversation-history.json';
const MAX_HISTORY = 40; // per channel

let store = {};

// Load from disk on startup
try {
  if (existsSync(MEMORY_FILE)) {
    store = JSON.parse(readFileSync(MEMORY_FILE, 'utf-8'));
    console.log(`[Memory] Loaded ${Object.keys(store).length} conversation(s) from disk.`);
  }
} catch (err) {
  console.error('[Memory] Failed to load, starting fresh:', err.message);
  store = {};
}

// Debounced save to disk
let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
      console.error('[Memory] Failed to save:', err.message);
    }
  }, 2000);
}

export function getHistory(channelId) {
  if (!store[channelId]) store[channelId] = [];
  return store[channelId];
}

export function addMessage(channelId, role, content) {
  if (!store[channelId]) store[channelId] = [];
  store[channelId].push({ role, content, timestamp: Date.now() });
  if (store[channelId].length > MAX_HISTORY) {
    store[channelId].splice(0, store[channelId].length - MAX_HISTORY);
  }
  scheduleSave();
}

export function clearHistory(channelId) {
  store[channelId] = [];
  scheduleSave();
}

/**
 * Get recent messages across ALL channels (for cross-channel awareness).
 * Returns the last N messages from other channels, sorted by time.
 */
export function getCrossChannelContext(excludeChannel, maxMessages = 5) {
  const allMessages = [];
  for (const [channelId, messages] of Object.entries(store)) {
    if (channelId === excludeChannel) continue;
    const channelType = channelId.startsWith('telegram') ? 'Telegram'
      : channelId.startsWith('discord-voice') ? 'Discord Voice'
      : 'Discord Text';
    for (const msg of messages.slice(-3)) { // last 3 per channel
      allMessages.push({
        channel: channelType,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || 0,
      });
    }
  }
  // Sort by time, return most recent
  allMessages.sort((a, b) => b.timestamp - a.timestamp);
  const recent = allMessages.slice(0, maxMessages);
  if (recent.length === 0) return '';

  const lines = recent.map(m =>
    `[${m.channel}] ${m.role}: ${m.content.slice(0, 150)}${m.content.length > 150 ? '...' : ''}`
  );
  return `--- RECENT CROSS-CHANNEL CONTEXT ---\n${lines.join('\n')}\n--- END CROSS-CHANNEL CONTEXT ---`;
}
