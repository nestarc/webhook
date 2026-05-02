# Early Delivery Failure Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add early delivery failure hooks for retry scheduling and endpoint degradation while preserving terminal-only `onDeliveryFailed` and active-to-inactive-only `onEndpointDisabled` semantics.

**Architecture:** Extend the public options surface first, then implement endpoint degraded signaling inside `WebhookCircuitBreaker` and retry-scheduled signaling inside `WebhookDeliveryWorker`. Hook calls stay fire-and-forget, delivery state transitions remain the source of truth, and dispatcher exceptions update the circuit breaker only after a failed attempt is persisted.

**Tech Stack:** TypeScript, NestJS providers, Jest unit tests, existing package barrel exports, README and changelog documentation.

---

## File Structure

- Modify `src/interfaces/webhook-options.interface.ts`
  - Adds `CircuitBreakerOptions.degradedThreshold`.
  - Adds `DeliveryRetryScheduledContext`.
  - Adds `EndpointDegradedContext`.
  - Adds `onDeliveryRetryScheduled` and `onEndpointDegraded` optional hooks.
- Modify `src/index.ts`
  - Re-exports the two new context types from the package root.
- Modify `src/interfaces/public-contract.spec.ts`
  - Compile-time contract coverage for the new options and root exports.
- Modify `src/webhook.circuit-breaker.ts`
  - Reads `degradedThreshold`.
  - Fires `onEndpointDegraded` at exact degraded threshold when the endpoint is still active.
  - Keeps existing disabled behavior.
  - Isolates degraded and disabled hook errors.
- Modify `src/webhook.circuit-breaker.spec.ts`
  - Adds degraded threshold and hook safety coverage.
- Modify `src/webhook.delivery-worker.ts`
  - Fires `onDeliveryRetryScheduled` only after `markRetry()` succeeds for retriable delivery failures.
  - Reuses structured failure metadata for retry and terminal hooks.
  - Updates the circuit breaker after persisted dispatcher exception failures.
- Modify `src/webhook.delivery-worker.spec.ts`
  - Adds retry-scheduled hook coverage and dispatcher-exception circuit breaker coverage.
- Modify `README.md`
  - Documents the new options and hook semantics.
- Modify `CHANGELOG.md`
  - Records the additive API and exception-path accounting fix.

---

### Task 1: Public API and Export Contract

**Files:**
- Modify: `src/interfaces/public-contract.spec.ts`
- Modify: `src/interfaces/webhook-options.interface.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing public contract tests**

In `src/interfaces/public-contract.spec.ts`, replace the existing options import:

```ts
import type {
  WebhookModuleAsyncOptions,
  WebhookModuleOptions,
} from './webhook-options.interface';
```

with:

```ts
import type {
  CircuitBreakerOptions,
  DeliveryRetryScheduledContext,
  EndpointDegradedContext,
  WebhookModuleAsyncOptions,
  WebhookModuleOptions,
} from './webhook-options.interface';
import type {
  DeliveryRetryScheduledContext as ExportedDeliveryRetryScheduledContext,
  EndpointDegradedContext as ExportedEndpointDegradedContext,
} from '../index';
```

Inside the existing `it('keeps runtime-only shapes reflected in exported types', ...)` test, after the `moduleOptions` block, insert:

```ts
    const circuitBreakerOptions: CircuitBreakerOptions = {
      failureThreshold: 5,
      degradedThreshold: 3,
      cooldownMinutes: 60,
    };

    const retryScheduledContext: DeliveryRetryScheduledContext = {
      deliveryId: 'del-1',
      endpointId: 'ep-1',
      eventId: 'evt-1',
      tenantId: null,
      attempts: 2,
      maxAttempts: 5,
      nextAttemptAt: new Date(),
      lastError: 'receiver unavailable',
      responseStatus: 503,
      failureKind: 'http_error',
    };

    const endpointDegradedContext: EndpointDegradedContext = {
      endpointId: 'ep-1',
      tenantId: null,
      url: 'https://example.com/hook',
      reason: 'consecutive_failures_degraded',
      consecutiveFailures: 3,
      degradedThreshold: 3,
      failureThreshold: 5,
    };

    const moduleOptionsWithHooks: WebhookModuleOptions = {
      circuitBreaker: circuitBreakerOptions,
      onDeliveryRetryScheduled: (context) => {
        retryScheduledContext.nextAttemptAt = context.nextAttemptAt;
      },
      onEndpointDegraded: (context) => {
        endpointDegradedContext.consecutiveFailures =
          context.consecutiveFailures;
      },
    };

    const exportedRetryContext: ExportedDeliveryRetryScheduledContext =
      retryScheduledContext;
    const exportedDegradedContext: ExportedEndpointDegradedContext =
      endpointDegradedContext;

    // @ts-expect-error DeliveryRetryScheduledContext requires nextAttemptAt.
    const retryContextWithoutNextAttemptAt: DeliveryRetryScheduledContext = {
      deliveryId: 'del-1',
      endpointId: 'ep-1',
      eventId: 'evt-1',
      tenantId: null,
      attempts: 2,
      maxAttempts: 5,
      lastError: 'receiver unavailable',
      responseStatus: 503,
    };

    // @ts-expect-error EndpointDegradedContext requires degradedThreshold.
    const degradedContextWithoutDegradedThreshold: EndpointDegradedContext = {
      endpointId: 'ep-1',
      tenantId: null,
      url: 'https://example.com/hook',
      reason: 'consecutive_failures_degraded',
      consecutiveFailures: 3,
      failureThreshold: 5,
    };

    const degradedContextWithInvalidReason: EndpointDegradedContext = {
      endpointId: 'ep-1',
      tenantId: null,
      url: 'https://example.com/hook',
      // @ts-expect-error EndpointDegradedContext has one supported reason.
      reason: 'consecutive_failures_exceeded',
      consecutiveFailures: 3,
      degradedThreshold: 3,
      failureThreshold: 5,
    };
