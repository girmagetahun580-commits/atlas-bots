// Discord bot — text messages, voice notes, voice channel
import { Client, GatewayIntentBits, Events, AttachmentBuilder } from 'discord.js';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus, entersState,
} from '@discordjs/voice';
import { Readable } from 'stream';
import {
  DISCORD_TOKEN, TEXT_CHANNEL_NAME, VOICE_CHANNEL_NAME,
  STATUS_CHANNEL_NAME, ELEVENLABS_KEY, ELEVENLABS_VOICE,
  DEEPGRAM_KEY, GROQ_MODEL,
} from '../shared/config.js';
import { chatWithLLM } from '../shared/llm.js';
import { getHistory, addMessage, getCrossChannelContext } from '../shared/memory.js';
import { detectIntent, fetchDataForIntents } from '../shared/data-middleware.js';
import {
  SYSTEM_PROMPT, TEXT_MODE_SUFFIX, VOICE_MODE_SUFFIX,
  VOICE_GREETING, withDataContext,
} from '../shared/system-prompt.js';
import { markOnline, markActivity } from './api-server.js';

const IS_VOICE_MESSAGE = 1 << 13;

// --- Generate TTS audio as Buffer (for voice note replies) ---

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
          output_format: 'mp3_44100_128',
        }),
      }
    );
    if (!response.ok) {
      console.log(`[Discord] ElevenLabs TTS failed: ${response.status}`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.log(`[Discord] Voice reply generation failed: ${err.message}`);
    return null;
  }
}

// --- Transcribe Discord voice messages (OGG/Opus) ---

async function transcribeVoiceNote(audioUrl) {
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error(`Failed to download voice note: ${audioRes.status}`);
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
  if (!response.ok) throw new Error(`Deepgram STT error: ${response.status}`);
  const result = await response.json();
  return result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

// --- TTS for voice channel ---

async function textToSpeech(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text, model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
        output_format: 'mp3_44100_128',
      }),
    }
  );
  if (!response.ok) throw new Error(`ElevenLabs TTS error: ${response.status}`);
  return Readable.fromWeb(response.body);
}

// --- STT for voice channel (raw PCM from Discord) ---

async function speechToText(audioBuffer) {
  const response = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_KEY}`,
        'Content-Type': 'audio/raw;encoding=signed-integer;bits=16;rate=48000;channels=1',
      },
      body: audioBuffer,
    }
  );
  if (!response.ok) throw new Error(`Deepgram STT error: ${response.status}`);
  const result = await response.json();
  return result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

async function playAudio(player, text) {
  const stream = await textToSpeech(text);
  const resource = createAudioResource(stream, { inputType: 2 });
  player.play(resource);
  return new Promise((resolve) => { player.once(AudioPlayerStatus.Idle, resolve); });
}

function listenToUser(connection, userId) {
  return new Promise((resolve) => {
    const chunks = [];
    const subscription = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });
    subscription.on('data', (chunk) => chunks.push(chunk));
    subscription.on('end', () => resolve(Buffer.concat(chunks)));
    setTimeout(() => { subscription.destroy(); resolve(Buffer.concat(chunks)); }, 30000);
  });
}

// --- Error logger ---

async function logError(discord, err) {
  try {
    const guild = discord.guilds.cache.first();
    if (!guild) return;
    const channel = guild.channels.cache.find(c => c.name === STATUS_CHANNEL_NAME);
    if (!channel) return;
    await channel.send(`⚠️ **Atlas Error** (${new Date().toISOString()})\n\`\`\`${String(err.message || err).slice(0, 1500)}\`\`\``);
  } catch { }
}

// --- Voice conversation loop ---

