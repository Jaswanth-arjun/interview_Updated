// ─── JWT Authentication Middleware ───────────────────────────
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const config = require('../config');
const { AuthError, ForbiddenError } = require('../utils/errors');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * Verify JWT access token from Authorization header.
 * Attaches `req.user` with full user record from DB.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthError('Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];
    let payload;
    try {
      payload = jwt.verify(token, config.jwt.accessSecret);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw new AuthError('Access token expired. Please refresh.');
      }
      throw new AuthError('Invalid access token');
    }

    // Fetch user from DB
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        name: true,
        tier: true,
        walletBalancePaise: true,
        freeTrialRequests: true,
        freeTrialUsed: true,
        deviceFingerprint: true,
        isBlocked: true,
        isAdmin: true,
        avatarUrl: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new AuthError('User account not found');
    }

    if (user.isBlocked) {
      throw new ForbiddenError('Your account has been suspended. Contact support.');
    }

    req.user = user;
    req.tokenPayload = payload;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Optional auth — attaches req.user if token is valid, otherwise continues.
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];
    try {
      const payload = jwt.verify(token, config.jwt.accessSecret);
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
      });
      req.user = user && !user.isBlocked ? user : null;
    } catch {
      req.user = null;
    }
    next();
  } catch (err) {
    req.user = null;
    next();
  }
}

/**
 * Require admin privileges.
 */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return next(new ForbiddenError('Admin access required'));
  }
  next();
}

/**
 * Generate access and refresh tokens for a user.
 */
function generateTokenPair(userId) {
  const accessToken = jwt.sign(
    { userId, type: 'access' },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiry }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiry }
  );

  return { accessToken, refreshToken };
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  generateTokenPair,
};
