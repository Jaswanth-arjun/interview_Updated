// ─── Entry Point — API Server ────────────────────────────────
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const logger = require('./utils/logger');
const { AppError } = require('./utils/errors');
const { apiLimiter } = require('./middleware/rateLimit');

// Route Imports
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const profileRoutes = require('./routes/profile');
const aiRoutes = require('./routes/ai');
const adminRoutes = require('./routes/admin');
const razorpayService = require('./services/razorpayService');

const app = express();

// ─── Security Hardening ──────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: '*', // Allow all origins since it is loaded from dynamic Electron origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Request Logger
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream: { write: (message) => logger.info(message.trim()) }
}));

// ─── Razorpay Webhook Endpoint ───────────────────────────────
// Must be registered BEFORE express.json() to read raw request buffer
app.post(
  '/webhook/razorpay',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    try {
      const parsedBody = JSON.parse(req.body.toString());
      const result = await razorpayService.handleWebhook(parsedBody, signature);
      res.json(result);
    } catch (err) {
      logger.error('Razorpay Webhook Error:', err);
      res.status(err.statusCode || 400).json({
        success: false,
        error: err.message || 'Webhook processing failed'
      });
    }
  }
);

// General JSON and urlencoded parser
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Global Rate Limiter
app.use(apiLimiter);

// ─── Application Routes ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    time: new Date(),
    env: config.nodeEnv
  });
});

app.use('/auth', authRoutes);
app.use('/wallet', walletRoutes);
app.use('/profile', profileRoutes);
app.use('/ai', aiRoutes);
app.use('/admin', adminRoutes);

// ─── 404 Route handler ───────────────────────────────────────
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    error: `Cannot ${req.method} ${req.url} - Endpoint not found`,
    code: 'NOT_FOUND'
  });
});

// ─── Central Error Handler Middleware ────────────────────────
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational || false;

  logger.error(`${req.method} ${req.url} failed:`, err);

  res.status(statusCode).json({
    success: false,
    error: isOperational ? err.message : 'A server error occurred. Please try again.',
    code: err.code || 'INTERNAL_ERROR'
  });
});

// ─── Start Server ────────────────────────────────────────────
app.listen(config.port, () => {
  logger.info(`🚀 API Server running in ${config.nodeEnv} mode on port ${config.port}`);
});

module.exports = app;
