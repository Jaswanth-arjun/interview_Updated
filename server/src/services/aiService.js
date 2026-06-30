// ─── AI Pipeline & Model Router Service ──────────────────────
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const meterService = require('./meterService');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

// Round-Robin Tracking for Gemini keys
let geminiKeyIndex = 0;
function getNextGeminiKey() {
  const keys = config.ai.geminiKeys;
  if (!keys || keys.length === 0) return null;
  const key = keys[geminiKeyIndex];
  geminiKeyIndex = (geminiKeyIndex + 1) % keys.length;
  return { key, index: geminiKeyIndex };
}

// ─── Resilient Fetch helper ──────────────────────────────────
async function fetchWithRetry(url, options = {}, { retries = 2, timeoutMs = 15000, retryDelayMs = 1000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      const isLastAttempt = attempt === retries;
      const isNetworkError = err.name === 'AbortError' || err.message?.includes('fetch failed') || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (isLastAttempt || !isNetworkError) throw err;
      logger.warn(`⟳ Network error on attempt ${attempt + 1}/${retries + 1}, retrying in ${retryDelayMs}ms...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
}

// ─── Transcription Cleaner (from main.js) ─────────────────────
function cleanTranscriptionText(text) {
  if (!text) return '';
  const lower = text.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
  const hallucinations = [
    "thank you",
    "thank you thank you",
    "thank you very much",
    "thank you for watching",
    "subtitles by yify",
    "please subscribe",
    "subscribe to my channel",
    "reformatted by",
    "you"
  ];
  if (hallucinations.includes(lower)) {
    return '';
  }

  let cleaned = text.replace(/\b(\w+)(?:\s+\1)+\b/gi, '$1');
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  const deduplicatedSentences = [];
  let lastSentence = "";
  let repeatCount = 0;
  for (const sentence of sentences) {
    const norm = sentence.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const normLast = lastSentence.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    if (norm === normLast) {
      repeatCount++;
      if (repeatCount < 1) {
        deduplicatedSentences.push(sentence);
      }
    } else {
      deduplicatedSentences.push(sentence);
      lastSentence = sentence;
      repeatCount = 0;
    }
  }
  cleaned = deduplicatedSentences.join(' ').trim();
  
  let cleanText = cleaned.trim();
  let prev;
  do {
    prev = cleanText;
    cleanText = cleanText.replace(/^(thank you|thanks|you|please subscribe|subscribe|thank you very much|reformatted by|subtitles by yify)[.,\s!?]*/gi, '');
  } while (cleanText !== prev);

  cleaned = cleanText.trim();
  const words = cleaned.toLowerCase().split(/\s+/);
  const uniqueWords = new Set(words);
  if (words.length > 5 && uniqueWords.size === 1) {
    return '';
  }
  if (words.length > 5 && uniqueWords.size === 2 && (uniqueWords.has('thank') || uniqueWords.has('you') || uniqueWords.has('thanks'))) {
    return '';
  }

  return cleaned;
}

// Helper to construct Whisper form data payload
function buildAudioFormData(base64Audio, mimeType, modelName) {
  const buffer = Buffer.from(base64Audio, 'base64');
  let ext = 'webm';
  if (mimeType && mimeType.includes('wav')) ext = 'wav';
  else if (mimeType && mimeType.includes('mp3')) ext = 'mp3';
  else if (mimeType && mimeType.includes('m4a')) ext = 'm4a';

  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
  formData.append('file', blob, `audio.${ext}`);
  formData.append('model', modelName);
  return formData;
}

/**
 * Transcribe base64 audio with resilient failovers
 */
async function transcribeAudio(userId, base64Audio, mimeType, isTrial, isSlow = true) {
  const start = Date.now();
  const errors = [];

  // Estimate duration from base64 size (roughly 1 sec of standard webm is ~16KB)
  const sizeBytes = Buffer.from(base64Audio, 'base64').length;
  const audioDurationMs = Math.round((sizeBytes / 16000) * 1000);

  // 1. Paid / Fast path: Groq Whisper first, fallback to OmniRoute, fallback to Gemini
  if (!isSlow) {
    // Groq Whisper
    if (config.ai.groqKey) {
      try {
        logger.info(`⚡ Fast path: Transcribing via Groq Whisper...`);
        const response = await fetchWithRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.ai.groqKey}` },
          body: buildAudioFormData(base64Audio, mimeType, 'whisper-large-v3')
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.text?.trim();
          const cleaned = cleanTranscriptionText(text);
          const latencyMs = Date.now() - start;

          await meterService.logAndMeterUsage(userId, {
            requestType: 'transcribe',
            provider: 'groq',
            model: 'whisper-large-v3',
            audioDurationMs,
            costPaise: config.pricing.transcribe,
            latencyMs,
            success: true,
            question: cleaned,
            isTrial
          });

          return { success: true, text: cleaned };
        }
        errors.push(`Groq Whisper HTTP ${response.status}`);
      } catch (e) {
        logger.warn(`Groq Whisper failed: ${e.message}`);
        errors.push(`Groq Whisper: ${e.message}`);
      }
    }

    // OmniRoute Whisper Fallback
    if (config.ai.omniRoute.apiKey) {
      try {
        logger.info(`⚡ Fast path fallback: Transcribing via OmniRoute...`);
        const response = await fetchWithRetry(`${config.ai.omniRoute.baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.ai.omniRoute.apiKey}` },
          body: buildAudioFormData(base64Audio, mimeType, 'whisper-1')
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.text?.trim();
          const cleaned = cleanTranscriptionText(text);
          const latencyMs = Date.now() - start;

          await meterService.logAndMeterUsage(userId, {
            requestType: 'transcribe',
            provider: 'omniroute',
            model: 'whisper-1',
            audioDurationMs,
            costPaise: config.pricing.transcribe,
            latencyMs,
            success: true,
            question: cleaned,
            isTrial
          });

          return { success: true, text: cleaned };
        }
        errors.push(`OmniRoute Whisper HTTP ${response.status}`);
      } catch (e) {
        logger.warn(`OmniRoute Whisper failed: ${e.message}`);
        errors.push(`OmniRoute: ${e.message}`);
      }
    }
  }

  // 2. Slow path / Demo path / Last fallback: Gemini transcription
  if (config.ai.geminiKeys.length > 0) {
    const keysCount = config.ai.geminiKeys.length;
    for (let i = 0; i < keysCount; i++) {
      const activeKey = getNextGeminiKey();
      if (!activeKey) continue;
      try {
        logger.info(`Transcribing via Gemini key index #${activeKey.index}...`);
        const genAI = new GoogleGenerativeAI(activeKey.key);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent([
          { text: 'Transcribe the following audio exactly as spoken. Return ONLY the transcription text, nothing else.' },
          { inlineData: { mimeType: mimeType || 'audio/webm', data: base64Audio } }
        ]);

        const text = result.response.text().trim();
        const cleaned = cleanTranscriptionText(text);
        const latencyMs = Date.now() - start;

        await meterService.logAndMeterUsage(userId, {
          requestType: 'transcribe',
          provider: 'gemini',
          model: 'gemini-2.0-flash',
          audioDurationMs,
          costPaise: config.pricing.transcribe,
          latencyMs,
          success: true,
          question: cleaned,
          isTrial
        });

        return { success: true, text: cleaned };
      } catch (e) {
        logger.warn(`Gemini Transcription Key #${activeKey.index} failed: ${e.message}`);
        errors.push(`Gemini #${activeKey.index}: ${e.message}`);
      }
    }
  }

  // 3. Fallback transcription if everything failed and we are in slow/demo mode
  if (isSlow) {
    if (config.ai.groqKey) {
      try {
        logger.info(`Slow path fallback: Transcribing via Groq Whisper...`);
        const response = await fetchWithRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.ai.groqKey}` },
          body: buildAudioFormData(base64Audio, mimeType, 'whisper-large-v3')
        });

        if (response.ok) {
          const data = await response.json();
          const text = data.text?.trim();
          const cleaned = cleanTranscriptionText(text);
          const latencyMs = Date.now() - start;

          await meterService.logAndMeterUsage(userId, {
            requestType: 'transcribe',
            provider: 'groq',
            model: 'whisper-large-v3',
            audioDurationMs,
            costPaise: config.pricing.transcribe,
            latencyMs,
            success: true,
            question: cleaned,
            isTrial
          });

          return { success: true, text: cleaned };
        }
      } catch (e) {
        errors.push(`Fallback Groq: ${e.message}`);
      }
    }
  }

  // Record failure to DB
  await meterService.logAndMeterUsage(userId, {
    requestType: 'transcribe',
    provider: 'failed',
    model: 'none',
    audioDurationMs,
    costPaise: 0,
    latencyMs: Date.now() - start,
    success: false,
    errorMessage: errors.join('; '),
    isTrial
  });

  throw new AppError(`All transcription providers failed: ${errors.join(', ')}`, 502);
}

// Helper to construct prompt template
function buildInterviewPrompt(question, d) {
  return `You are a candidate in a live interview. Answer: "${question}"

RULES:
- SUBJECT/TECHNICAL questions: explain the concept directly using your knowledge. Do NOT reference your resume or projects unless asked about your experience.
- RESUME/PROJECT questions: answer using ONLY facts from the candidate context below. Never invent details.
- Speak first person, natural, conversational. 3-5 sentences max.
- NO bullet points, NO markdown, NO lists, NO filler like "Sure" or "Certainly".
- Start answering immediately as the candidate.

─── CONTEXT ───
Role: ${d.roleName || 'N/A'} at ${d.companyName || 'N/A'}
JD: ${d.jobDescription || 'N/A'}
Resume: ${d.resumeText || 'N/A'}
Projects: ${d.projects || 'N/A'}
Notes: ${d.extraNotes || 'N/A'}
───────────────
Answer now:`;
}

/**
 * Generate AI suggested answer and stream chunks using Server-Sent Events (SSE).
 */
async function generateAnswerStream(userId, question, profileData, res, isTrial, isSlow = true) {
  const start = Date.now();
  const prompt = buildInterviewPrompt(question, profileData);
  const errors = [];

  // Setup SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullAnswerText = '';
  let providerUsed = '';
  let modelUsed = '';
  let costPaise = 0;

  // Helper to send message events to Client
  const sendChunk = (text) => {
    fullAnswerText += text;
    res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  };

  // 1. Paid / Fast path generation: Groq (Llama) -> OmniRoute -> Gemini
  if (!isSlow) {
    // Try Groq Llama 3.3
    if (config.ai.groqKey) {
      try {
        logger.info(`⚡ Fast path: Generating answer via Groq Llama 3.3...`);
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.ai.groqKey}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            stream: true
          })
        });

        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const cleanLine = line.trim();
              if (cleanLine.startsWith('data: ')) {
                if (cleanLine.includes('[DONE]')) continue;
                try {
                  const parsed = JSON.parse(cleanLine.slice(6));
                  const text = parsed.choices[0]?.delta?.content || '';
                  if (text) sendChunk(text);
                } catch {}
              }
            }
          }

          providerUsed = 'groq';
          modelUsed = 'llama-3.3-70b-versatile';
          costPaise = config.pricing.generateGroq;
        } else {
          errors.push(`Groq Llama HTTP ${response.status}`);
        }
      } catch (e) {
        logger.warn(`Groq generation failed: ${e.message}`);
        errors.push(`Groq: ${e.message}`);
      }
    }

    // Try OmniRoute fallback
    if (!providerUsed && config.ai.omniRoute.apiKey) {
      try {
        logger.info(`⚡ Fast path fallback: Generating answer via OmniRoute...`);
        const response = await fetch(`${config.ai.omniRoute.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.ai.omniRoute.apiKey}`
          },
          body: JSON.stringify({
            model: config.ai.omniRoute.model,
            messages: [{ role: 'user', content: prompt }],
            stream: true
          })
        });

        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const cleanLine = line.trim();
              if (cleanLine.startsWith('data: ')) {
                if (cleanLine.includes('[DONE]')) continue;
                try {
                  const parsed = JSON.parse(cleanLine.slice(6));
                  const text = parsed.choices[0]?.delta?.content || '';
                  if (text) sendChunk(text);
                } catch {}
              }
            }
          }

          providerUsed = 'omniroute';
          modelUsed = config.ai.omniRoute.model;
          costPaise = config.pricing.generateGroq;
        } else {
          errors.push(`OmniRoute HTTP ${response.status}`);
        }
      } catch (e) {
        logger.warn(`OmniRoute generation failed: ${e.message}`);
        errors.push(`OmniRoute: ${e.message}`);
      }
    }
  }

  // 2. Slow / Demo / Gemini execution
  if (!providerUsed && config.ai.geminiKeys.length > 0) {
    const keysCount = config.ai.geminiKeys.length;
    for (let i = 0; i < keysCount; i++) {
      const activeKey = getNextGeminiKey();
      if (!activeKey) continue;
      try {
        // Enforce 2-second artificial latency for slow-speed demo / trial tiers
        if (isSlow) {
          logger.info(`Applying 2-second delay for slow tier answer generation...`);
          await new Promise(r => setTimeout(r, 2000));
        }

        logger.info(`Generating answer via Gemini key #${activeKey.index}...`);
        const genAI = new GoogleGenerativeAI(activeKey.key);
        // Use gemini-2.0-flash-lite if available, fallback to flash
        const modelName = isSlow ? 'gemini-2.0-flash-lite' : 'gemini-2.0-flash';
        const model = genAI.getGenerativeModel({ model: modelName });
        const resultStream = await model.generateContentStream(prompt);

        for await (const chunk of resultStream.stream) {
          const text = chunk.text();
          if (text) sendChunk(text);
        }

        providerUsed = 'gemini';
        modelUsed = modelName;
        costPaise = config.pricing.generateGemini;
        break;
      } catch (e) {
        logger.warn(`Gemini Generation Key #${activeKey.index} failed: ${e.message}`);
        errors.push(`Gemini #${activeKey.index}: ${e.message}`);
      }
    }
  }

  // 3. Fallback generation if slow path failed
  if (!providerUsed && isSlow) {
    if (config.ai.groqKey) {
      try {
        logger.info(`Slow path fallback: Generating via Groq...`);
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.ai.groqKey}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            stream: true
          })
        });

        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              const cleanLine = line.trim();
              if (cleanLine.startsWith('data: ')) {
                if (cleanLine.includes('[DONE]')) continue;
                try {
                  const parsed = JSON.parse(cleanLine.slice(6));
                  const text = parsed.choices[0]?.delta?.content || '';
                  if (text) sendChunk(text);
                } catch {}
              }
            }
          }

          providerUsed = 'groq';
          modelUsed = 'llama-3.3-70b-versatile';
          costPaise = config.pricing.generateGroq;
        }
      } catch (e) {
        errors.push(`Fallback Groq generation failed: ${e.message}`);
      }
    }
  }

  // Finish streaming
  const latencyMs = Date.now() - start;

  if (providerUsed) {
    // Log success
    // Simple token estimation: 1 word ~ 1.33 tokens
    const promptTokens = Math.round(prompt.split(/\s+/).length * 1.33);
    const completionTokens = Math.round(fullAnswerText.split(/\s+/).length * 1.33);

    await meterService.logAndMeterUsage(userId, {
      requestType: 'generate',
      provider: providerUsed,
      model: modelUsed,
      promptTokens,
      completionTokens,
      costPaise,
      latencyMs,
      success: true,
      question,
      isTrial
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } else {
    // Log failure
    await meterService.logAndMeterUsage(userId, {
      requestType: 'generate',
      provider: 'failed',
      model: 'none',
      costPaise: 0,
      latencyMs,
      success: false,
      errorMessage: errors.join('; '),
      question,
      isTrial
    });

    res.write(`data: ${JSON.stringify({ error: `AI generation failed: ${errors.join(', ')}` })}\n\n`);
    res.end();
  }
}

module.exports = {
  transcribeAudio,
  generateAnswerStream
};
