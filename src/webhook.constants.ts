export const WEBHOOK_MODULE_OPTIONS = 'WEBHOOK_MODULE_OPTIONS';

/** Svix/Stripe-style exponential backoff schedule (seconds) */
export const DEFAULT_BACKOFF_SCHEDULE = [
  30,     // 30 seconds
  300,    // 5 minutes
  1800,   // 30 minutes
  7200,   // 2 hours
  86400,  // 24 hours
];

export const DEFAULT_DELIVERY_TIMEOUT = 10_000;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_JITTER_FACTOR = 0.1;

export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES = 60;

export const DEFAULT_POLLING_INTERVAL = 5_000;
export const DEFAULT_POLLING_BATCH_SIZE = 50;

export const RESPONSE_BODY_MAX_LENGTH = 1024;
