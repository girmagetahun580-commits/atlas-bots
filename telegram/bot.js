// Telegram bot — full-featured with data middleware, shared memory, voice notes
import { Bot, InputFile } from 'grammy';
import {
  TELEGRAM_TOKEN, ALLOWED_TELEGRAM_USER, GROQ_MODEL,
  DEEPGRAM_KEY, ELEVENLABS_KEY, ELEVENLABS_VOICE,
} from '../shared/config.js';
import { chatWithLLM } from '../shared/llm.js';
import { getHistory, addMessage, clearHistory, getCrossChannelContext } from '../shared/memory.js';
import { detectIntent, fetchDataForIntents } from '../shared/data-middleware.js';
import {
  SYSTEM_PROMPT, TELEGRAM_MODE_SUFFIX, withDataContext,
} from '../shared/system-prompt.js';

// --- Security: only respond to Siket ---
function isAllowed(ctx) {
  return ctx.from?.id === ALLOWED_TELEGRAM_USER;
}

// --- Transcribe Telegram voice messages ---
async function transcribeVoice(fileUrl) {
  if (!DEEPGRAM_KEY) return null;
  try {
    const audioRes = await fetch(fileUrl);
    if (!audioRes.ok) throw new Error(`Download failed: ${audioRes.status}`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const response = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${DEEPGRAM_KEY}`,
          'Content-Type': 'audio/ogg',
        },
        body: audioBuffer,
      }
    );
    if (!response.ok) throw new Error(`Deepgram error: ${response.status}`);
    const result = await response.json();
    return result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  } catch (err) {
    console.error('[Telegram] Transcription failed:', err.message);
    return null;
  }
}

// --- Generate voice reply via ElevenLabs ---
async function generateVoiceReply(text) {
  if (!ELEVENLABS_KEY) return null;
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
          output_format: 'ogg_vorbis',
        }),
      }
    );
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

// --- Split long messages for Telegram's 4096 char limit ---
function splitMessage(text, maxLength = 4096) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1) splitIndex = maxLength;
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }
  return chunks;
}

// --- Start Telegram bot ---
export function startTelegramBot() {
  if (!TELEGRAM_TOKEN) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN — skipping Telegram bot.');
    return null;
  }

  const bot = new Bot(TELEGRAM_TOKEN);

  // Global error handler — prevents silent crashes
  bot.catch((err) => {
    console.error('[Telegram] Bot error:', err.error || err.message || err);
  });

  // /start command
  bot.command('start', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const memoryKey = `telegram-${ctx.chat.id}`;
    clearHistory(memoryKey);
    await ctx.reply("Hey Siket 👋 — Atlas here on Telegram. Full brain connected — I can see your tasks, habits, calendar, email, and finances. Ask me anything.\n\nType /clear to reset our conversation.");
  });

  // /clear command
  bot.command('clear', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const memoryKey = `telegram-${ctx.chat.id}`;
    clearHistory(memoryKey);
    await ctx.reply('Conversation cleared. Fresh start.');
  });

  // --- Handle text messages ---
  bot.on('message:text', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const userMessage = ctx.message.text;
    const chatId = ctx.chat.id;
    const memoryKey = `telegram-${chatId}`;
    const history = getHistory(memoryKey);

    await ctx.replyWithChatAction('typing');

    addMessage(memoryKey, 'user', userMessage);

    try {
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      // Detect intent and fetch live data from Airtable
      const { intents, extractedParams } = detectIntent(userMessage);
      let dataContext = '';
      if (intents.length > 0) {
        dataContext = await fetchDataForIntents(intents, extractedParams);
      }

      // Add cross-channel context (see what happened on Discord)
      const crossChannel = getCrossChannelContext(memoryKey);
      if (crossChannel) {
        dataContext = dataContext ? dataContext + '\n\n' + crossChannel : crossChannel;
      }

      const systemPrompt = withDataContext(SYSTEM_PROMPT + TELEGRAM_MODE_SUFFIX, dataContext);
      const reply = await chatWithLLM(history, userMessage, systemPrompt);

      clearInterval(typingInterval);

      addMessage(memoryKey, 'assistant', reply);

      if (reply.length <= 4096) {
        await ctx.reply(reply, { parse_mode: undefined });
      } else {
        const chunks = splitMessage(reply);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: undefined });
        }
      }
    } catch (error) {
      console.error('[Telegram] Error:', error.message);
      await ctx.reply('Hit an error. Try again in a sec.');
    }
  });

  // --- Handle voice messages ---
  bot.on('message:voice', async (ctx) => {
    if (!isAllowed(ctx)) return;
    const chatId = ctx.chat.id;
    const memoryKey = `telegram-${chatId}`;

    if (!DEEPGRAM_KEY) {
      await ctx.reply("Voice messages aren't set up yet. Type it out for now.");
      return;
    }

    await ctx.replyWithChatAction('typing');

    try {
      // Get file URL from Telegram
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

      const transcript = await transcribeVoice(fileUrl);
      if (!transcript || transcript.trim().length === 0) {
        await ctx.reply("I couldn't make out what you said. Try again or type it out.");
        return;
      }

      console.log(`[Telegram] Voice note transcribed: "${transcript}"`);
      await ctx.reply(`🎤 *"${transcript}"*`, { parse_mode: 'Markdown' });
      await ctx.replyWithChatAction('typing');

      const history = getHistory(memoryKey);
      addMessage(memoryKey, 'user', transcript);

      // Detect intent and fetch live data
      const { intents, extractedParams } = detectIntent(transcript);
      let dataContext = '';
      if (intents.length > 0) {
        dataContext = await fetchDataForIntents(intents, extractedParams);
      }

      const crossChannel = getCrossChannelContext(memoryKey);
      if (crossChannel) {
        dataContext = dataContext ? dataContext + '\n\n' + crossChannel : crossChannel;
      }

      const systemPrompt = withDataContext(SYSTEM_PROMPT + TELEGRAM_MODE_SUFFIX, dataContext);
      const reply = await chatWithLLM(history, transcript, systemPrompt);
      addMessage(memoryKey, 'assistant', reply);

      // Reply with voice + text
      const voiceBuffer = await generateVoiceReply(reply);
      if (voiceBuffer) {
        await ctx.replyWithVoice(new InputFile(voiceBuffer, 'atlas-reply.ogg'));
      }

      // Also send text
      if (reply.length <= 4096) {
        await ctx.reply(reply, { parse_mode: undefined });
      } else {
        const chunks = splitMessage(reply);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: undefined });
        }
      }
    } catch (err) {
      console.error('[Telegram] Voice error:', err.message);
      await ctx.reply('Hit an error processing your voice message. Try typing it out.');
    }
  });

  // Start the bot with error handling
  console.log('[Telegram] Starting...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`[Telegram] Online as @${botInfo.username}`);
      console.log(`[Telegram] LLM: Groq (${GROQ_MODEL})`);
      console.log(`[Telegram] Allowed user: ${ALLOWED_TELEGRAM_USER}`);
      console.log(`[Telegram] Features: text + voice notes + data middleware + cross-channel sync`);
    },
  }).catch((err) => {
    console.error('[Telegram] FATAL — bot.start() failed:', err.message || err);
    console.error('[Telegram] Check: is another process polling the same token? Is the token valid?');
  });

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());

  return bot;
}
