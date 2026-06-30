// ─── Metering & Usage Tracking Service ────────────────────────
const { PrismaClient } = require('@prisma/client');
const config = require('../config');
const walletService = require('./walletService');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * Log AI transaction details and deduct wallet balance.
 */
async function logAndMeterUsage(userId, {
  requestType,    // 'transcribe' or 'generate'
  provider,       // 'groq', 'gemini', 'omniroute'
  model,
  promptTokens = 0,
  completionTokens = 0,
  audioDurationMs = 0,
  costPaise = 0,
  latencyMs = 0,
  success = true,
  errorMessage = null,
  question = null,
  isTrial = false
}) {
  try {
    // 1. Deduct cost from wallet balance if not a free trial request
    if (success && !isTrial && costPaise > 0) {
      await walletService.deductCredits(userId, costPaise, false);
    } else if (success && isTrial) {
      await walletService.deductCredits(userId, 0, true);
    }

    // 2. Write record to DB
    const log = await prisma.usageLog.create({
      data: {
        userId,
        requestType,
        provider,
        model,
        promptTokens,
        completionTokens,
        audioDurationMs,
        costPaise: success ? costPaise : 0, // only charge if successful
        latencyMs,
        success,
        errorMessage,
        question: question ? question.substring(0, 255) : null
      }
    });

    logger.debug(`Metered usage logged: ID ${log.id} for user ${userId} (${requestType})`);
    return log;
  } catch (err) {
    logger.error(`Failed metering/logging usage for user ${userId}:`, err);
    // Don't crash the request if database logging fails, but alert
    return null;
  }
}

/**
 * Fetch usage stats for User Dashboard.
 */
async function getUserUsageStats(userId) {
  const stats = await prisma.usageLog.aggregate({
    where: { userId },
    _count: { id: true },
    _sum: {
      costPaise: true,
      latencyMs: true,
      promptTokens: true,
      completionTokens: true
    }
  });

  const recentRequests = await prisma.usageLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      requestType: true,
      provider: true,
      model: true,
      costPaise: true,
      latencyMs: true,
      success: true,
      createdAt: true
    }
  });

  return {
    totalRequests: stats._count.id || 0,
    totalSpentPaise: stats._sum.costPaise || 0,
    averageLatencyMs: stats._count.id ? Math.round(stats._sum.latencyMs / stats._count.id) : 0,
    totalTokens: (stats._sum.promptTokens || 0) + (stats._sum.completionTokens || 0),
    recentRequests
  };
}

module.exports = {
  logAndMeterUsage,
  getUserUsageStats
};
