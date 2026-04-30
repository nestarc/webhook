export const WEBHOOK_MODULE_OPTIONS = 'WEBHOOK_MODULE_OPTIONS';

export const WEBHOOK_EVENT_REPOSITORY = 'WEBHOOK_EVENT_REPOSITORY';
export const WEBHOOK_ENDPOINT_REPOSITORY = 'WEBHOOK_ENDPOINT_REPOSITORY';
export const WEBHOOK_DELIVERY_REPOSITORY = 'WEBHOOK_DELIVERY_REPOSITORY';
export const WEBHOOK_HTTP_CLIENT = 'WEBHOOK_HTTP_CLIENT';
export const WEBHOOK_SECRET_VAULT = 'WEBHOOK_SECRET_VAULT';

const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

/** Svix/Stripe-style exponential backoff schedule (seconds) */
export const DEFAULT_BACKOFF_SCHEDULE = Object.freeze([
  30,     // 30 seconds
  300,    // 5 minutes
  1800,   // 30 minutes
  7200,   // 2 hours
  86400,  // 24 hours
] as const);

export const DEFAULT_DELIVERY_TIMEOUT = 10_000;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_JITTER_FACTOR = 0.1;

export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES = 60;
export const ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED =
  'consecutive_failures_exceeded' as const;
export type EndpointDisabledReason =
  typeof ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED;

export const DEFAULT_POLLING_INTERVAL = 5_000;
export const DEFAULT_POLLING_BATCH_SIZE = 50;
export const DEFAULT_STALE_SENDING_MINUTES = 5;

/** Max JavaScript string length (UTF-16 code units) retained for response bodies. */
export const RESPONSE_BODY_MAX_LENGTH = 4096;
/** Mirrors RESPONSE_BODY_MAX_LENGTH for attempt logs; kept separate for future schema divergence. */
export const ATTEMPT_RESPONSE_BODY_MAX_LENGTH = RESPONSE_BODY_MAX_LENGTH;
export const DEFAULT_USER_AGENT = `@nestarc/webhook/${PACKAGE_VERSION}`;
