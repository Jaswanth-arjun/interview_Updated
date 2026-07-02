// ─── Auth Service ────────────────────────────────────────────
const { OAuth2Client } = require('google-auth-library');
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
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
function getGoogleAuthUrl(state = 'desktop') {
  return googleClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    state: state
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

  const isUserAdmin = config.adminEmails.includes(email);

  const isWeb = deviceFingerprint === 'web-client';

  if (user) {
    // ── Existing user ──
    if (user.isBlocked) {
      throw new ForbiddenError('Your account has been suspended. Contact support.');
    }

    const isAdmin = user.isAdmin || isUserAdmin;

    // Check device binding (only enforced for non-admin accounts and non-web users)
    if (!isWeb && !isAdmin && user.deviceFingerprint && user.deviceFingerprint !== deviceFingerprint) {
      throw new DeviceBindingError(
        'This account is already linked to another device. Contact support to reset.'
      );
    }

    // Update user info
    const updateData = {
      googleId: googleId,
      name: name || user.name,
      avatarUrl: picture || user.avatarUrl,
      lastLoginAt: new Date(),
      isAdmin: isAdmin,
    };
    
    if (isAdmin) {
      if (!user.deviceFingerprint || !user.deviceFingerprint.startsWith('admin-')) {
        updateData.deviceFingerprint = `admin-${uuidv4()}`;
      }
    } else if (isWeb) {
      if (!user.deviceFingerprint) {
        updateData.deviceFingerprint = `web-${uuidv4()}`;
      }
    } else {
      updateData.deviceFingerprint = deviceFingerprint;
    }

    user = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
    });

    // Register device only for non-admin and non-web users
    if (!isWeb && !isAdmin && deviceFingerprint) {
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
    }
  } else {
    // ── New user ──

    // Check if device is already claimed by another account (only enforced for non-admin and non-web users)
    if (!isWeb && !isUserAdmin) {
      const existingDevice = await prisma.deviceRegistry.findUnique({
        where: { fingerprint: deviceFingerprint },
      });

      if (existingDevice && existingDevice.userId) {
        throw new DeviceBindingError(
          'This device is already registered with another account. Only one account per device is allowed.'
        );
      }
    }

    // Create new user (deviceFingerprint is set to a unique ID for admins and web-client logins to prevent unique constraint conflicts)
    user = await prisma.user.create({
      data: {
        email,
        name,
        googleId,
        avatarUrl: picture,
        tier: 'free',
        freeTrialRequests: 0,
        freeTrialUsed: 0,
        walletBalancePaise: 1000, // Welcome balance of ₹10.00
        deviceFingerprint: isUserAdmin
          ? `admin-${uuidv4()}`
          : isWeb
            ? `web-${uuidv4()}`
            : (deviceFingerprint || `user-${uuidv4()}`),
        isAdmin: isUserAdmin,
        lastLoginAt: new Date(),
      },
    });

    // Register device only for non-admin and non-web users
    if (!isWeb && !isUserAdmin && deviceFingerprint) {
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
    }

    logger.info(`New user registered: ${email} (welcome balance: ₹10.00)`);
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

  const isAdminResult = user.isAdmin || isUserAdmin;
  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      tier: isAdminResult ? 'pro' : user.tier,
      walletBalancePaise: isAdminResult ? 99999999 : user.walletBalancePaise,
      freeTrialRequests: user.freeTrialRequests,
      freeTrialUsed: user.freeTrialUsed,
      isAdmin: isAdminResult,
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
