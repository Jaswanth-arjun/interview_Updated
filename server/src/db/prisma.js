// ─── Shared Prisma Client with Auto-Reconnect ────────────────
// Render Postgres terminates idle connections. Without this, the
// first query after an idle period fails with
// "Server has closed the connection" (e.g. during Google sign-in).
// This wrapper detects stale/dead connections, forces a reconnect
// and transparently retries the failed query.
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: [
    { emit: 'stdout', level: 'error' },
    { emit: 'stdout', level: 'warn' },
  ],
});

const MAX_RETRIES = 2;

function isStaleConnectionError(err) {
  if (!err) return false;
  // PrismaClientInitializationError covers "Server has closed the
  // connection", "Can't reach database server", idle-kill etc.
  if (err.name === 'PrismaClientInitializationError') return true;
  const msg = String(err.message || '');
  return /closed the connection|connection terminated|can't reach database|ECONNRESET|EPIPE|ETIMEDOUT|57P01|08006|08003/i.test(msg);
}

async function runWithRetry(operation, attempt = 0) {
  try {
    return await operation();
  } catch (err) {
    if (attempt < MAX_RETRIES && isStaleConnectionError(err)) {
      logger.warn(`DB connection lost, reconnecting and retrying (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
      try { await prisma.$disconnect(); } catch {}
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return runWithRetry(operation, attempt + 1);
    }
    throw err;
  }
}

// Proxy: transparently wraps every model delegate method (findUnique,
// create, update, ...) and low-level helpers ($queryRaw, $executeRaw)
// with the reconnect/retry logic.
const retriedPrisma = new Proxy(prisma, {
  get(target, prop) {
    const value = target[prop];

    if (typeof value === 'function') {
      // $connect / $disconnect / $on / $use / $transaction etc. are called directly
      if (typeof prop !== 'string' || prop.startsWith('$')) {
        return value.bind(target);
      }
      return (...args) => runWithRetry(() => value.apply(target, args));
    }

    if (value && typeof value === 'object') {
      // Model delegate (user, session, deviceRegistry, ...) — wrap each method
      return new Proxy(value, {
        get(modelTarget, modelProp) {
          const modelValue = modelTarget[modelProp];
          if (typeof modelValue === 'function') {
            return (...args) => runWithRetry(() => modelValue.apply(modelTarget, args));
          }
          return modelValue;
        },
      });
    }

    return value;
  },
});

module.exports = retriedPrisma;
