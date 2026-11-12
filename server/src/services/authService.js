// â”€â”€â”€ Auth Service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const { OAuth2Client } = require('google-auth-library');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { generateTokenPair } = require('../middleware/auth');
const { AuthError, DeviceBindingError, ForbiddenError } = require('../utils/errors');
const logger = require('../utils/logger');

const prisma = require('../db/prisma');
const googleClient = new OAuth2Client(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

// ─── In-Memory Fallback Cache (resilience against DB outages / paused poolers) ───
const memoryUsers = new Map();
const memoryProfiles = new Map();
const memorySessions = new Map();

function getMemoryUser(userIdOrEmail) {
  if (!userIdOrEmail) return null;
  return memoryUsers.get(userIdOrEmail) || null;
}

function setMemoryUser(id, user) {
  if (!id || !user) return user;
  memoryUsers.set(id, user);
  if (user.email) memoryUsers.set(user.email, user);
  return user;
}

function getMemoryProfile(userId) {
  return memoryProfiles.get(userId) || null;
}

function setMemoryProfile(userId, profile) {
  memoryProfiles.set(userId, profile);
  return profile;
}

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
  let tokens;
  try {
    ({ tokens } = await googleClient.getToken(code));
  } catch (err) {
    const googleError = err.response?.data?.error;
    const googleDescription = err.response?.data?.error_description;

    if (googleError === 'invalid_grant') {
      throw new AuthError(
        'This Google sign-in request has expired or was already used. Close this tab and start Google sign-in again.'
      );
    }

    if (googleError === 'redirect_uri_mismatch') {
      throw new AuthError(
        'Google sign-in is not configured for this application URL. Check the OAuth redirect URI configuration.'
      );
    }

    logger.error(
      `Google token exchange failed (${googleError || 'unknown'}): ${googleDescription || err.message}`
    );
    throw new AuthError('Google sign-in could not be completed. Please try again.');
  }
  googleClient.setCredentials(tokens);

  // 2. Get user info from Google
  let googleUser;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.google.clientId,
    });
    googleUser = ticket.getPayload();
  } catch (err) {
    logger.warn(`googleClient.verifyIdToken failed (${err.message}), decoding id_token directly`);
    const jwt = require('jsonwebtoken');
    googleUser = jwt.decode(tokens.id_token);
  }

  if (!googleUser || !googleUser.email) {
    throw new AuthError('Google account has no email address');
  }

  const { sub: googleId, email, name, picture } = googleUser;

  logger.info(`Google auth for: ${email}`);

  // 3. Find or create user
  let user = null;
  let isDbConnected = true;

  try {
    user = await prisma.user.findUnique({ where: { googleId } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { email } });
    }
  } catch (dbErr) {
    logger.warn(`Database unreachable during Google auth (${dbErr.message}). Falling back to memory session.`);
    isDbConnected = false;
    user = memoryUsers.get(email) || null;
  }

  const isUserAdmin = config.adminEmails.map(e => e.toLowerCase()).includes((email || '').toLowerCase());
  const isWeb = deviceFingerprint === 'web-client';

  if (isDbConnected) {
    try {
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

        user = await prisma.user.create({
          data: {
            email,
            name,
            googleId,
            avatarUrl: picture,
            tier: isUserAdmin ? 'pro' : 'free',
            freeTrialRequests: 0,
            freeTrialUsed: 0,
            walletBalancePaise: isUserAdmin ? 99999999 : 1000,
            deviceFingerprint: isUserAdmin
              ? `admin-${uuidv4()}`
              : isWeb
                ? `web-${uuidv4()}`
                : (deviceFingerprint || `user-${uuidv4()}`),
            isAdmin: isUserAdmin,
            lastLoginAt: new Date(),
          },
        });

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

        logger.info(`New user registered: ${email}`);
      }
    } catch (err) {
      if (err instanceof ForbiddenError || err instanceof DeviceBindingError) {
        throw err;
      }
      logger.warn(`Database operation failed during Google auth (${err.message}). Using memory fallback.`);
      isDbConnected = false;
    }
  }

  // If DB was unavailable or failed, initialize/update the memory user
  if (!isDbConnected || !user) {
    const isAdminResult = isUserAdmin || (user && user.isAdmin);
    user = {
      id: user?.id || uuidv4(),
      email,
      name: name || user?.name || (email ? email.split('@')[0] : 'User'),
      googleId,
      avatarUrl: picture || user?.avatarUrl,
      tier: isAdminResult ? 'pro' : 'free',
      walletBalancePaise: isAdminResult ? 99999999 : 1000,
      freeTrialRequests: 25,
      freeTrialUsed: 0,
      deviceFingerprint: deviceFingerprint || `dev-${uuidv4()}`,
      isBlocked: false,
      isAdmin: isAdminResult,
      lastLoginAt: new Date(),
    };
  }

  // Always keep user in memory cache
  setMemoryUser(user.id, user);

  // 4. Generate JWT tokens
  const { accessToken, refreshToken } = generateTokenPair(user.id);

  // 5. Store session
  if (isDbConnected) {
    try {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await prisma.session.create({
        data: {
          userId: user.id,
          deviceFprint: deviceFingerprint || 'unknown',
          accessToken,
          refreshToken,
          expiresAt,
        },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { refreshToken },
      });
    } catch (err) {
      logger.warn(`Could not save session to DB: ${err.message}`);
    }
  }

  memorySessions.set(refreshToken, { userId: user.id, accessToken, refreshToken });
  setMemoryUser(user.id, { ...user, refreshToken });

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
      freeTrialRequests: user.freeTrialRequests || 25,
      freeTrialUsed: user.freeTrialUsed || 0,
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

  let session = null;
  try {
    session = await prisma.session.findFirst({
      where: { refreshToken: oldRefreshToken, userId: payload.userId },
    });
  } catch (err) {
    session = memorySessions.get(oldRefreshToken);
  }
  if (!session) {
    session = memorySessions.get(oldRefreshToken);
  }

  let user = null;
  try {
    user = await prisma.user.findUnique({ where: { id: payload.userId } });
  } catch (err) {
    user = getMemoryUser(payload.userId);
  }
  if (!user) {
    user = getMemoryUser(payload.userId);
  }

  if (!user || user.isBlocked) {
    throw new AuthError('Account not found or suspended.');
  }

  // Generate new token pair
  const { accessToken, refreshToken: newRefreshToken } = generateTokenPair(user.id);

  try {
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    if (session && session.id) {
      await prisma.session.update({
        where: { id: session.id },
        data: {
          accessToken,
          refreshToken: newRefreshToken,
          expiresAt: newExpiry,
        },
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken },
    });
  } catch (err) {
    logger.warn(`Could not update refreshed session in DB: ${err.message}`);
  }

  memorySessions.set(newRefreshToken, { userId: user.id, accessToken, refreshToken: newRefreshToken });
  setMemoryUser(user.id, { ...user, refreshToken: newRefreshToken });

  return { accessToken, refreshToken: newRefreshToken };
}

/**
 * Logout — invalidate session.
 */
async function logout(userId, accessToken) {
  try {
    await prisma.session.deleteMany({
      where: { userId, accessToken },
    });
  } catch {}
  memoryUsers.delete(userId);
  logger.info(`User logged out: ${userId}`);
}

module.exports = {
  getGoogleAuthUrl,
  handleGoogleCallback,
  refreshAccessToken,
  logout,
  getMemoryUser,
  setMemoryUser,
  getMemoryProfile,
  setMemoryProfile,
};