```

Add the new variables to the final `expect({ ... }).toBeDefined()` object:

```ts
      circuitBreakerOptions,
      retryScheduledContext,
      endpointDegradedContext,
      moduleOptionsWithHooks,
      exportedRetryContext,
      exportedDegradedContext,
      retryContextWithoutNextAttemptAt,
      degradedContextWithoutDegradedThreshold,
      degradedContextWithInvalidReason,
```

- [ ] **Step 2: Run the public contract test and verify RED**

Run:

```bash
npm test -- src/interfaces/public-contract.spec.ts
```

Expected: FAIL with TypeScript errors that `CircuitBreakerOptions.degradedThreshold`, `DeliveryRetryScheduledContext`, `EndpointDegradedContext`, `onDeliveryRetryScheduled`, `onEndpointDegraded`, and root exports do not exist.

- [ ] **Step 3: Add public option and context types**

In `src/interfaces/webhook-options.interface.ts`, replace `CircuitBreakerOptions` with:

```ts
export interface CircuitBreakerOptions {
  failureThreshold?: number;
  degradedThreshold?: number;
  cooldownMinutes?: number;
}
```

After `DeliveryFailedContext`, insert:

```ts
export interface DeliveryRetryScheduledContext {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  /** Null when the endpoint is not scoped to a tenant. */
  tenantId: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  responseStatus: number | null;

  /** High-level classification for the failed attempt that scheduled the retry. */
  failureKind?: DeliveryFailureKind;
  /** Set only when `failureKind === 'url_validation'` — structured reason from `WebhookUrlValidationError`. */
  validationReason?: WebhookUrlValidationReason;
  /** Set only when `failureKind === 'url_validation'` — URL that triggered validation failure. */
  validationUrl?: string;
  /** Set only when `failureKind === 'url_validation'` and DNS resolution was involved. */
  resolvedIp?: string;
}
```

After `EndpointDisabledContext`, insert:

```ts
export interface EndpointDegradedContext {
  endpointId: string;
  /** Null when the endpoint is not scoped to a tenant. */
  tenantId: string | null;
  url: string;
  reason: 'consecutive_failures_degraded';
  consecutiveFailures: number;
  degradedThreshold: number;
  failureThreshold: number;
}
```

In `WebhookModuleOptions`, after `onDeliveryFailed`, insert:

```ts
  /** Called after a retriable failed attempt is persisted with a next attempt time. Fire-and-forget — errors are logged, not propagated. */
  onDeliveryRetryScheduled?: (
    context: DeliveryRetryScheduledContext,
  ) => void | Promise<void>;
```

In `WebhookModuleOptions`, before or after `onEndpointDisabled`, insert:

```ts
  /** Called when consecutive failures reach the configured degraded threshold before endpoint disablement. Fire-and-forget — errors are logged, not propagated. */
  onEndpointDegraded?: (context: EndpointDegradedContext) => void | Promise<void>;
```

- [ ] **Step 4: Export new context types**

In `src/index.ts`, add the new context types to the option type export block:

```ts
  DeliveryRetryScheduledContext,
  EndpointDisabledContext,
  EndpointDegradedContext,
```

Keep the existing `DeliveryFailedContext`, `DeliveryFailureKind`, and `EndpointDisabledContext` exports.

- [ ] **Step 5: Run the public contract test and verify GREEN**

Run:

```bash
npm test -- src/interfaces/public-contract.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the public API surface**

```bash
git add src/interfaces/webhook-options.interface.ts src/index.ts src/interfaces/public-contract.spec.ts
git commit -m "feat: expose early failure hook contracts"
```

---

### Task 2: Endpoint Degraded Circuit Breaker Hook

