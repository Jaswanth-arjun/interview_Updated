// ─── Custom Error Classes ────────────────────────────────────

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTH_ERROR');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

class InsufficientBalanceError extends AppError {
  constructor(message = 'Insufficient wallet balance. Please recharge.') {
    super(message, 402, 'INSUFFICIENT_BALANCE');
  }
}

class DeviceBindingError extends AppError {
  constructor(message = 'Device binding conflict') {
    super(message, 409, 'DEVICE_CONFLICT');
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please slow down.') {
    super(message, 429, 'RATE_LIMITED');
  }
}

module.exports = {
  AppError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  InsufficientBalanceError,
  DeviceBindingError,
  RateLimitError,
};
