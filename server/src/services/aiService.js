// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ AI Pipeline & Model Router Service Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Resilient Fetch helper Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// ─── Provider Health Tracker ─────────────────────────────────────
// Automatically skips dead local proxies or invalid keys to prevent wasting 5-70s on failed retries
let groqDisabledUntil = 0;
let omniRouteDisabledUntil = 0;

function isGroqAvailable() {
  return !!config.ai.groqKey && Date.now() > groqDisabledUntil;
}

function isOmniRouteAvailable() {
  return !!config.ai.omniRoute.apiKey && Date.now() > omniRouteDisabledUntil;
}

function markGroqFailed(statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    logger.warn(`⚠️ Groq API key rejected (HTTP ${statusCode}). Temporarily bypassing Groq to route instantly to Gemini.`);
    groqDisabledUntil = Date.now() + 5 * 60 * 1000;
  }
}

function markOmniRouteFailed(isConnRefused = false) {
  if (isConnRefused) {
    logger.warn('⚠️ OmniRoute local proxy is offline. Temporarily bypassing OmniRoute to route instantly to Gemini.');
    omniRouteDisabledUntil = Date.now() + 24 * 60 * 60 * 1000;
  }
}

async function fetchWithRetry(url, options = {}, { retries = 1, timeoutMs = 6000, retryDelayMs = 400 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      const isRefused = err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED' || (err.message && err.message.includes('ECONNREFUSED'));
      if (isRefused) throw err;
      const isLastAttempt = attempt === retries;
      const isNetworkError = err.name === 'AbortError' || err.message?.includes('fetch failed') || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (isLastAttempt || !isNetworkError) throw err;
      logger.warn(`⟳ Network error on attempt ${attempt + 1}/${retries + 1}, retrying in ${retryDelayMs}ms...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Transcription Cleaner (from main.js) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Interviewers naturally start questions with "Okay, so...", "Right...",
// "Thank you. Now..." etc. These discourse markers must be removed for
// validation, but they must NEVER cause the actual question to be thrown away.
const DISCOURSE_PREFIX = /^(?:(?:okay|ok|alright|all\s+right|right|so|well|now|um+|uh+|er+|ah+|eh+|yeah|yep|yes|no|nope|oh|hmm+|mm+|and|but)\b[\s,.;:!?\-–—]*)+/i;
const COURTESY_PREFIX = /^(?:(?:thank\s+you(?:\s+(?:very\s+much|so\s+much|for\s+(?:that|your\s+time|watching)))?|thanks(?:\s+(?:a\s+lot|so\s+much|for\s+(?:that|your\s+time|watching)))?|great|good|nice|perfect|cool|awesome|excellent|sure|of\s+course)\b[\s,.;:!?\-–—]*)+/i;
const PREAMBLE_PREFIX = /^(?:(?:the\s+question\s+is|my\s+question\s+is|what\s+i\s+(?:just\s+)?(?:wanted|want)\s+to\s+(?:ask|know)\s+is)[\s,.;:!?\-–—]*)+/i;
const NOISE_TAG = /\[(?:blank_?audio|silence|music|applause|laughter|noise|inaudible|footsteps)[^\]]*\]|\((?:blank_?audio|silence|music|applause|laughter|noise|inaudible|upbeat[^)]*|dramatic[^)]*|soft[^)]*music[^)]*|background[^)]*)\)/gi;

function stripNoiseTags(text) {
  return String(text || '').replace(NOISE_TAG, ' ').replace(/\s+/g, ' ').trim();
}

function stripDiscoursePrefix(text) {
  let value = stripNoiseTags(text);
  for (let i = 0; i < 4; i++) {
    const next = value
      .replace(COURTESY_PREFIX, '')
      .replace(DISCOURSE_PREFIX, '')
      .replace(PREAMBLE_PREFIX, '')
      .replace(/^[\s,.;:!?\-–—]+/, '')
      .trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

function cleanTranscriptionText(text) {
  if (!text) return '';
  let cleaned = stripNoiseTags(text);
  if (!cleaned) return '';

  // Collapse immediate repeated words ("what what is" -> "what is").
  cleaned = cleaned.replace(/\b(\w+)(?:\s+\1\b){1,}/gi, '$1');

  // De-duplicate repeated sentences from Whisper loops.
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const deduplicatedSentences = [];
  let lastNormalized = '';
  for (const sentence of sentences) {
    const normalized = sentence.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    if (normalized && normalized === lastNormalized) continue;
    deduplicatedSentences.push(sentence.trim());
    lastNormalized = normalized;
  }
  cleaned = deduplicatedSentences.join(' ').trim();

  const core = cleaned.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!core) return '';

  // Only pure filler / sign-off hallucinations are dropped. A real question
  // that starts with "thank you" or "okay" is kept intact.
  const pureFiller = /^(?:okay|ok|alright|right|so|well|now|um+|uh+|yeah|yes|no|hi+|hello+|thanks?|thank you(?:\s+very\s+much)?|bye+|goodbye|see you|you|please subscribe|subscribe|subscribe to my channel|subtitles by yify|reformatted by)$/;
  if (pureFiller.test(core)) return '';

  const coreWords = core.split(' ');
  if (coreWords.length > 3 && new Set(coreWords).size === 1) return '';
  if (coreWords.length > 5 && new Set(coreWords).size === 2
    && (core.includes('thank') || core.includes('subscribe') || core.includes('watching'))) {
    return '';
  }

  return cleaned;
}

// Reject noise/hallucinations while accepting every normal interview prompt.
// The client applies the stricter "does this need an answer?" check; this
// server-side check only removes obvious junk so questions are never lost.
function isLikelyQuestion(text) {
  const value = stripDiscoursePrefix(cleanTranscriptionText(text));
  if (!value) return false;

  const words = value.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  if (words.length === 1) {
    const bareWord = words[0].replace(/[^a-z]/gi, '');
    return /\?$/.test(value) && /^(what|why|how|when|where|which|who|whom|whose)$/i.test(bareWord);
  }

  if (value.length < 6) return false;
  if (/^[\[(].*[\])]$/.test(value) && !value.includes('?')) return false;

  const foreignChars = (value.match(/[^a-zA-Z0-9 .,?!'"“”‘’\-–—:;()&/$%@#+\n]/g) || []).length;
  if (foreignChars / value.length > 0.06) return false;

  const unique = new Set(words.map((word) => word.toLowerCase().replace(/[^a-z0-9']/g, '')).filter(Boolean));
  if (words.length >= 6 && unique.size <= 2) return false;

  if (/^(?:thank(s| you)?|bye+|goodbye|see you|hello+|hi+)\b/i.test(value) && words.length <= 3) return false;

  return true;
}

function isReliableSpeechTranscription(data, { lenient = false } = {}) {
  const segments = Array.isArray(data.segments)
    ? data.segments.filter((segment) => String(segment.text || '').trim())
    : [];
  if (!segments.length) return true;
  const noSpeechProbability = Math.max(...segments.map((segment) => Number(segment.no_speech_prob) || 0));
  const averageLogProbability = Math.min(...segments.map((segment) =>
    Number.isFinite(Number(segment.avg_logprob)) ? Number(segment.avg_logprob) : 0
  ));
  const noSpeechLimit = lenient ? 0.9 : 0.8;
  const logProbLimit = lenient ? -1 : -0.8;
  return !(noSpeechProbability >= noSpeechLimit && averageLogProbability <= logProbLimit);
}

// Helper to construct Whisper form data payload
function buildAudioFormData(base64Audio, mimeType, modelName, isPartial = false) {
  const buffer = Buffer.from(base64Audio, 'base64');
  let ext = 'webm';
  if (mimeType && mimeType.includes('wav')) ext = 'wav';
  else if (mimeType && mimeType.includes('mp3')) ext = 'mp3';
  else if (mimeType && mimeType.includes('m4a')) ext = 'm4a';

  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
  formData.append('file', blob, `audio.${ext}`);
  formData.append('model', modelName);
  // Lock Whisper to English and reduce hallucinations on noise/silence —
  // without this, background sounds get "transcribed" as random foreign
  // languages (e.g. Icelandic "Hvað er það?").
  formData.append('language', 'en');
  formData.append('temperature', '0');
  // Live previews only need the text and are on the latency-critical path, so
  // skip the heavier verbose metadata there. Final decodes keep it for the
  // no_speech/logprob reliability check.
  formData.append('response_format', isPartial ? 'json' : 'verbose_json');
  formData.append('prompt', 'A live job interview in clear English. The interviewer asks technical and behavioural questions such as "Tell me about yourself", "What is your experience with React?".');
  return formData;
}

/**
 * Transcribe base64 audio with resilient failovers
 */
async function transcribeAudio(userId, base64Audio, mimeType, isTrial, isSlow = true, isPartial = false) {
  const start = Date.now();
  const errors = [];

  const audioBuffer = Buffer.from(base64Audio, 'base64');
  // Live previews are short and frequent; a generous timeout here is the main
  // reason results arrived late, so keep partial decodes tight.
  let audioDurationMs = Math.round((audioBuffer.length / 16000) * 1000);
  if (mimeType && mimeType.includes('wav') && audioBuffer.length >= 44) {
    const byteRate = audioBuffer.readUInt32LE(24);
    const dataBytes = audioBuffer.readUInt32LE(40);
    if (byteRate > 0) audioDurationMs = Math.round(dataBytes / byteRate * 1000);
  }

  // 1. Groq Whisper first (ultra-fast transcription for all tiers)
  if (isGroqAvailable()) {
    try {
      logger.info(`⚡ Transcribing via Groq Whisper...`);
      const response = await fetchWithRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.ai.groqKey}` },
        body: buildAudioFormData(base64Audio, mimeType, 'whisper-large-v3-turbo', isPartial)
      }, { retries: 0, timeoutMs: isPartial ? 2500 : 4500 });

      if (response.ok) {
        const data = await response.json();
        const text = data.text?.trim();
        const cleaned = cleanTranscriptionText(text);
        const latencyMs = Date.now() - start;

        if (!isPartial) {
          void meterService.logAndMeterUsage(userId, {
            requestType: 'transcribe',
            provider: 'groq',
            model: 'whisper-large-v3-turbo',
            audioDurationMs,
            costPaise: config.pricing.transcribe,
            latencyMs,
            success: true,
            question: cleaned,
            isTrial
          });
        }

        const reliable = isReliableSpeechTranscription(data, { lenient: isPartial });
        return { success: true, text: (reliable && (isPartial || isLikelyQuestion(cleaned))) ? cleaned : '' };
      }
      markGroqFailed(response.status);
      errors.push(`Groq Whisper HTTP ${response.status}`);
    } catch (e) {
      logger.warn(`Groq Whisper failed: ${e.message}`);
      errors.push(`Groq Whisper: ${e.message}`);
    }
  }

  // 2. OmniRoute Whisper Fallback
  if (isOmniRouteAvailable()) {
    try {
      logger.info(`⚡ Fallback: Transcribing via OmniRoute...`);
      const response = await fetchWithRetry(`${config.ai.omniRoute.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.ai.omniRoute.apiKey}` },
        body: buildAudioFormData(base64Audio, mimeType, 'whisper-1', isPartial)
      }, { retries: 0, timeoutMs: isPartial ? 2000 : 3500 });

      if (response.ok) {
        const data = await response.json();
        const text = data.text?.trim();
        const cleaned = cleanTranscriptionText(text);
        const latencyMs = Date.now() - start;

        if (!isPartial) {
          void meterService.logAndMeterUsage(userId, {
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
        }

        const reliable = isReliableSpeechTranscription(data, { lenient: isPartial });
        return { success: true, text: (reliable && (isPartial || isLikelyQuestion(cleaned))) ? cleaned : '' };
      }
      errors.push(`OmniRoute Whisper HTTP ${response.status}`);
    } catch (e) {
      markOmniRouteFailed(e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED' || (e.message && e.message.includes('fetch failed')));
      logger.warn(`OmniRoute Whisper failed: ${e.message}`);
      errors.push(`OmniRoute: ${e.message}`);
    }
  }

  // 3. Gemini transcription fallback
  if (config.ai.geminiKeys.length > 0) {
    const keysCount = config.ai.geminiKeys.length;
    for (let i = 0; i < keysCount; i++) {
      const activeKey = getNextGeminiKey();
      if (!activeKey) continue;
      try {
        logger.info(`Transcribing via Gemini key index #${activeKey.index}...`);
        const genAI = new GoogleGenerativeAI(activeKey.key);
        const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
        const result = await withTimeout(model.generateContent([
          { text: 'Transcribe the following audio exactly as spoken. Return ONLY the transcription text, nothing else.' },
          { inlineData: { mimeType: mimeType || 'audio/webm', data: base64Audio } }
        ]), isPartial ? 3000 : 6000, 'Gemini transcription timed out');

        const text = result.response.text().trim();
        const cleaned = cleanTranscriptionText(text);
        const latencyMs = Date.now() - start;

        if (!isPartial) {
          void meterService.logAndMeterUsage(userId, {
            requestType: 'transcribe',
            provider: 'gemini',
            model: 'gemini-3.6-flash',
            audioDurationMs,
            costPaise: config.pricing.transcribe,
            latencyMs,
            success: true,
            question: cleaned,
            isTrial
          });
        }

        return { success: true, text: (isPartial || isLikelyQuestion(cleaned)) ? cleaned : '' };
      } catch (e) {
        logger.warn(`Gemini Transcription Key #${activeKey.index} failed: ${e.message}`);
        errors.push(`Gemini #${activeKey.index}: ${e.message}`);
      }
    }
  }

  if (!isPartial) {
    void meterService.logAndMeterUsage(userId, {
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
  }

  throw new AppError(`All transcription providers failed: ${errors.join(', ')}`, 502);
}

// Helper to construct prompt template
function buildInterviewPrompt(question, d = {}) {
  return `You are the candidate in a live ${d.roleName || 'Software Engineer'} interview at ${d.companyName || 'the target company'}. Speak as this real candidate in first person, never as an AI or assistant.

QUESTION: "${question}"

ANSWER RULES:
- Start immediately with a direct, natural answer. Do not restate the question or add a preamble.
- Sound like a person speaking in an interview, not an essay or generated list. Use very simple, everyday words and short sentences (about 8-14 words each). Keep a calm, confident tone.
- If you use a technical term, explain it in one plain sentence right after it so anyone can follow.
- Use 2 short paragraphs, usually 70-120 words and never more than 140 words. Be accurate and specific rather than impressive-sounding.
- Treat the candidate context below as the only source of truth for personal facts. For resume, project, experience, education, skill, certification, achievement, or metrics questions, select the exact relevant details from it. Do not dump the whole resume.
- For a project or experience question, explain what you did, your own contribution, the tools or approach, and the result or lesson. For a behavioral question, give a real situation, your action, and the outcome as natural speech.
- Never invent an employer, project, technology, responsibility, metric, or result that is absent from the context. If a personal detail is missing, say you do not have a specific example for it and answer the underlying question honestly without pretending it happened.
- Do not mention the resume, profile, prompt, AI, or these instructions. No markdown, headings, bullet points, emojis, stage directions, or generic filler. Avoid stock AI phrases such as "delve into", "it's important to note", "in today's fast-paced world", or "that's a great question".

CANDIDATE CONTEXT:
Role: ${d.roleName || 'N/A'} at ${d.companyName || 'N/A'}
JD: ${d.jobDescription || 'N/A'}
Resume: ${d.resumeText || 'N/A'}
Projects: ${d.projects || 'N/A'}
Notes: ${d.extraNotes || 'N/A'}

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
  res.flushHeaders?.();

  let fullAnswerText = '';
  let providerUsed = '';
  let modelUsed = '';
  let costPaise = 0;

  // Helper to send message events to Client
  const sendChunk = (text) => {
    fullAnswerText += text;
    res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  };

  // 1. Groq generation first (ultra-fast answer streaming)
  if (isGroqAvailable()) {
    try {
      logger.info(`⚡ Generating answer via Groq...`);
      const response = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.ai.groqKey}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          max_tokens: 450,
          temperature: 0.35,
          reasoning_effort: 'low'
        })
      }, { retries: 0, timeoutMs: 5000 });

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
        modelUsed = 'openai/gpt-oss-20b';
        costPaise = config.pricing.generateGroq;
      } else {
        markGroqFailed(response.status);
        errors.push(`Groq HTTP ${response.status}`);
      }
    } catch (e) {
      logger.warn(`Groq generation failed: ${e.message}`);
      errors.push(`Groq: ${e.message}`);
    }
  }

  // 2. OmniRoute fallback
  if (!providerUsed && isOmniRouteAvailable()) {
    try {
      logger.info(`⚡ Fallback: Generating answer via OmniRoute...`);
      const response = await fetchWithRetry(`${config.ai.omniRoute.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.ai.omniRoute.apiKey}`
        },
        body: JSON.stringify({
          model: config.ai.omniRoute.model,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          max_tokens: 600
        })
      }, { retries: 0, timeoutMs: 4000 });

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
      markOmniRouteFailed(e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED' || (e.message && e.message.includes('fetch failed')));
      logger.warn(`OmniRoute generation failed: ${e.message}`);
      errors.push(`OmniRoute: ${e.message}`);
    }
  }

  // 3. Gemini execution fallback
  if (!providerUsed && config.ai.geminiKeys.length > 0) {
    const keysCount = config.ai.geminiKeys.length;
    for (let i = 0; i < keysCount; i++) {
      const activeKey = getNextGeminiKey();
      if (!activeKey) continue;
      try {
        logger.info(`Generating answer via Gemini key #${activeKey.index}...`);
        const genAI = new GoogleGenerativeAI(activeKey.key);
        const modelName = 'gemini-3.6-flash';
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            maxOutputTokens: 600,
            temperature: 0.65,
          }
        });
        const resultStream = await withTimeout(model.generateContentStream(prompt), 6000, 'Gemini response timed out');

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

  // Finish streaming
  const latencyMs = Date.now() - start;

  if (providerUsed) {
    const promptTokens = Math.round(prompt.split(/\s+/).length * 1.33);
    const completionTokens = Math.round(fullAnswerText.split(/\s+/).length * 1.33);

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    void meterService.logAndMeterUsage(userId, {
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
  } else {
    res.write(`data: ${JSON.stringify({ error: `AI generation failed: ${errors.join(', ')}` })}\n\n`);
    res.end();
    void meterService.logAndMeterUsage(userId, {
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
  }
}

module.exports = {
  cleanTranscriptionText,
  isLikelyQuestion,
  transcribeAudio,
  generateAnswerStream,
  generateChatStream
};

// ─── RAG Chat Assistant ──────────────────────────────────────────

const APP_KNOWLEDGE = `The Interview Copilot app lets candidates practice live interviews:
- It listens to system audio, transcribes the interviewer's question and streams a spoken-style answer grounded in the candidate's saved profile (resume, job description, projects, notes).
- Profile is configured in the Setup window (resume PDF, JD, projects, extra notes).
- The Overlay (Ctrl+Shift+A) shows questions/answers during practice; the Chat Assistant (Ctrl+Shift+C) answers app/profile/LinkedIn questions.
- Recharge & usage is wallet-based (Razorpay). Free trial users get a limited number of requests.`;

function buildChatPrompt(question, { history = [], profileData = {}, linkedinContext = null } = {}) {
  const historyText = (history || [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const profileText = profileData && (profileData.resumeText || profileData.jobDescription)
    ? `Role: ${profileData.roleName || 'N/A'} at ${profileData.companyName || 'N/A'}
JD: ${profileData.jobDescription || 'N/A'}
Resume: ${profileData.resumeText || 'N/A'}
Projects: ${profileData.projects || 'N/A'}
Notes: ${profileData.extraNotes || 'N/A'}`
    : 'No profile saved yet.';

  const linkedinText = linkedinContext
    ? JSON.stringify(linkedinContext, null, 1)
    : 'No LinkedIn data available for this question.';

  return `You are "Copilot Assistant", the built-in RAG assistant of the Interview Copilot desktop app.

ABOUT THE APP (for app-related questions):
${APP_KNOWLEDGE}

RULES (very important):
- Answer the user's question helpfully and concisely. Use natural, conversational language.
- Ground EVERY factual claim in the context below. NEVER invent people, companies, messages, campaigns, dates or any data that is not explicitly in the context.
- For LinkedIn network questions, reason over the LINKEDIN DATA: to find people at a company use the connections list (check their headline/title for the company); to find who replied to your messages, match message thread participants against those people AND check "lastMessageFromMe" — false means the other person sent the last message (i.e. they replied), true means you sent the last message.
- If the LINKEDIN DATA is empty, has empty connections/messages arrays, or contains a "dataQualityNote", do NOT claim the user has 0 connections or 0 replies as a fact — instead say you could not complete the LinkedIn check right now and suggest clicking "LinkedIn" in the chat top bar to reconnect, or checking LinkedIn manually.
- If LINKEDIN DATA does contain the answer, state it plainly with the names you found.
- App/profile questions: use ABOUT THE APP and CANDIDATE PROFILE.
- Small markdown formatting (bold, short bullet lists) is allowed.

CONVERSATION HISTORY:
${historyText || '(new conversation)'}

CANDIDATE PROFILE:
${profileText}

LINKEDIN DATA (scraped live from the user's own LinkedIn account just now):
${linkedinText}

USER QUESTION: ${question}

Answer:`;
}

/**
 * Consume an OpenAI-compatible SSE stream, calling sendChunk per token.
 */
async function consumeOpenAIStream(response, sendChunk) {
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
      if (!cleanLine.startsWith('data: ') || cleanLine.includes('[DONE]')) continue;
      try {
        const parsed = JSON.parse(cleanLine.slice(6));
        const text = parsed.choices[0]?.delta?.content || '';
        if (text) sendChunk(text);
      } catch {}
    }
  }
}

/**
 * RAG Chat: answers app / profile / LinkedIn-network questions.
 * Streams the answer to the client via Server-Sent Events (SSE).
 */
async function generateChatStream(userId, question, context, res, isTrial, isSlow = true) {
  const start = Date.now();
  const prompt = buildChatPrompt(question, context || {});
  const errors = [];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let fullAnswerText = '';
  let providerUsed = '';
  let modelUsed = '';

  const sendChunk = (text) => {
    fullAnswerText += text;
    res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  };

  const messages = [{ role: 'user', content: prompt }];

  // 1. Groq (fast)
  if (isGroqAvailable()) {
    try {
      const model = isSlow ? 'openai/gpt-oss-120b' : 'openai/gpt-oss-20b';
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.ai.groqKey}`
        },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: 1200 })
      });
      if (response.ok) {
        await consumeOpenAIStream(response, sendChunk);
        providerUsed = 'groq';
        modelUsed = model;
      } else {
        markGroqFailed(response.status);
        errors.push(`Groq HTTP ${response.status}`);
      }
    } catch (e) {
      errors.push(`Groq: ${e.message}`);
    }
  }

  // 2. OmniRoute fallback
  if (!providerUsed && isOmniRouteAvailable()) {
    try {
      const response = await fetch(`${config.ai.omniRoute.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.ai.omniRoute.apiKey}`
        },
        body: JSON.stringify({ model: config.ai.omniRoute.model, messages, stream: true, max_tokens: 1200 })
      });
      if (response.ok) {
        await consumeOpenAIStream(response, sendChunk);
        providerUsed = 'omniroute';
        modelUsed = config.ai.omniRoute.model;
      } else {
        errors.push(`OmniRoute HTTP ${response.status}`);
      }
    } catch (e) {
      markOmniRouteFailed(e.cause?.code === 'ECONNREFUSED' || e.code === 'ECONNREFUSED' || (e.message && e.message.includes('fetch failed')));
      errors.push(`OmniRoute: ${e.message}`);
    }
  }

  // 3. Gemini fallback
  if (!providerUsed && config.ai.geminiKeys.length > 0) {
    for (let i = 0; i < config.ai.geminiKeys.length; i++) {
      const activeKey = getNextGeminiKey();
      if (!activeKey) continue;
      try {
        const genAI = new GoogleGenerativeAI(activeKey.key);
        const model = genAI.getGenerativeModel({
          model: 'gemini-3.6-flash',
          generationConfig: {
            maxOutputTokens: 1200,
            temperature: 0.65
          }
        });
        const resultStream = await withTimeout(model.generateContentStream(prompt), 6000, 'Gemini response timed out');
        for await (const chunk of resultStream.stream) {
          const text = chunk.text();
          if (text) sendChunk(text);
        }
        providerUsed = 'gemini';
        modelUsed = 'gemini-3.6-flash';
        break;
      } catch (e) {
        errors.push(`Gemini #${activeKey.index}: ${e.message}`);
      }
    }
  }

  const latencyMs = Date.now() - start;

  if (providerUsed) {
    await meterService.logAndMeterUsage(userId, {
      requestType: 'chat',
      provider: providerUsed,
      model: modelUsed,
      promptTokens: Math.round(prompt.split(/\s+/).length * 1.33),
      completionTokens: Math.round(fullAnswerText.split(/\s+/).length * 1.33),
      costPaise: config.pricing.generateGroq,
      latencyMs,
      success: true,
      question,
      isTrial
    });
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } else {
    await meterService.logAndMeterUsage(userId, {
      requestType: 'chat',
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
