// ─── Crypto Utilities ────────────────────────────────────────
const crypto = require('crypto');

/**
 * Generate a SHA-256 hash from multiple device signals.
 * Combines all non-empty signals into a single fingerprint.
 */
function generateDeviceFingerprint(signals) {
  const { biosUuid, cpuId, diskSerial, machineGuid, platform } = signals;
  const components = [biosUuid, cpuId, diskSerial, machineGuid, platform]
    .filter(Boolean)
    .map(s => s.trim().toLowerCase());

  if (components.length === 0) {
    throw new Error('No device signals provided for fingerprinting');
  }

  return crypto.createHash('sha256').update(components.join('|')).digest('hex');
}

/**
 * Generate a cryptographically secure random token.
 */
function generateSecureToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Generate a short unique ID for orders, etc.
 */
function generateShortId(prefix = '') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return prefix ? `${prefix}_${ts}${rand}` : `${ts}${rand}`;
}

module.exports = {
  generateDeviceFingerprint,
  generateSecureToken,
  generateShortId,
};
