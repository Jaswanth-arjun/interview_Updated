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
      if (isRefused) throw err; // Never retry an offline port!
      const isLastAttempt = attempt === retries;
      const isNetworkError = err.name === 'AbortError' || err.message?.includes('fetch failed') || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (isLastAttempt || !isNetworkError) throw err;
      logger.warn(`⟳ Network error on attempt ${attempt + 1}/${retries + 1}, retrying in ${retryDelayMs}ms...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Transcription Cleaner (from main.js) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
  // Lock Whisper to English and reduce hallucinations on noise/silence —
  // without this, background sounds get "transcribed" as random foreign
  // languages (e.g. Icelandic "Hvað er það?").
  formData.append('language', 'en');
  formData.append('temperature', '0');
  formData.append('prompt', 'The speaker asks job interview questions in clear English.');
  return formData;
}

// Filter out noise/hallucination transcriptions that are clearly NOT
// real interviewer questions (e.g. random foreign-language gibberish,
// single words picked from background sounds).
function isLikelyQuestion(text) {
  const t = (text || '').trim();
  if (t.length < 8) return false;                        // too short (at least 8 chars, e.g. "Why Java?")
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;                    // at least 2 words (e.g. "Explain Redux")
  // Reject non-English characters (foreign-language hallucinations like
  // Icelandic _/d, CJK, Cyrillic etc.)
  const foreignChars = (t.match(/[^a-zA-Z0-9 .,?!'"'\-:;()&/$%@#+\n]/g) || []).length;
  if (foreignChars / t.length > 0.04) return false;
  // Reject common Whisper hallucinations from fan/room background noise
  // (filler words, greetings, sign-offs in any language)
  const hallucination = /^(thank(s| you)?|thanks (for )?watching|okay+|ok|yeah|yes|no|hello+|hi+|bye+|tchau|obrigado|gracias|merci|arigato|danke|sorry|wow|umm*|hmm*|bye bye|see you|goodbye)\b/i;
  if (hallucination.test(t)) return false;
  return true;
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

  // 1. Groq Whisper first (ultra-fast transcription for all tiers)
  if (isGroqAvailable()) {
    try {
      logger.info(`⚡ Transcribing via Groq Whisper...`);
      const response = await fetchWithRetry('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.ai.groqKey}` },
        body: buildAudioFormData(base64Audio, mimeType, 'whisper-large-v3-turbo')
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.text?.trim();
        const cleaned = cleanTranscriptionText(text);
        const latencyMs = Date.now() - start;

        await meterService.logAndMeterUsage(userId, {
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

        return { success: true, text: isLikelyQuestion(cleaned) ? cleaned : '' };
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

        return { success: true, text: isLikelyQuestion(cleaned) ? cleaned : '' };
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
          model: 'gemini-3.6-flash',
          audioDurationMs,
          costPaise: config.pricing.transcribe,
          latencyMs,
          success: true,
          question: cleaned,
          isTrial
        });

        return { success: true, text: isLikelyQuestion(cleaned) ? cleaned : '' };
      } catch (e) {
        logger.warn(`Gemini Transcription Key #${activeKey.index} failed: ${e.message}`);
        errors.push(`Gemini #${activeKey.index}: ${e.message}`);
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
  return `You are an expert, highly skilled candidate answering an interview question in a live technical/behavioral job interview for the role of "${d.roleName || 'Software Engineer'}" at "${d.companyName || 'the target company'}".

INTERVIEWER'S QUESTION:
"${question}"

YOUR INSTRUCTIONS:
- Deliver a COMPLETE, IN-DEPTH, PROFESSIONAL, and WINNING interview response. Do NOT give a 1-word or 1-sentence answer. Provide a thorough, well-rounded interview-level answer that demonstrates strong expertise and practical experience.
- Structure your answer clearly into logical parts:
  1. Direct Definition & Core Answer: Start with a clear, authoritative explanation of the concept or direct answer to the question.
  2. Technical Architecture & How It Works: Explain the underlying mechanics, components, trade-offs, and why this approach is chosen.
  3. Practical Real-World Experience: Give a concrete real-world scenario or project implementation example (referencing relevant details from the candidate context below).
  4. Best Practices & Key Takeaways: Conclude with key performance tips, pitfalls to avoid, or architectural best practices.
- Tone: Confident, articulate, professional, and natural.
- Format: Clear spoken paragraphs. You may use short bullet points when listing key features or trade-offs so it is easy to read and deliver out loud.
- NEVER say you are an AI, virtual assistant, or language model. You ARE the candidate.

CANDIDATE CONTEXT:
Role: ${d.roleName || 'N/A'} at ${d.companyName || 'N/A'}
JD: ${d.jobDescription || 'N/A'}
Resume: ${d.resumeText || 'N/A'}
Projects: ${d.projects || 'N/A'}
Notes: ${d.extraNotes || 'N/A'}

Provide your complete, comprehensive interview answer now:`;
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

  // 1. Groq generation first (ultra-fast answer streaming)
  if (isGroqAvailable()) {
    try {
      logger.info(`⚡ Generating answer via Groq...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.ai.groqKey}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          max_tokens: 1200
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

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
      const response = await fetch(`${config.ai.omniRoute.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.ai.omniRoute.apiKey}`
        },
        body: JSON.stringify({
          model: config.ai.omniRoute.model,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
          max_tokens: 1200
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
            maxOutputTokens: 1200,
            temperature: 0.65,
          }
        });
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
        const resultStream = await model.generateContentStream(prompt);
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
