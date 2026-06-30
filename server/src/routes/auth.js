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
  const url = authService.getGoogleAuthUrl();
  res.json({ success: true, url });
});

/**
 * GET /auth/google/callback
 * Browser landing page redirecting to Electron local loopback server.
 */
router.get('/google/callback', (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authentication code is missing');
  }
  // Perform direct HTTP redirect to Electron loopback port to prevent CSP inline script blocks
  res.redirect(`http://localhost:52981/oauth-callback?code=${encodeURIComponent(code)}`);
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

module.exports = router;