**Files:**
- Modify: `src/webhook.circuit-breaker.spec.ts`
- Modify: `src/webhook.circuit-breaker.ts`

- [ ] **Step 1: Write failing degraded hook tests**

At the top of `src/webhook.circuit-breaker.spec.ts`, replace the imports with:

```ts
import { Logger } from '@nestjs/common';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';
import { ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED } from './webhook.constants';
import { EndpointRecord } from './interfaces/webhook-endpoint.interface';
```

Add this helper above `createMockEndpointRepo()`:

```ts
function makeEndpointRecord(
  overrides: Partial<EndpointRecord> = {},
): EndpointRecord {
  return {
    id: 'ep-1',
    url: 'https://example.com/hook',
    events: ['order.created'],
    active: true,
    description: null,
    metadata: null,
    tenantId: 'tenant-1',
    consecutiveFailures: 0,
    disabledAt: null,
    disabledReason: null,
    previousSecretExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
```

In `createMockEndpointRepo()`, add `getEndpoint` and include it in the `Pick` type:

```ts
    getEndpoint: jest.fn().mockResolvedValue(makeEndpointRecord()),
```

The returned mock type should include:

```ts
Pick<
  WebhookEndpointRepository,
  | 'getEndpoint'
  | 'resetFailures'
  | 'incrementFailures'
  | 'disableEndpoint'
  | 'recoverEligibleEndpoints'
>
```

Inside `describe('WebhookCircuitBreaker', ...)`, after the `let` declarations, add:

```ts
  afterEach(() => {
    jest.restoreAllMocks();
  });
```

Add this `describe` block before `describe('onEndpointDisabled callback', ...)`:

```ts
  describe('onEndpointDegraded callback', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('should not call onEndpointDegraded when degradedThreshold is omitted', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 5, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);

      await cbWithHook.afterDelivery('ep-1', false, {
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
      });
      await flush();

      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(endpointRepo.getEndpoint).not.toHaveBeenCalled();
    });

    it('should call onEndpointDegraded at the exact degraded threshold', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: {
            degradedThreshold: 3,
            failureThreshold: 5,
            cooldownMinutes: 30,
          },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);
      endpointRepo.getEndpoint.mockResolvedValueOnce(
        makeEndpointRecord({ active: true }),
      );

      await cbWithHook.afterDelivery('ep-1', false, {
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
      });
      await flush();

      expect(endpointRepo.getEndpoint).toHaveBeenCalledWith('ep-1');
      expect(onEndpointDegraded).toHaveBeenCalledTimes(1);
      expect(onEndpointDegraded).toHaveBeenCalledWith({
        endpointId: 'ep-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
        reason: 'consecutive_failures_degraded',
        consecutiveFailures: 3,
        degradedThreshold: 3,
        failureThreshold: 5,
      });
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });

    it('should not call onEndpointDegraded above the degraded threshold', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: {
            degradedThreshold: 3,
            failureThreshold: 5,
            cooldownMinutes: 30,
          },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(4);

      await cbWithHook.afterDelivery('ep-1', false, {
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
      });
      await flush();

      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(endpointRepo.getEndpoint).not.toHaveBeenCalled();
    });

    it('should not call onEndpointDegraded when degradedThreshold is not below failureThreshold', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: {
            degradedThreshold: 5,
            failureThreshold: 5,
            cooldownMinutes: 30,
          },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(5);

      await cbWithHook.afterDelivery('ep-1', false, {
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
      });
      await flush();

      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(endpointRepo.getEndpoint).not.toHaveBeenCalled();
      expect(endpointRepo.disableEndpoint).toHaveBeenCalled();
    });

    it('should not call onEndpointDegraded when the endpoint is inactive', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: {
            degradedThreshold: 3,
            failureThreshold: 5,
            cooldownMinutes: 30,
          },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);
      endpointRepo.getEndpoint.mockResolvedValueOnce(
        makeEndpointRecord({ active: false }),
      );

      await cbWithHook.afterDelivery('ep-1', false, {
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
      });
      await flush();

      expect(onEndpointDegraded).not.toHaveBeenCalled();
    });

    it('should not call onEndpointDegraded when the endpoint is missing', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: {
            degradedThreshold: 3,
            failureThreshold: 5,
            cooldownMinutes: 30,
          },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);
      endpointRepo.getEndpoint.mockResolvedValueOnce(null);

      await cbWithHook.afterDelivery('ep-1', false, {
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
      });
      await flush();

      expect(onEndpointDegraded).not.toHaveBeenCalled();
    });

    it('should log rejected onEndpointDegraded callbacks without rejecting afterDelivery', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const onEndpointDegraded = jest
        .fn()
        .mockRejectedValue(new Error('callback boom'));
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: {
            degradedThreshold: 3,
            failureThreshold: 5,
            cooldownMinutes: 30,
          },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);
      endpointRepo.getEndpoint.mockResolvedValueOnce(
        makeEndpointRecord({ active: true }),
      );

      await expect(
        cbWithHook.afterDelivery('ep-1', false, {
          tenantId: 'tenant-1',
          url: 'https://example.com/hook',
        }),
      ).resolves.toBeUndefined();
      await flush();

      expect(onEndpointDegraded).toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        'onEndpointDegraded callback error: callback boom',
        expect.any(String),
      );
    });

    it('should log synchronous onEndpointDegraded throws without rejecting afterDelivery', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const onEndpointDegraded = jest.fn(() => {
        throw new Error('sync callback boom');
      });
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: {
            degradedThreshold: 3,
            failureThreshold: 5,
            cooldownMinutes: 30,
          },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);
      endpointRepo.getEndpoint.mockResolvedValueOnce(
        makeEndpointRecord({ active: true }),
      );

      await expect(
        cbWithHook.afterDelivery('ep-1', false, {
          tenantId: 'tenant-1',
          url: 'https://example.com/hook',
        }),
      ).resolves.toBeUndefined();

      expect(onEndpointDegraded).toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        'onEndpointDegraded callback error: sync callback boom',
        expect.any(String),
      );
    });
  });
```

