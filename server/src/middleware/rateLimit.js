// ─── Rate Limiting Middleware ────────────────────────────────
const rateLimit = require('express-rate-limit');

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 180, // generous headroom for frequent desktop polling & transcription
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development' || req.ip === '127.0.0.1' || req.ip === '::1',
  message: {
    success: false,
    error: 'Too many requests. Please slow down.',
    code: 'RATE_LIMITED',
  },
});

// Auth endpoints rate limit (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // allow legitimate retries (cold starts, transient DB errors can burn attempts fast)
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many login attempts. Try again in 15 minutes.',
    code: 'RATE_LIMITED',
  },
});

// AI endpoints rate limit
const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // allow rapid audio transcription cycles during continuous listening
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development' || req.ip === '127.0.0.1' || req.ip === '::1',
  message: {
    success: false,
    error: 'AI request rate limit exceeded. Please wait a moment.',
    code: 'RATE_LIMITED',
  },
});

// Payment endpoints rate limit
const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many payment requests. Try again later.',
    code: 'RATE_LIMITED',
  },
});

module.exports = {
  apiLimiter,
  authLimiter,
  aiLimiter,
  paymentLimiter,
};
