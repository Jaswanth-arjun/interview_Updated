// ─── AI Pipeline Execution Routing ────────────────────────────
const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimit');
const walletService = require('../services/walletService');
const aiService = require('../services/aiService');
const { PrismaClient } = require('@prisma/client');
const { AuthError, InsufficientBalanceError } = require('../utils/errors');
const logger = require('../utils/logger');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * Helper to resolve user context (demo session vs. registered session).
 */
async function resolveSessionContext(req) {
  const authHeader = req.headers.authorization;
  
  // ── Demo Mode ──
  if (authHeader === 'Bearer demo' || !authHeader) {
    return {
      userId: 'demo-user',
      isDemo: true,
      isTrial: false,
      isSlow: true,
      allowed: true
    };
  }

  // ── Registered User ──
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
    const { base64Audio, mimeType } = req.body;
    if (!base64Audio) {
      return res.status(400).json({ success: false, error: 'Base64 audio payload is required' });
    }

    const session = await resolveSessionContext(req);

    if (!session.isDemo) {
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
      session.isSlow
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
    const { question, resumeText, companyName, roleName, jobDescription, projects, extraNotes } = req.body;
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }

    const session = await resolveSessionContext(req);

    let activeProfile = { resumeText, companyName, roleName, jobDescription, projects, extraNotes };

    if (!session.isDemo) {
      // 1. Enforce billing checks for registered accounts
      const quota = await walletService.checkQuota(session.userId, 'generate');
      if (!quota.allowed) {
        return res.status(402).json({ success: false, error: quota.reason });
      }

      // 2. Fetch stored profile from DB if not passed in body
      if (!activeProfile.resumeText && !activeProfile.jobDescription) {
        const stored = await prisma.profileData.findUnique({
          where: { userId: session.userId }
        });
        if (stored) activeProfile = stored;
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

module.exports = router;
