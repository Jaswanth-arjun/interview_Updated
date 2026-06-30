// ─── Device Fingerprint & Binding Service ───────────────────
const { PrismaClient } = require('@prisma/client');
const { DeviceBindingError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * Validates device binding. 
 * Enforces: One device can only be bound to ONE user account.
 * Enforces: One user account can only run on their BOUND device.
 */
async function validateOrBindDevice(userId, signals) {
  const { biosUuid, cpuId, diskSerial, machineGuid, platform } = signals;
  const { generateDeviceFingerprint } = require('../utils/crypto');
  
  const fingerprint = generateDeviceFingerprint(signals);
  logger.debug(`Validating device binding. Hash: ${fingerprint} for user ${userId}`);

  // 1. Fetch user to see if they already have a bound device
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { deviceFingerprint: true, email: true }
  });

  if (!user) {
    throw new ValidationError('User not found');
  }

  // 2. Check if user is already bound to a different device
  if (user.deviceFingerprint && user.deviceFingerprint !== fingerprint) {
    throw new DeviceBindingError(
      `This account is linked to another computer. Contact support to transfer licenses.`
    );
  }

  // 3. Check if this device is already claimed by another user
  const boundDevice = await prisma.deviceRegistry.findUnique({
    where: { fingerprint }
  });

  if (boundDevice && boundDevice.userId && boundDevice.userId !== userId) {
    throw new DeviceBindingError(
      `This computer has already registered a different account. Only 1 account per device is allowed.`
    );
  }

  // 4. Bind device to user if not already bound
  if (!user.deviceFingerprint) {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { deviceFingerprint: fingerprint }
      }),
      prisma.deviceRegistry.upsert({
        where: { fingerprint },
        create: {
          fingerprint,
          userId,
          biosUuid,
          cpuId,
          diskSerial,
          machineGuid,
          platform,
          claimedAt: new Date()
        },
        update: {
          userId,
          claimedAt: new Date()
        }
      })
    ]);
    logger.info(`Successfully bound device fingerprint ${fingerprint} to user: ${user.email}`);
  }

  return fingerprint;
}

/**
 * Reset device binding (Admin only).
 */
async function resetDeviceBinding(userId, adminEmail) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deviceFingerprint: true }
  });

  if (!user) {
    throw new ValidationError('User not found');
  }

  if (!user.deviceFingerprint) {
    return { success: true, message: 'User is not bound to any device.' };
  }

  const oldFprint = user.deviceFingerprint;

  await prisma.$transaction([
    // Remove fingerprint from User
    prisma.user.update({
      where: { id: userId },
      data: { deviceFingerprint: null }
    }),
    // Release device registry association
    prisma.deviceRegistry.updateMany({
      where: { userId },
      data: { userId: null }
    }),
    // Log admin audit
    prisma.adminAuditLog.create({
      data: {
        adminEmail,
        action: 'reset_device',
        targetId: userId,
        details: `Reset device fingerprint binding. Released fingerprint: ${oldFprint}`
      }
    })
  ]);

  logger.info(`Admin ${adminEmail} reset device binding for user ${user.email} (old fingerprint: ${oldFprint})`);
  return { success: true, oldFingerprint: oldFprint };
}

module.exports = {
  validateOrBindDevice,
  resetDeviceBinding
};
