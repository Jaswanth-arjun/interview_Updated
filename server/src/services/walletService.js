// â”€â”€â”€ Wallet Service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const { InsufficientBalanceError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');
const config = require('../config');

const prisma = require('../db/prisma');

/**
 * Get wallet balance for a user.
 */
async function getBalance(userId) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        walletBalancePaise: true,
        tier: true,
        freeTrialRequests: true,
        freeTrialUsed: true,
      },
    });
    if (user) return user;
  } catch (err) {
    logger.warn(`getBalance DB query failed (${err.message}). Checking memory fallback.`);
  }

  const { getMemoryUser } = require('./authService');
  const memUser = getMemoryUser(userId);
  if (memUser) {
    return {
      walletBalancePaise: memUser.walletBalancePaise,
      tier: memUser.tier,
      freeTrialRequests: memUser.freeTrialRequests,
      freeTrialUsed: memUser.freeTrialUsed,
    };
  }
  return null;
}

/**
 * Check if user can make a request (trial or paid).
 * Returns { allowed, isTrial, costPaise, reason }
 */
async function checkQuota(userId, requestType) {
  let user = null;
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        tier: true,
        walletBalancePaise: true,
        freeTrialRequests: true,
        freeTrialUsed: true,
        isBlocked: true,
        isAdmin: true,
      },
    });
  } catch (err) {
    logger.warn(`checkQuota DB query failed (${err.message}). Checking memory fallback.`);
  }

  if (!user) {
    const { getMemoryUser } = require('./authService');
    user = getMemoryUser(userId);
  }

  if (!user) {
    return { allowed: false, reason: 'User not found' };
  }

  if (user.isBlocked) {
    return { allowed: false, reason: 'Account suspended' };
  }

  // Admin/Developer Bypass: Unlimited free PRO-tier access
  if (user.isAdmin || config.adminEmails.includes(user.email)) {
    return { allowed: true, isTrial: false, costPaise: 0 };
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
  try {
    const { getMemoryUser, setMemoryUser } = require('./authService');
    const memUser = getMemoryUser(userId);
    if (memUser && (memUser.isAdmin || config.adminEmails.includes(memUser.email))) {
      return; // Admins have unlimited free access
    }

    if (isTrial) {
      try {
        await prisma.user.update({
          where: { id: userId },
          data: {
            freeTrialUsed: { increment: 1 },
          },
        });
      } catch {}
      if (memUser) {
        memUser.freeTrialUsed = (memUser.freeTrialUsed || 0) + 1;
        setMemoryUser(userId, memUser);
      }
      logger.debug(`Trial request consumed for user ${userId}`);
      return;
    }

    if (costPaise <= 0) return;

    let user = null;
    try {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: { walletBalancePaise: true, isAdmin: true, email: true },
      });
    } catch {}

    if (!user) user = memUser;

    if (user && (user.isAdmin || config.adminEmails.includes(user.email))) {
      return; // Admin bypass
    }

    if (!user || (user.walletBalancePaise || 0) < costPaise) {
      throw new InsufficientBalanceError();
    }

    try {
      await prisma.user.update({
        where: { id: userId },
        data: {
          walletBalancePaise: { decrement: costPaise },
          tier: 'pro',
        },
      });
    } catch {}

    if (memUser) {
      memUser.walletBalancePaise = Math.max(0, (memUser.walletBalancePaise || 0) - costPaise);
      setMemoryUser(userId, memUser);
    }

    logger.debug(`Deducted ₹${(costPaise / 100).toFixed(2)} from user ${userId}`);
    return;
  } catch (err) {
    if (err instanceof InsufficientBalanceError) throw err;
    logger.warn(`deductCredits warning: ${err.message}`);
  }
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

  logger.info(`Added â‚¹${(amountPaise / 100).toFixed(2)} to wallet of user ${userId}. New balance: â‚¹${(user.walletBalancePaise / 100).toFixed(2)}`);

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
