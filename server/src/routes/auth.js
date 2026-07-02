// ─── Authentication Routing ──────────────────────────────────
const express = require('express');
const authService = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/**
 * GET /auth/google/url
 * Returns the Google login URL for the desktop OAuth flow.
 */
router.get('/google/url', (req, res) => {
  const { state } = req.query; // 'web' or 'desktop'
  const url = authService.getGoogleAuthUrl(state || 'desktop');
  res.json({ success: true, url });
});

/**
 * GET /auth/google/callback
 * Browser landing page callback. Redirects to Electron local loopback server OR Vercel web landing.
 */
router.get('/google/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code) {
      return res.status(400).send('Authentication code is missing');
    }

    if (state === 'web') {
      const result = await authService.handleGoogleCallback(code, 'web-client');
      const redirectUrl = `https://interview-updated.vercel.app/?token=${encodeURIComponent(result.accessToken)}&name=${encodeURIComponent(result.user.name)}&email=${encodeURIComponent(result.user.email)}&avatarUrl=${encodeURIComponent(result.user.avatarUrl)}`;
      return res.redirect(redirectUrl);
    }

    // Perform direct HTTP redirect to Electron loopback port to prevent CSP inline script blocks
    res.redirect(`http://localhost:52981/oauth-callback?code=${encodeURIComponent(code)}`);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/google/callback
 * Exchanges the auth code for access/refresh tokens and checks/registers device fingerprint.
 */
router.post('/google/callback', authLimiter, async (req, res, next) => {
  try {
    const { code, deviceFingerprint, biosUuid, cpuId, diskSerial, machineGuid, platform } = req.body;
    
    if (!code) {
      return res.status(400).json({ success: false, error: 'Authorization code is required' });
    }
    if (!deviceFingerprint) {
      return res.status(400).json({ success: false, error: 'Device fingerprint is required' });
    }

    const result = await authService.handleGoogleCallback(code, deviceFingerprint, {
      biosUuid,
      cpuId,
      diskSerial,
      machineGuid,
      platform
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/refresh
 * Refresh access token using rotation pattern.
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, error: 'Refresh token is required' });
    }

    const tokens = await authService.refreshAccessToken(refreshToken);
    res.json({ success: true, ...tokens });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/logout
 * Destroy session.
 */
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    await authService.logout(req.user.id, token);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/profile
 * Get current logged in user details.
 */
router.get('/profile', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Temporary diagnostic endpoint for deployed server errors
const fs = require('fs');
const path = require('path');
router.get('/logs-debug', (req, res) => {
  try {
    const logPath = path.join(__dirname, '..', '..', 'logs', 'error.log');
    if (!fs.existsSync(logPath)) {
      return res.json({ success: true, message: 'No error log file found.' });
    }
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    const lastLines = lines.slice(-20);
    res.json({
      success: true,
      errors: lastLines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return line;
        }
      })
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
