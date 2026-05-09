// Centralized configuration — all env vars in one place
import 'dotenv/config';

// --- Discord ---
export const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const VOICE_CHANNEL_NAME = process.env.VOICE_CHANNEL_NAME || 'Atlas Voice';
export const TEXT_CHANNEL_NAME = process.env.TEXT_CHANNEL_NAME || 'atlas';
export const STATUS_CHANNEL_NAME = process.env.STATUS_CHANNEL_NAME || 'bot-status';

// --- Telegram ---
export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const ALLOWED_TELEGRAM_USER = Number(process.env.ALLOWED_USER_ID || '7488685695');

// --- LLM (Groq) ---
export const GROQ_KEY = process.env.GROQ_API_KEY;
export const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// --- Voice (ElevenLabs + Deepgram) ---
export const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
export const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'Daniel';
export const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

// --- Airtable ---
export const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
export const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appinEEtxuzaHbI6J';

// --- API Server ---
export const API_SECRET_KEY = process.env.API_SECRET_KEY || 'atlas-default-key';
export const PORT = process.env.PORT || 3000;

// --- Google ---
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
