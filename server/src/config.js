// ─── Server Configuration ────────────────────────────────────
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = {
  port: parseInt(process.env.PORT) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // JWT
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },

  // Google OAuth
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/auth/google/callback',
  },

  // Razorpay
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },

  // AI Provider Keys
  ai: {
    geminiKeys: [
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
    ].filter(k => k && !k.startsWith('your_') && !k.startsWith('AIzaSy_your')),
    groqKey: process.env.GROQ_API_KEY,
    omniRoute: {
      apiKey: process.env.OMNI_ROUTE_API_KEY,
      baseUrl: process.env.OMNI_ROUTE_BASE_URL || 'http://localhost:20128/v1',
      model: process.env.OMNI_ROUTE_MODEL || 'mimo-v2.5-free',
    },
  },

  // Pricing (paise)
  pricing: {
    transcribe: parseInt(process.env.COST_TRANSCRIBE_PAISE) || 50,
    generateGroq: parseInt(process.env.COST_GENERATE_GROQ_PAISE) || 100,
    generateGemini: parseInt(process.env.COST_GENERATE_GEMINI_PAISE) || 50,
    minRecharge: parseInt(process.env.MIN_RECHARGE_PAISE) || 19900,
  },

  // Admin
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean),

  // Recharge tiers (paise)
  rechargeTiers: [
    { label: 'Starter', amountPaise: 19900, description: '~130 Q&A cycles' },
    { label: 'Standard', amountPaise: 29900, description: '~200 Q&A cycles' },
    { label: 'Pro', amountPaise: 49900, description: '~330 Q&A cycles' },
    { label: 'Power', amountPaise: 99900, description: '~660 Q&A cycles' },
  ],
};

module.exports = config;
