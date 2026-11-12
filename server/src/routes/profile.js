// â”€â”€â”€ Profile Setup Routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getMemoryProfile, setMemoryProfile } = require('../services/authService');

const router = express.Router();
const prisma = require('../db/prisma');

/**
 * GET /profile/setup
 * Fetch candidate's current interview profile setup.
 */
router.get('/setup', requireAuth, async (req, res, next) => {
  try {
    let profile = null;
    try {
      profile = await prisma.profileData.findUnique({
        where: { userId: req.user.id }
      });
    } catch (e) {
      profile = getMemoryProfile(req.user.id);
    }
    if (!profile) {
      profile = getMemoryProfile(req.user.id);
    }
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
    let profile = null;
    try {
      profile = await prisma.profileData.upsert({
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
    } catch (err) {
      profile = setMemoryProfile(req.user.id, {
        userId: req.user.id,
        resumeText,
        companyName,
        roleName,
        jobDescription,
        projects,
        extraNotes,
        updatedAt: new Date()
      });
    }
    if (!profile) {
      profile = setMemoryProfile(req.user.id, {
        userId: req.user.id,
        resumeText,
        companyName,
        roleName,
        jobDescription,
        projects,
        extraNotes,
        updatedAt: new Date()
      });
    }

    res.json({ success: true, profile });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
