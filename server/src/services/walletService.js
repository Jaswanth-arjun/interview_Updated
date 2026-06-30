// ─── Wallet Service ──────────────────────────────────────────
const { PrismaClient } = require('@prisma/client');
const { InsufficientBalanceError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');
const config = require('../config');

const prisma = new PrismaClient();

/**
 * Get wallet balance for a user.
 */
async function getBalance(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      walletBalancePaise: true,
      tier: true,
      freeTrialRequests: true,
      freeTrialUsed: true,
    },
  });
  return user;
}

/**
 * Check if user can make a request (trial or paid).
 * Returns { allowed, isTrial, costPaise, reason }
 */
async function checkQuota(userId, requestType) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      tier: true,
      walletBalancePaise: true,
      freeTrialRequests: true,
      freeTrialUsed: true,
      isBlocked: true,
    },
  });

  if (!user) {
    return { allowed: false, reason: 'User not found' };
  }

  if (user.isBlocked) {
    return { allowed: false, reason: 'Account suspended' };
  }

  // Trial users
  if (user.tier === 'trial') {
    if (user.freeTrialUsed < user.freeTrialRequests) {
      return { allowed: true, isTrial: true, costPaise: 0 };
    }
    return {
      allowed: false,
      reason: 'Your free trial has ended. Recharge your wallet to continue.',
    };
  }

  // Paid users (free tier with balance, or pro)
  const costPaise = requestType === 'transcribe'
    ? config.pricing.transcribe
    : config.pricing.generateGroq;

  if (user.walletBalancePaise >= costPaise) {
    return { allowed: true, isTrial: false, costPaise };
  }

  return {
    allowed: false,
    reason: `Insufficient wallet balance (₹${(user.walletBalancePaise / 100).toFixed(2)} remaining). Please recharge.`,
  };
}

/**
 * Deduct credits from user wallet after a successful AI request.
 */
async function deductCredits(userId, costPaise, isTrial = false) {
  if (isTrial) {
    // Increment trial usage counter
    await prisma.user.update({
      where: { id: userId },
      data: {
        freeTrialUsed: { increment: 1 },
      },
    });
    logger.debug(`Trial request consumed for user ${userId}`);
    return;
  }

  if (costPaise <= 0) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { walletBalancePaise: true },
  });

  if (!user || user.walletBalancePaise < costPaise) {
    throw new InsufficientBalanceError();
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      walletBalancePaise: { decrement: costPaise },
      // Auto-upgrade tier to 'pro' when user has paid balance
      tier: 'pro',
    },
  });

  logger.debug(`Deducted ₹${(costPaise / 100).toFixed(2)} from user ${userId}`);
}

/**
 * Add credits to user wallet (only called after verified payment).
 */
async function addCredits(userId, amountPaise) {
  if (amountPaise <= 0) {
    throw new ValidationError('Invalid credit amount');
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      walletBalancePaise: { increment: amountPaise },
      tier: 'pro', // Upgrade to pro on first payment
    },
  });

  logger.info(`Added ₹${(amountPaise / 100).toFixed(2)} to wallet of user ${userId}. New balance: ₹${(user.walletBalancePaise / 100).toFixed(2)}`);

  return user.walletBalancePaise;
}

/**
 * Get recharge tiers available for display.
 */
function getRechargeTiers() {
  return config.rechargeTiers.map(t => ({
    label: t.label,
    amountRupees: t.amountPaise / 100,
    amountPaise: t.amountPaise,
    description: t.description,
  }));
}

module.exports = {
  getBalance,
  checkQuota,
  deductCredits,
  addCredits,
  getRechargeTiers,
};
