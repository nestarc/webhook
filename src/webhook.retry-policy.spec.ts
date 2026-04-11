import { WebhookRetryPolicy } from './webhook.retry-policy';
import { DEFAULT_BACKOFF_SCHEDULE } from './webhook.constants';

describe('WebhookRetryPolicy', () => {
  it('should follow the backoff schedule without jitter', () => {
    const policy = new WebhookRetryPolicy({ delivery: { jitter: false } });

    for (let i = 0; i < DEFAULT_BACKOFF_SCHEDULE.length; i++) {
      const next = policy.nextAttemptAt(i + 1);
      const delayMs = next.getTime() - Date.now();
      const expectedMs = DEFAULT_BACKOFF_SCHEDULE[i] * 1000;
      expect(delayMs).toBeGreaterThan(expectedMs - 100);
      expect(delayMs).toBeLessThan(expectedMs + 100);
    }
  });

  it('should add jitter when enabled', () => {
    const policy = new WebhookRetryPolicy({ delivery: { jitter: true } });
    const results = Array.from({ length: 20 }, () => policy.nextAttemptAt(1).getTime());
    // With jitter, not all values should be identical
    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('should clamp to last schedule entry for high attempt counts', () => {
    const policy = new WebhookRetryPolicy({ delivery: { jitter: false } });
    const lastDelay = DEFAULT_BACKOFF_SCHEDULE[DEFAULT_BACKOFF_SCHEDULE.length - 1];

    const next = policy.nextAttemptAt(100);
    const delayMs = next.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(lastDelay * 1000 - 100);
    expect(delayMs).toBeLessThan(lastDelay * 1000 + 100);
  });

  it('should default to jitter enabled when not specified', () => {
    const policy = new WebhookRetryPolicy({});
    expect((policy as any).jitter).toBe(true);
  });
});
