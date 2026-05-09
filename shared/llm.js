// Groq LLM wrapper with retry logic — shared across all channels
import { GROQ_KEY, GROQ_MODEL } from './config.js';

/**
 * Chat with Groq LLM.
 * @param {Array} history - Previous messages [{role, content}]
 * @param {string} userMessage - Current user message
 * @param {string} systemPrompt - System prompt to use
 * @param {object} options - Optional: { maxTokens, temperature }
 * @returns {string} Assistant reply
 */
export async function chatWithLLM(history, userMessage, systemPrompt, options = {}) {
  const { maxTokens = 1024, temperature = 0.7 } = options;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ];

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log(`Groq attempt ${attempt}/${maxRetries}: ${response.status} - ${errText.slice(0, 200)}`);
        if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
          continue;
        }
        throw new Error(`Groq API error: ${response.status}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.log(`Groq attempt ${attempt}/${maxRetries}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error('All retries exhausted');
}