- [ ] **Step 2: Run the circuit breaker tests and verify RED**

Run:

```bash
npm test -- src/webhook.circuit-breaker.spec.ts
```

Expected: FAIL because `onEndpointDegraded`, `degradedThreshold`, `getEndpoint` calls, and degraded hook behavior do not exist yet.

- [ ] **Step 3: Implement degraded threshold and hook safety**

In `src/webhook.circuit-breaker.ts`, add this private field:

```ts
  private readonly degradedThreshold: number | undefined;
```

In the constructor, after `failureThreshold` is assigned, add:

```ts
    this.degradedThreshold = options.circuitBreaker?.degradedThreshold;
```

Replace the body of `afterDelivery()` with:

```ts
    if (success) {
      await this.endpointRepo.resetFailures(endpointId);
      return;
    }

    const failures = await this.endpointRepo.incrementFailures(endpointId);
    await this.maybeFireEndpointDegradedHook(endpointId, failures, meta);

    if (failures >= this.failureThreshold) {
      const disabled = await this.endpointRepo.disableEndpoint(
        endpointId,
        ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
      );
      if (!disabled) return;

      this.logger.warn(
        `Endpoint ${endpointId} disabled: ${ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED} (threshold=${this.failureThreshold})`,
      );
      // Fire only on active->inactive transition to prevent duplicate notifications
      // and still notify if a prior disable attempt failed at the exact threshold.
      this.fireEndpointDisabledHook(endpointId, failures, meta);
    }
```

Add these private methods before `recoverEligibleEndpoints()`:

```ts
  private async maybeFireEndpointDegradedHook(
    endpointId: string,
    failures: number,
    meta: DeliveryEndpointMeta,
  ): Promise<void> {
    const degradedThreshold = this.degradedThreshold;
    if (degradedThreshold === undefined) return;
    if (degradedThreshold >= this.failureThreshold) return;
    if (failures !== degradedThreshold) return;

    const endpoint = await this.endpointRepo.getEndpoint(endpointId);
    if (!endpoint?.active) return;

    this.fireEndpointDegradedHook(
      endpointId,
      failures,
      degradedThreshold,
      meta,
    );
  }

  private fireEndpointDegradedHook(
    endpointId: string,
    failures: number,
    degradedThreshold: number,
    meta: DeliveryEndpointMeta,
  ): void {
    if (!this.options.onEndpointDegraded) return;

    try {
      void Promise.resolve(
        this.options.onEndpointDegraded({
          endpointId,
          tenantId: meta.tenantId,
          url: meta.url,
          reason: 'consecutive_failures_degraded',
          consecutiveFailures: failures,
          degradedThreshold,
          failureThreshold: this.failureThreshold,
        }),
      ).catch((hookError) => {
        this.logError('onEndpointDegraded callback error', hookError);
      });
    } catch (hookError) {
      this.logError('onEndpointDegraded callback error', hookError);
    }
  }

  private fireEndpointDisabledHook(
    endpointId: string,
    failures: number,
    meta: DeliveryEndpointMeta,
  ): void {
    if (!this.options.onEndpointDisabled) return;

    try {
      void Promise.resolve(
        this.options.onEndpointDisabled({
          endpointId,
          tenantId: meta.tenantId,
          url: meta.url,
          reason: ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
          consecutiveFailures: failures,
        }),
      ).catch((hookError) => {
        this.logError('onEndpointDisabled callback error', hookError);
      });
    } catch (hookError) {
      this.logError('onEndpointDisabled callback error', hookError);
    }
  }

  private logError(message: string, error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(`${message}: ${error.message}`, error.stack);
      return;
    }
    this.logger.error(`${message}: ${String(error)}`);
  }
```

