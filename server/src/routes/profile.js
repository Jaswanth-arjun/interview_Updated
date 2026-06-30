// ─── Profile Setup Routing ────────────────────────────────────
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /profile/setup
 * Fetch candidate's current interview profile setup.
 */
router.get('/setup', requireAuth, async (req, res, next) => {
  try {
    const profile = await prisma.profileData.findUnique({
      where: { userId: req.user.id }
    });
    res.json({ success: true, profile: profile || {} });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /profile/setup
 * Upsert the candidate's interview profile setup.
 */
router.post('/setup', requireAuth, async (req, res, next) => {
  try {
    const { resumeText, companyName, roleName, jobDescription, projects, extraNotes } = req.body;

    const profile = await prisma.profileData.upsert({
      where: { userId: req.user.id },
      create: {
        userId: req.user.id,
        resumeText,
        companyName,
        roleName,
        jobDescription,
        projects,
        extraNotes
      },
      update: {
        resumeText,
        companyName,
        roleName,
        jobDescription,
        projects,
        extraNotes
      }
    });

    res.json({ success: true, profile });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
