// ─── Auth Service ────────────────────────────────────────────
const { OAuth2Client } = require('google-auth-library');
const { PrismaClient } = require('@prisma/client');
const config = require('../config');
const { generateTokenPair } = require('../middleware/auth');
const { AuthError, DeviceBindingError, ForbiddenError } = require('../utils/errors');
const logger = require('../utils/logger');

const prisma = new PrismaClient();
const googleClient = new OAuth2Client(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

/**
 * Generate the Google OAuth authorization URL for desktop PKCE flow.
 */
function getGoogleAuthUrl() {
  return googleClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
}

/**
 * Exchange Google auth code for user info, create/find user, bind device, return tokens.
 */
async function handleGoogleCallback(code, deviceFingerprint) {
  // 1. Exchange code for Google tokens
  const { tokens } = await googleClient.getToken(code);
  googleClient.setCredentials(tokens);

  // 2. Get user info from Google
  const ticket = await googleClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.google.clientId,
  });
  const googleUser = ticket.getPayload();
  const { sub: googleId, email, name, picture } = googleUser;

  if (!email) {
    throw new AuthError('Google account has no email address');
  }

  logger.info(`Google auth for: ${email}`);

  // 3. Find or create user
  let user = await prisma.user.findUnique({ where: { googleId } });

  if (!user) {
    user = await prisma.user.findUnique({ where: { email } });
  }

  if (user) {
    // ── Existing user ──
    if (user.isBlocked) {
      throw new ForbiddenError('Your account has been suspended. Contact support.');
    }

    // Check device binding
    if (user.deviceFingerprint && user.deviceFingerprint !== deviceFingerprint) {
      throw new DeviceBindingError(
        'This account is already linked to another device. Contact support to reset.'
      );
    }

    // Update user info
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        googleId: googleId,
        name: name || user.name,
        avatarUrl: picture || user.avatarUrl,
        deviceFingerprint: deviceFingerprint,
        lastLoginAt: new Date(),
      },
    });
  } else {
    // ── New user ──

    // Check if device is already claimed by another account
    const existingDevice = await prisma.deviceRegistry.findUnique({
      where: { fingerprint: deviceFingerprint },
    });

    if (existingDevice && existingDevice.userId) {
      throw new DeviceBindingError(
        'This device is already registered with another account. Only one account per device is allowed.'
      );
    }

    // Create new user with free trial
    user = await prisma.user.create({
      data: {
        email,
        name,
        googleId,
        avatarUrl: picture,
        tier: 'trial',
        freeTrialRequests: 25,
        freeTrialUsed: 0,
        walletBalancePaise: 0,
        deviceFingerprint: deviceFingerprint,
        isAdmin: config.adminEmails.includes(email),
        lastLoginAt: new Date(),
      },
    });

    // Register device
    await prisma.deviceRegistry.upsert({
      where: { fingerprint: deviceFingerprint },
      create: {
        fingerprint: deviceFingerprint,
        userId: user.id,
        claimedAt: new Date(),
      },
      update: {
        userId: user.id,
        claimedAt: new Date(),
      },
    });

    logger.info(`New user registered: ${email} (trial: 25 requests)`);
  }

  // 4. Generate JWT tokens
  const { accessToken, refreshToken } = generateTokenPair(user.id);

  // 5. Store session
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await prisma.session.create({
    data: {
      userId: user.id,
      deviceFprint: deviceFingerprint,
      accessToken,
      refreshToken,
      expiresAt,
    },
  });

  // 6. Update refresh token on user
  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken },
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tier: user.tier,
      walletBalancePaise: user.walletBalancePaise,
      freeTrialRequests: user.freeTrialRequests,
      freeTrialUsed: user.freeTrialUsed,
      isAdmin: user.isAdmin,
    },
  };
}

/**
 * Refresh an access token using a refresh token.
 */
async function refreshAccessToken(oldRefreshToken) {
  const jwt = require('jsonwebtoken');
  let payload;
  try {
    payload = jwt.verify(oldRefreshToken, config.jwt.refreshSecret);
  } catch {
    throw new AuthError('Invalid or expired refresh token. Please sign in again.');
  }

  const session = await prisma.session.findFirst({
    where: { refreshToken: oldRefreshToken, userId: payload.userId },
  });

  if (!session || session.expiresAt < new Date()) {
    throw new AuthError('Session expired. Please sign in again.');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || user.isBlocked) {
    throw new AuthError('Account not found or suspended.');
  }

  // Generate new token pair
  const { accessToken, refreshToken: newRefreshToken } = generateTokenPair(user.id);

  // Update session
  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.session.update({
    where: { id: session.id },
    data: {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiry,
    },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken: newRefreshToken },
  });

  return { accessToken, refreshToken: newRefreshToken };
}

/**
 * Logout — invalidate session.
 */
async function logout(userId, accessToken) {
  await prisma.session.deleteMany({
    where: { userId, accessToken },
  });
  logger.info(`User logged out: ${userId}`);
}

module.exports = {
  getGoogleAuthUrl,
  handleGoogleCallback,
  refreshAccessToken,
  logout,
};
