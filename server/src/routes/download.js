// ─── Download Routing ────────────────────────────────────────
const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /download/app
 * Serves the desktop application executable file.
 * Downloads to user's default Downloads folder.
 */
router.get('/app', requireAuth, async (req, res) => {
    try {
        const downloadUrl = 'https://github.com/Jaswanth-arjun/interview_Updated/releases/download/v1.0.0/Interview%20Copilot%20Setup%201.0.0.exe';
        
        logger.info(`Redirecting authenticated user ${req.user.email} to GitHub release download`);
        
        // Redirect to GitHub release URL
        res.redirect(downloadUrl);
    } catch (err) {
        logger.error('Download endpoint redirect error:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to process download redirect',
            code: 'INTERNAL_ERROR'
        });
    }
});

module.exports = router;