- [ ] **Step 4: Run the circuit breaker tests and verify GREEN**

Run:

```bash
npm test -- src/webhook.circuit-breaker.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit circuit breaker behavior**

```bash
git add src/webhook.circuit-breaker.ts src/webhook.circuit-breaker.spec.ts
git commit -m "feat: add endpoint degraded hook"
```

---

### Task 3: Delivery Retry Scheduled Worker Hook

**Files:**
- Modify: `src/webhook.delivery-worker.spec.ts`
- Modify: `src/webhook.delivery-worker.ts`

- [ ] **Step 1: Write failing retry-scheduled hook tests**

In `src/webhook.delivery-worker.spec.ts`, add this `describe` block after `describe('onDeliveryFailed callback', ...)` or immediately before it:

```ts
  describe('onDeliveryRetryScheduled callback', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('should fire onDeliveryRetryScheduled after a retriable HTTP failure is persisted', async () => {
      const nextDate = new Date('2026-05-02T00:00:00.000Z');
      const onDeliveryRetryScheduled = jest.fn();
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: { batchSize: 10 },
          onDeliveryRetryScheduled,
          onDeliveryFailed,
        },
      );
      const result: DeliveryResult = {
        success: false,
        statusCode: 503,
        body: 'unavailable',
        latencyMs: 100,
        error: 'receiver unavailable',
      };
      const enriched = makeDelivery({
        id: 'd-retry-hook',
        endpointId: 'ep-retry-hook',
        attempts: 1,
        maxAttempts: 4,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(result);
      retryPolicy.nextAttemptAt.mockReturnValueOnce(nextDate);

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markRetry).toHaveBeenCalledWith(
        'd-retry-hook',
        2,
        nextDate,
        result,
      );
      expect(onDeliveryRetryScheduled).toHaveBeenCalledWith({
        deliveryId: 'd-retry-hook',
        endpointId: 'ep-retry-hook',
        eventId: 'evt-1',
        tenantId: 'tenant-1',
        attempts: 2,
        maxAttempts: 4,
        nextAttemptAt: nextDate,
        lastError: 'receiver unavailable',
        responseStatus: 503,
        failureKind: 'http_error',
      });
      expect(onDeliveryFailed).not.toHaveBeenCalled();
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-retry-hook',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
    });

    it('should not fire onDeliveryRetryScheduled on final HTTP failure', async () => {
      const onDeliveryRetryScheduled = jest.fn();
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: { batchSize: 10 },
          onDeliveryRetryScheduled,
          onDeliveryFailed,
        },
      );
      const enriched = makeDelivery({
        id: 'd-final-no-retry-hook',
        endpointId: 'ep-final-no-retry-hook',
        attempts: 2,
        maxAttempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
        'd-final-no-retry-hook',
        3,
        expect.objectContaining({ success: false }),
      );
      expect(onDeliveryRetryScheduled).not.toHaveBeenCalled();
      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-final-no-retry-hook',
          attempts: 3,
          failureKind: 'http_error',
        }),
      );
    });

    it('should not fire onDeliveryRetryScheduled for non-retryable HTTP failures', async () => {
      const onDeliveryRetryScheduled = jest.fn();
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: { batchSize: 10 },
          onDeliveryRetryScheduled,
          onDeliveryFailed,
        },
      );
      const result: DeliveryResult = {
        success: false,
        statusCode: 410,
        body: 'gone',
        latencyMs: 100,
      };
      const enriched = makeDelivery({
        id: 'd-gone-no-retry-hook',
        endpointId: 'ep-gone-no-retry-hook',
        attempts: 0,
        maxAttempts: 5,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(result);

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
        'd-gone-no-retry-hook',
        1,
        result,
      );
      expect(onDeliveryRetryScheduled).not.toHaveBeenCalled();
      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-gone-no-retry-hook',
          responseStatus: 410,
          failureKind: 'http_error',
        }),
      );
    });

    it('should fire onDeliveryRetryScheduled for retriable dispatcher exceptions', async () => {
      const nextDate = new Date('2026-05-02T00:01:00.000Z');
      const onDeliveryRetryScheduled = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({
        id: 'd-exception-retry-hook',
        endpointId: 'ep-exception-retry-hook',
        attempts: 0,
        maxAttempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      retryPolicy.nextAttemptAt.mockReturnValueOnce(nextDate);

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryRetryScheduled).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-exception-retry-hook',
          endpointId: 'ep-exception-retry-hook',
          attempts: 1,
          maxAttempts: 3,
          nextAttemptAt: nextDate,
          lastError: 'ECONNREFUSED',
          responseStatus: null,
          failureKind: 'dispatch_error',
        }),
      );
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-exception-retry-hook',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
    });

    it('should fire onDeliveryRetryScheduled for retriable URL validation exceptions', async () => {
      const nextDate = new Date('2026-05-02T00:02:00.000Z');
      const onDeliveryRetryScheduled = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({
        id: 'd-validation-retry-hook',
        endpointId: 'ep-validation-retry-hook',
        url: 'http://evil.nip.io/hook',
        attempts: 0,
        maxAttempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(
        new WebhookUrlValidationError(
          'Invalid webhook URL: "10.0.0.1" is a private address',
          'private',
          'http://evil.nip.io/hook',
          '10.0.0.1',
        ),
      );
      retryPolicy.nextAttemptAt.mockReturnValueOnce(nextDate);

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryRetryScheduled).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-validation-retry-hook',
          attempts: 1,
          nextAttemptAt: nextDate,
          lastError: expect.stringContaining('private address'),
          responseStatus: null,
          failureKind: 'url_validation',
          validationReason: 'private',
          validationUrl: 'http://evil.nip.io/hook',
          resolvedIp: '10.0.0.1',
        }),
      );
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-validation-retry-hook',
        false,
        { tenantId: 'tenant-1', url: 'http://evil.nip.io/hook' },
      );
    });

    it('should not fire onDeliveryRetryScheduled when markRetry fails', async () => {
      const onDeliveryRetryScheduled = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({
        id: 'd-mark-retry-fails',
        endpointId: 'ep-mark-retry-fails',
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());
      deliveryRepo.markRetry.mockRejectedValueOnce(new Error('db unavailable'));

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryRetryScheduled).not.toHaveBeenCalled();
    });
  });
