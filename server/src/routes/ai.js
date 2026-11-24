// â”€â”€â”€ AI Pipeline Execution Routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimit');
const walletService = require('../services/walletService');
const aiService = require('../services/aiService');
const { AuthError, InsufficientBalanceError } = require('../utils/errors');
const logger = require('../utils/logger');
const { getMemoryProfile } = require('../services/authService');

const router = express.Router();
const prisma = require('../db/prisma');
const PROFILE_FIELDS = ['resumeText', 'companyName', 'roleName', 'jobDescription', 'projects', 'extraNotes'];

function pickProfileData(data = {}) {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field, typeof data[field] === 'string' ? data[field].trim() : '']));
}

async function getStoredProfile(userId) {
  try {
    const stored = await prisma.profileData.findUnique({ where: { userId } });
    if (stored) return stored;
  } catch (error) {
    logger.warn('Profile DB lookup failed; using in-memory profile:', error.message);
  }
  return getMemoryProfile(userId);
}

/**
 * Helper to resolve user context (demo session vs. registered session).
 */
async function resolveSessionContext(req) {
  const authHeader = req.headers.authorization;
  
  // â”€â”€ Demo Mode â”€â”€
  if (authHeader === 'Bearer demo' || !authHeader) {
    return {
      userId: 'demo-user',
      isDemo: true,
      isTrial: false,
      isSlow: true,
      allowed: true
    };
  }

  // â”€â”€ Registered User â”€â”€
  if (!req.user) {
    throw new AuthError('Access Denied: Invalid session token');
  }

  const userId = req.user.id;
  const isTrial = req.user.tier === 'trial';
  const isSlow = isTrial; // trial uses slow Gemini path; pro uses fast Groq path

  return {
    userId,
    isDemo: false,
    isTrial,
    isSlow,
    userRecord: req.user
  };
}

/**
 * POST /ai/transcribe
 * Audio Speech-to-Text handler.
 */
router.post('/transcribe', optionalAuth, aiLimiter, async (req, res, next) => {
  try {
    const { base64Audio, mimeType, isPartial = false } = req.body;
    if (!base64Audio) {
      return res.status(400).json({ success: false, error: 'Base64 audio payload is required' });
    }

    const session = await resolveSessionContext(req);

    if (!session.isDemo && !isPartial) {
      // Enforce billing checks for logged-in accounts
      const quota = await walletService.checkQuota(session.userId, 'transcribe');
      if (!quota.allowed) {
        throw new InsufficientBalanceError(quota.reason);
      }
    }

    const result = await aiService.transcribeAudio(
      session.userId,
      base64Audio,
      mimeType,
      session.isTrial,
      session.isSlow,
      isPartial
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /ai/generate
 * Streams interview answers using Server-Sent Events (SSE).
 */
router.post('/generate', optionalAuth, aiLimiter, async (req, res, next) => {
  try {
    const { question } = req.body;
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }

    const session = await resolveSessionContext(req);
    const providedProfile = pickProfileData(req.body);
    const hasCompleteProfile = PROFILE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(req.body, field))
      && PROFILE_FIELDS.some((field) => providedProfile[field]);
    let activeProfile = providedProfile;

    if (!session.isDemo) {
      // 1. Enforce billing checks for registered accounts
      const quota = await walletService.checkQuota(session.userId, 'generate');
      if (!quota.allowed) {
        return res.status(402).json({ success: false, error: quota.reason });
      }

      // 2. Fill missing context from the stored profile without delaying complete desktop requests.
      if (!hasCompleteProfile) {
        const stored = pickProfileData(await getStoredProfile(session.userId));
        activeProfile = { ...stored };
        for (const field of PROFILE_FIELDS) {
          if (providedProfile[field]) activeProfile[field] = providedProfile[field];
        }
      }
    }

    // Stream answer chunks via SSE
    await aiService.generateAnswerStream(
      session.userId,
      question,
      activeProfile,
      res,
      session.isTrial,
      session.isSlow
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /ai/chat
 * RAG Chat Assistant — answers app / profile / LinkedIn-network questions.
 * Streams the answer via SSE, grounded in the candidate profile and
 * (for LinkedIn questions) live LinkedIn data scraped client-side.
 */
router.post('/chat', optionalAuth, aiLimiter, async (req, res, next) => {
  try {
    const { question, history, linkedinContext } = req.body;
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }

    const session = await resolveSessionContext(req);

    if (!session.isDemo) {
      const quota = await walletService.checkQuota(session.userId, 'generate');
      if (!quota.allowed) {
        return res.status(402).json({ success: false, error: quota.reason });
      }
    }

    // Retrieve stored profile as grounding context
    let profileData = {};
    if (!session.isDemo) {
      const stored = await prisma.profileData.findUnique({
        where: { userId: session.userId }
      });
      if (stored) profileData = stored;
    }

    await aiService.generateChatStream(
      session.userId,
      question,
      { history, profileData, linkedinContext },
      res,
      session.isTrial,
      session.isSlow
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