async function voiceConversationLoop(connection, userId, guildId, discord) {
  const player = createAudioPlayer();
  connection.subscribe(player);
  const memoryKey = `discord-voice-${guildId}`;
  const history = getHistory(memoryKey);
  await playAudio(player, VOICE_GREETING);
  console.log('[Discord] Voice loop started.');

  while (connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      const audioBuffer = await listenToUser(connection, userId);
      if (audioBuffer.length < 4800) continue;
      const transcript = await speechToText(audioBuffer);
      if (!transcript || transcript.trim().length === 0) continue;
      console.log(`[Discord Voice] User: "${transcript}"`);
      markActivity();

      if (['bye atlas', 'goodbye atlas', 'leave', 'disconnect'].includes(transcript.toLowerCase().trim())) {
        await playAudio(player, 'Talk to you later. Bye!');
        connection.destroy();
        return;
      }

      const { intents, extractedParams } = detectIntent(transcript);
      let dataContext = '';
      if (intents.length > 0) {
        dataContext = await fetchDataForIntents(intents, extractedParams);
      }

      const voicePrompt = withDataContext(SYSTEM_PROMPT + VOICE_MODE_SUFFIX, dataContext);
      const reply = await chatWithLLM(history, transcript, voicePrompt);
      addMessage(memoryKey, 'user', transcript);
      addMessage(memoryKey, 'assistant', reply);
      console.log(`[Discord Voice] Atlas: "${reply}"`);
      await playAudio(player, reply);
    } catch (err) {
      console.error('[Discord Voice] Error:', err.message || err);
      logError(discord, err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// --- Start Discord bot ---

export function startDiscordBot() {
  if (!DISCORD_TOKEN) {
    console.log('[Discord] No DISCORD_BOT_TOKEN — skipping Discord bot.');
    return null;
  }

  const discord = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
    ],
  });

  // --- Text message handler ---
  discord.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.channel.name !== TEXT_CHANNEL_NAME) return;
    markActivity();
    const memoryKey = `discord-text-${message.channel.id}`;
    const history = getHistory(memoryKey);

    try {
      await message.channel.sendTyping();

      let userText = message.content || '';
      let isVoiceNote = false;

      // Check for Discord voice message
      const isVoiceMsg = (message.flags?.bitfield & IS_VOICE_MESSAGE) !== 0;
      const audioAttachment = message.attachments?.find(a =>
        a.contentType?.startsWith('audio/') ||
        a.url?.endsWith('.ogg') ||
        a.name?.endsWith('.ogg')
      );

      if (isVoiceMsg && audioAttachment) {
        isVoiceNote = true;
        console.log(`[Discord] Voice note from ${message.author.username} (${audioAttachment.size} bytes)`);

        if (!DEEPGRAM_KEY) {
          await message.reply("I can't process voice notes yet — Deepgram API key isn't configured.");
          return;
        }

        const transcript = await transcribeVoiceNote(audioAttachment.url);
        if (!transcript || transcript.trim().length === 0) {
          await message.reply("I couldn't make out what you said. Could you try again or type it out?");
          return;
        }

        userText = transcript;
        console.log(`[Discord] Transcribed: "${transcript}"`);
        await message.reply(`🎤 *"${transcript}"*`);
        await message.channel.sendTyping();
      }

      if (!userText.trim()) return;

      // Detect intent and fetch live data
      const { intents, extractedParams } = detectIntent(userText);
      let dataContext = '';
      if (intents.length > 0) {
        dataContext = await fetchDataForIntents(intents, extractedParams);
      }

      // Add cross-channel context
      const crossChannel = getCrossChannelContext(memoryKey);
      if (crossChannel) {
        dataContext = dataContext ? dataContext + '\n\n' + crossChannel : crossChannel;
      }

      const systemPrompt = withDataContext(SYSTEM_PROMPT + TEXT_MODE_SUFFIX, dataContext);
      const reply = await chatWithLLM(history, userText, systemPrompt);
      addMessage(memoryKey, 'user', userText);
      addMessage(memoryKey, 'assistant', reply);

      // If voice note, reply with voice + text
      if (isVoiceNote && ELEVENLABS_KEY) {
        const audioBuffer = await generateVoiceReply(reply);
        if (audioBuffer) {
          const attachment = new AttachmentBuilder(audioBuffer, { name: 'atlas-reply.mp3' });
          const textContent = reply.length > 1900 ? reply.slice(0, 1900) + '…' : reply;
          await message.reply({ content: textContent, files: [attachment] });
        } else {
          await message.reply(reply);
        }
      } else if (reply.length > 2000) {
        const chunks = reply.match(/[\s\S]{1,1990}/g);
        for (const chunk of chunks) await message.reply(chunk);
      } else {
        await message.reply(reply);
      }
    } catch (err) {
      console.error('[Discord] Text error:', err.message || err);
      await message.reply('Sorry, I hit an error. Try again in a moment.');
      logError(discord, err);
    }
  });

  // --- Voice channel handler ---
  discord.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    if (newState.channel?.name === VOICE_CHANNEL_NAME && !newState.member.user.bot && oldState.channel?.name !== VOICE_CHANNEL_NAME) {
      console.log(`[Discord] ${newState.member.displayName} joined ${VOICE_CHANNEL_NAME}. Connecting...`);
      try {
        const connection = joinVoiceChannel({
          channelId: newState.channel.id,
          guildId: newState.guild.id,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfDeaf: false,
        });
        connection.on('stateChange', (oldS, newS) => console.log(`[Discord Voice] ${oldS.status} > ${newS.status}`));
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          try {
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
          } catch { connection.destroy(); }
        });
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        console.log('[Discord] Connected to voice channel.');
        voiceConversationLoop(connection, newState.member.id, newState.guild.id, discord);
      } catch (err) {
        console.error('[Discord] Failed to join voice:', err.message);
        logError(discord, err);
      }
    }
  });

  // --- Ready handler ---
  discord.once(Events.ClientReady, async (client) => {
    console.log(`[Discord] Online as ${client.user.tag}`);
    console.log(`[Discord] LLM: Groq (${GROQ_MODEL})`);
    console.log(`[Discord] Text: #${TEXT_CHANNEL_NAME} | Voice: ${VOICE_CHANNEL_NAME}`);
    markOnline();

    try {
      const guild = client.guilds.cache.first();
      if (guild) {
        const statusCh = guild.channels.cache.find(c => c.name === STATUS_CHANNEL_NAME);
        if (statusCh) await statusCh.send(`✅ **Atlas is online** (${new Date().toISOString()})\nLLM: Groq ${GROQ_MODEL}\nChannels: Discord + Telegram (unified)\nData: Airtable + Google`);
      }
    } catch { }
  });

  discord.login(DISCORD_TOKEN);
  return discord;
}