```

In `describe('dispatch — edge cases', ...)`, add these two tests:

```ts
    it('should update circuit breaker after retriable dispatcher exception is persisted', async () => {
      const enriched = makeDelivery({
        id: 'd-exception-cb-retry',
        endpointId: 'ep-exception-cb-retry',
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('ECONNRESET'));

      await worker.poll();

      expect(deliveryRepo.markRetry).toHaveBeenCalled();
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-exception-cb-retry',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
    });

    it('should update circuit breaker after terminal dispatcher exception is persisted', async () => {
      const enriched = makeDelivery({
        id: 'd-exception-cb-failed',
        endpointId: 'ep-exception-cb-failed',
        attempts: 2,
        maxAttempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('timeout'));

      await worker.poll();

      expect(deliveryRepo.markFailed).toHaveBeenCalled();
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-exception-cb-failed',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
    });
```

- [ ] **Step 2: Run the worker tests and verify RED**

Run:

```bash
npm test -- src/webhook.delivery-worker.spec.ts
```

Expected: FAIL because `onDeliveryRetryScheduled` does not fire and dispatcher exceptions do not update the circuit breaker.

- [ ] **Step 3: Implement retry-scheduled hook and dispatcher exception accounting**

In `src/webhook.delivery-worker.ts`, replace `processDelivery()` with:

```ts
  private async processDelivery(delivery: PendingDelivery): Promise<void> {
    this.activeDeliveries++;
    let dispatchReturned = false;

    try {
      const result = await this.dispatcher.dispatch(delivery);
      dispatchReturned = true;
      const newAttempts = delivery.attempts + 1;

      // Persist delivery state — if this fails, catch resets to PENDING (safe)
      const retryable = isRetryableDeliveryResult(result);

      if (result.success) {
        await this.deliveryRepo.markSent(delivery.id, newAttempts, result);
      } else if (!retryable) {
        await this.deliveryRepo.markFailed(delivery.id, newAttempts, result);
        this.logger.warn(
          `Delivery ${delivery.id} failed with non-retryable HTTP status ${result.statusCode} (${newAttempts}/${delivery.maxAttempts})`,
        );
        this.fireDeliveryFailedHook(
          delivery,
          newAttempts,
          result.error ?? null,
          result.statusCode ?? null,
          this.classifyResultFailure(result),
        );
      } else if (newAttempts >= delivery.maxAttempts) {
        await this.deliveryRepo.markFailed(delivery.id, newAttempts, result);
        this.logger.warn(
          `Delivery ${delivery.id} exhausted retries (${newAttempts}/${delivery.maxAttempts})`,
        );
        this.fireDeliveryFailedHook(
          delivery,
          newAttempts,
          result.error ?? null,
          result.statusCode ?? null,
          this.classifyResultFailure(result),
        );
      } else {
        const nextAt = this.retryPolicy.nextAttemptAt(newAttempts);
        await this.deliveryRepo.markRetry(
          delivery.id,
          newAttempts,
          nextAt,
          result,
        );
        this.fireDeliveryRetryScheduledHook(
          delivery,
          newAttempts,
          nextAt,
          result.error ?? null,
          result.statusCode ?? null,
          this.classifyResultFailure(result),
        );
      }

      await this.updateCircuitBreakerAfterDelivery(
        delivery,
        result.success,
      );
    } catch (error) {
      this.logError(`Delivery ${delivery.id} processing error`, error);
      // Increment attempts and apply backoff — never reset without accounting
      try {
        const newAttempts = delivery.attempts + 1;
        const errorResult = {
          success: false as const,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
        const meta = this.classifyExceptionFailure(error, delivery);
        const dispatcherException = !dispatchReturned;

        if (newAttempts >= delivery.maxAttempts) {
          await this.deliveryRepo.markFailed(delivery.id, newAttempts, errorResult);
          this.logger.warn(
            `Delivery ${delivery.id} exhausted retries on exception (${newAttempts}/${delivery.maxAttempts})`,
          );
          this.fireDeliveryFailedHook(
            delivery,
            newAttempts,
            errorResult.error ?? null,
            null,
            meta,
          );
          if (dispatcherException) {
            await this.updateCircuitBreakerAfterDelivery(delivery, false);
          }
        } else {
          const nextAt = this.retryPolicy.nextAttemptAt(newAttempts);
          await this.deliveryRepo.markRetry(
            delivery.id,
            newAttempts,
            nextAt,
            errorResult,
          );
          if (dispatcherException) {
            this.fireDeliveryRetryScheduledHook(
              delivery,
              newAttempts,
              nextAt,
              errorResult.error ?? null,
              null,
              meta,
            );
            await this.updateCircuitBreakerAfterDelivery(delivery, false);
          }
        }
      } catch (fallbackError) {
        this.logError(
          `Delivery ${delivery.id} fallback error handling failed`,
          fallbackError,
        );
      }
    } finally {
      this.activeDeliveries--;
    }
  }
```

Add this helper after `processDelivery()`:

```ts
  private async updateCircuitBreakerAfterDelivery(
    delivery: PendingDelivery,
    success: boolean,
  ): Promise<void> {
    // Circuit breaker — failure here must NOT revert delivery state
    try {
      await this.circuitBreaker.afterDelivery(
        delivery.endpointId,
        success,
        { tenantId: delivery.tenantId, url: delivery.url },
      );
    } catch (cbError) {
      this.logError(
        `Circuit breaker update failed for ${delivery.endpointId}`,
        cbError,
      );
    }
  }
```

Add this hook helper before `fireDeliveryFailedHook()`:

```ts
  private fireDeliveryRetryScheduledHook(
    delivery: PendingDelivery,
    attempts: number,
    nextAttemptAt: Date,
    lastError: string | null,
    responseStatus: number | null,
    meta: DeliveryFailureMeta = {},
  ): void {
    if (!this.options.onDeliveryRetryScheduled) return;

    try {
      void Promise.resolve(
        this.options.onDeliveryRetryScheduled({
          deliveryId: delivery.id,
          endpointId: delivery.endpointId,
          eventId: delivery.eventId,
          tenantId: delivery.tenantId,
          attempts,
          maxAttempts: delivery.maxAttempts,
          nextAttemptAt,
          lastError,
          responseStatus,
          ...meta,
        }),
      ).catch((hookError) => {
        this.logError('onDeliveryRetryScheduled callback error', hookError);
      });
    } catch (hookError) {
      this.logError('onDeliveryRetryScheduled callback error', hookError);
    }
  }
```

Add this metadata helper before `classifyResultFailure()`:

```ts
  private classifyExceptionFailure(
    error: unknown,
    delivery: PendingDelivery,
  ): DeliveryFailureMeta {
    if (error instanceof WebhookUrlValidationError) {
      return {
        failureKind: 'url_validation',
        validationReason: error.reason,
        validationUrl: error.url ?? delivery.url,
        resolvedIp: error.resolvedIp,
      };
    }

    return { failureKind: 'dispatch_error' };
  }
```

- [ ] **Step 4: Add retry hook safety tests**

In `describe('onDeliveryRetryScheduled callback', ...)`, add:

```ts
    it('should log rejected retry hook callbacks without rejecting worker processing', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const onDeliveryRetryScheduled = jest
        .fn()
        .mockRejectedValue(new Error('callback boom'));
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({
        id: 'd-retry-hook-reject',
        endpointId: 'ep-retry-hook-reject',
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markRetry).toHaveBeenCalled();
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-retry-hook-reject',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
      expect(loggerError).toHaveBeenCalledWith(
        'onDeliveryRetryScheduled callback error: callback boom',
        expect.any(String),
      );
    });

    it('should log synchronous retry hook throws without retrying delivery state handling', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const onDeliveryRetryScheduled = jest.fn(() => {
        throw new Error('sync callback boom');
      });
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({
        id: 'd-retry-hook-sync',
        endpointId: 'ep-retry-hook-sync',
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();

      expect(deliveryRepo.markRetry).toHaveBeenCalledTimes(1);
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-retry-hook-sync',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
      expect(loggerError).toHaveBeenCalledWith(
        'onDeliveryRetryScheduled callback error: sync callback boom',
        expect.any(String),
      );
    });
```

- [ ] **Step 5: Run the worker tests and verify GREEN**

Run:

```bash
npm test -- src/webhook.delivery-worker.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit worker behavior**

```bash
git add src/webhook.delivery-worker.ts src/webhook.delivery-worker.spec.ts
git commit -m "feat: add delivery retry scheduled hook"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update README configuration table**

In `README.md`, in the configuration table, add this row after `circuitBreaker.failureThreshold`:

```md
| `circuitBreaker.degradedThreshold` | — | Consecutive failures before firing `onEndpointDegraded`. Disabled unless configured. Must be lower than `failureThreshold`. |
```

Add this row after `onDeliveryFailed`:

```md
| `onDeliveryRetryScheduled` | — | Fire-and-forget callback after a retriable failed attempt is persisted with `nextAttemptAt`. Receives `DeliveryRetryScheduledContext`. Does not fire for terminal failures. |
```

Add this row before `onEndpointDisabled`:

```md
| `onEndpointDegraded` | — | Fire-and-forget callback when consecutive failures reach `circuitBreaker.degradedThreshold` before endpoint disablement. Receives `EndpointDegradedContext`. |
```

- [ ] **Step 2: Update README hook behavior notes**

After the paragraph that begins `Retryable HTTP responses only trigger onDeliveryFailed`, add:

```md
`onDeliveryRetryScheduled` fires earlier, after a retryable failed attempt has been persisted with its next attempt time. It is intended for internal observability and includes the same failure classification fields as `DeliveryFailedContext`, plus `nextAttemptAt`.

`onEndpointDegraded` fires only when `circuitBreaker.degradedThreshold` is configured, the endpoint is still active, and the consecutive failure count exactly reaches that degraded threshold. It does not replace `onEndpointDisabled`, which still fires only when the endpoint transitions from active to inactive at `failureThreshold`.
```

- [ ] **Step 3: Update CHANGELOG**

In `CHANGELOG.md`, under `## [Unreleased]`, add an `### Added` section before `### Changed`:

```md
### Added

- `onDeliveryRetryScheduled` callback option and `DeliveryRetryScheduledContext` type for observing retriable failed attempts after retry state is persisted.
- `circuitBreaker.degradedThreshold`, `onEndpointDegraded`, and `EndpointDegradedContext` for observing endpoint degradation before circuit-breaker disablement.
```

Under `### Fixed`, add:

```md
- Dispatcher exceptions such as URL validation and URL parse failures now update circuit-breaker failure accounting after the failed attempt is persisted.
```

- [ ] **Step 4: Run docs-adjacent validation**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe early delivery failure hooks"
```

---

### Task 5: Full Verification

**Files:**
- Verify all modified files from Tasks 1-4.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
npm test -- src/interfaces/public-contract.spec.ts src/webhook.circuit-breaker.spec.ts src/webhook.delivery-worker.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run full unit test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS and `dist/index.d.ts` contains `DeliveryRetryScheduledContext`, `EndpointDegradedContext`, `degradedThreshold`, `onDeliveryRetryScheduled`, and `onEndpointDegraded`.

- [ ] **Step 4: Inspect package root type output**

Run:

```bash
rg -n "DeliveryRetryScheduledContext|EndpointDegradedContext|degradedThreshold|onDeliveryRetryScheduled|onEndpointDegraded" dist
```

Expected: matches in generated declaration files, including `dist/index.d.ts` and `dist/interfaces/webhook-options.interface.d.ts`.

- [ ] **Step 5: Check final git state**

Run:

```bash
git status --short
```

Expected: no unstaged or uncommitted changes after the planned commits.

---

## Self-Review

Spec coverage:

- Public API and root export requirements are covered by Task 1.
- `onDeliveryRetryScheduled` result and exception behavior is covered by Task 3.
- Exception-path circuit breaker accounting is covered by Task 3.
- `onEndpointDegraded` threshold, active check, and hook safety are covered by Task 2.
- README and changelog requirements are covered by Task 4.
- Build output and exported declaration verification are covered by Task 5.

Type consistency:

- The plan uses `DeliveryRetryScheduledContext`, `EndpointDegradedContext`, `CircuitBreakerOptions.degradedThreshold`, `onDeliveryRetryScheduled`, and `onEndpointDegraded` consistently across tests, implementation, docs, and verification.
- The degraded reason literal is always `'consecutive_failures_degraded'`.
- Retry failure metadata reuses existing `DeliveryFailureKind` values.

Scope check:

- The plan does not add database schema.
- The plan does not add repository methods.
- The plan does not alter retry policy or existing terminal hook semantics.
