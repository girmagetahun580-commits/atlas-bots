// Atlas Unified Bot — Discord + Telegram in a single process
// Shared memory, shared Airtable, shared Groq, cross-channel awareness

import { startDiscordBot } from './discord/bot.js';
import { startTelegramBot } from './telegram/bot.js';
import { startAPIServer } from './discord/api-server.js';

console.log('═══════════════════════════════════════');
console.log('  🧭 Atlas — Unified Bot Starting');
console.log('═══════════════════════════════════════');

// Start the API/health server (used by ElevenLabs voice tools + health checks)
startAPIServer();

// Start both bots (each checks for its own token and skips if missing)
const discord = startDiscordBot();
const telegram = startTelegramBot();

if (!discord && !telegram) {
  console.error('No bot tokens configured. Set DISCORD_BOT_TOKEN and/or TELEGRAM_BOT_TOKEN.');
  process.exit(1);
}

console.log('═══════════════════════════════════════');
console.log('  Channels active:');
if (discord) console.log('    ✅ Discord (text + voice + voice notes)');
if (telegram) console.log('    ✅ Telegram (text + voice notes)');
console.log('  Shared: memory, Airtable, Google, Groq');
console.log('  Cross-channel sync: enabled');
console.log('═══════════════════════════════════════');
