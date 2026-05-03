# Worker Engine Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tunable worker delivery capacity, worker observer metrics, backlog diagnostics, and delivery hot-path indexes while preserving the current default polling behavior.

**Architecture:** Extend public contracts first, then update `WebhookDeliveryWorker` so `batchSize` controls claim size and `maxConcurrency` controls in-flight dispatches. Continuous drain mode stays opt-in, observer callbacks are best-effort, and backlog diagnostics live on the delivery repository port with a Prisma implementation.

**Tech Stack:** TypeScript, NestJS providers, Jest unit tests, Prisma raw SQL adapter, PostgreSQL migrations, README and changelog documentation.

---

## File Structure

- Modify `src/interfaces/webhook-options.interface.ts`
  - Adds worker capacity polling options.
  - Adds worker observer context and result types.
  - Adds `workerObserver` to `WebhookModuleOptions`.
- Modify `src/ports/webhook-delivery.repository.ts`
  - Adds `DeliveryBacklogSummary`.
  - Adds optional `getBacklogSummary()` to the repository contract.
- Modify `src/index.ts`
  - Re-exports new public worker observer and backlog types.
- Modify `src/interfaces/public-contract.spec.ts`
  - Adds compile-time coverage for new options, observer types, backlog summary, and root exports.
- Modify `src/webhook.delivery-worker.ts`
  - Normalizes new worker options with compatibility defaults.
  - Limits claims by available concurrency.
  - Tracks per-poll metrics.
  - Calls observer hooks safely.
  - Adds opt-in drain loops.
- Modify `src/webhook.delivery-worker.spec.ts`
  - Adds max concurrency, observer, drain, and stale recovery coverage.
- Modify `src/adapters/prisma-delivery.repository.ts`
  - Implements `getBacklogSummary()` using one aggregate SQL query.
- Modify `src/adapters/prisma-delivery.repository.spec.ts`
  - Tests backlog summary query aliases and default fallback shape.
- Modify `test/e2e/webhook.e2e-spec.ts`
  - Adds backlog summary behavior coverage against the test database.
- Modify `src/sql/create-webhook-tables.sql`
  - Adds partial indexes for runnable pending and stale sending scans.
- Create `src/sql/migrations/v0.12.0.sql`
  - Adds the same partial indexes for existing installations.
- Modify `README.md`
  - Documents the new polling options, observer contract, and backlog diagnostics.
- Modify `CHANGELOG.md`
  - Records the additive worker capacity API and SQL indexes under `Unreleased`.

---

### Task 1: Public Capacity And Observer Contracts

**Files:**
- Modify: `src/interfaces/public-contract.spec.ts`
- Modify: `src/interfaces/webhook-options.interface.ts`
- Modify: `src/ports/webhook-delivery.repository.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing public contract tests**

In `src/interfaces/public-contract.spec.ts`, replace the options import block:

```ts
import type {
  CircuitBreakerOptions,
  DeliveryRetryScheduledContext,
  EndpointDegradedContext,
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
  PollingOptions,
  WebhookDeliveryProcessingResult,
  WebhookModuleAsyncOptions,
  WebhookModuleOptions,
  WebhookPollContext,
  WebhookPollResult,
  WebhookWorkerObserver,
} from './webhook-options.interface';
```

Replace the root export import block:

```ts
import type {
  DeliveryRetryScheduledContext as ExportedDeliveryRetryScheduledContext,
  EndpointDegradedContext as ExportedEndpointDegradedContext,
} from '../index';
```

with:

```ts
import type {
  DeliveryBacklogSummary as ExportedDeliveryBacklogSummary,
  DeliveryRetryScheduledContext as ExportedDeliveryRetryScheduledContext,
  EndpointDegradedContext as ExportedEndpointDegradedContext,
  WebhookDeliveryProcessingResult as ExportedWebhookDeliveryProcessingResult,
  WebhookPollContext as ExportedWebhookPollContext,
  WebhookPollResult as ExportedWebhookPollResult,
  WebhookWorkerObserver as ExportedWebhookWorkerObserver,
} from '../index';
```

Replace the delivery repository import block:

```ts
import type {
  ClaimedDelivery,
  PendingDelivery,
  WebhookTransaction,
} from '../ports/webhook-delivery.repository';
```

with:

```ts
import type {
  ClaimedDelivery,
  DeliveryBacklogSummary,
  PendingDelivery,
  WebhookTransaction,
} from '../ports/webhook-delivery.repository';
```

Inside `it('keeps runtime-only shapes reflected in exported types', ...)`, after `moduleOptionsWithHooks`, insert:

```ts
    const pollingOptions: PollingOptions = {
      enabled: true,
      interval: 1_000,
      batchSize: 100,
      staleSendingMinutes: 5,
      maxConcurrency: 200,
      drainWhileBacklogged: true,
      maxDrainLoopsPerPoll: 10,
      drainLoopDelayMs: 5,
    };

    const pollContext: WebhookPollContext = {
      batchSize: 100,
      maxConcurrency: 200,
      drainWhileBacklogged: true,
      maxDrainLoopsPerPoll: 10,
      drainLoopDelayMs: 5,
      activeDeliveries: 0,
    };

    const pollResult: WebhookPollResult = {
      claimed: 4,
      enriched: 4,
      sent: 2,
      failed: 1,
      retried: 1,
      recoveredStale: 0,
      durationMs: 25,
      loops: 2,
    };

    const deliveryProcessingResult: WebhookDeliveryProcessingResult = {
      deliveryId: 'del-1',
      endpointId: 'ep-1',
      eventId: 'evt-1',
      tenantId: null,
      attempts: 1,
      maxAttempts: 3,
      status: 'retried',
      responseStatus: 503,
      lastError: 'receiver unavailable',
      latencyMs: 100,
      nextAttemptAt: new Date(),
      failureKind: 'http_error',
    };

    const backlogSummary: DeliveryBacklogSummary = {
      pendingCount: 3,
      sendingCount: 2,
      runnablePendingCount: 1,
      oldestPendingAgeMs: 12_000,
      oldestRunnableAgeMs: 12_000,
    };

    const workerObserver: WebhookWorkerObserver = {
      onPollStart: (context) => {
        pollContext.maxConcurrency = context.maxConcurrency;
      },
      onPollComplete: (result) => {
        pollResult.claimed = result.claimed;
      },
      onDeliveryComplete: (result) => {
        deliveryProcessingResult.status = result.status;
      },
      onPollError: (error) => {
        String(error);
      },
    };

    const moduleOptionsWithWorkerObserver: WebhookModuleOptions = {
      polling: pollingOptions,
      workerObserver,
    };

    const exportedPollContext: ExportedWebhookPollContext = pollContext;
    const exportedPollResult: ExportedWebhookPollResult = pollResult;
    const exportedDeliveryProcessingResult: ExportedWebhookDeliveryProcessingResult =
      deliveryProcessingResult;
    const exportedWorkerObserver: ExportedWebhookWorkerObserver = workerObserver;
    const exportedBacklogSummary: ExportedDeliveryBacklogSummary = backlogSummary;

    const pollingOptionsWithInvalidConcurrency: PollingOptions = {
      // @ts-expect-error maxConcurrency must be numeric.
      maxConcurrency: '200',
    };

    // @ts-expect-error WebhookPollResult requires loops.
    const pollResultWithoutLoops: WebhookPollResult = {
      claimed: 1,
      enriched: 1,
      sent: 1,
      failed: 0,
      retried: 0,
      recoveredStale: 0,
      durationMs: 10,
    };

    // @ts-expect-error DeliveryBacklogSummary requires runnablePendingCount.
    const backlogSummaryWithoutRunnable: DeliveryBacklogSummary = {
      pendingCount: 1,
      sendingCount: 0,
      oldestPendingAgeMs: 1_000,
      oldestRunnableAgeMs: 1_000,
    };
```

Add these variables to the final `expect({ ... }).toBeDefined()` object:

```ts
      pollingOptions,
      pollContext,
      pollResult,
      deliveryProcessingResult,
      backlogSummary,
      workerObserver,
      moduleOptionsWithWorkerObserver,
      exportedPollContext,
      exportedPollResult,
      exportedDeliveryProcessingResult,
      exportedWorkerObserver,
      exportedBacklogSummary,
      pollingOptionsWithInvalidConcurrency,
      pollResultWithoutLoops,
      backlogSummaryWithoutRunnable,
```

- [ ] **Step 2: Run the public contract test and verify RED**

Run:

```bash
npm test -- src/interfaces/public-contract.spec.ts
```

Expected: FAIL with TypeScript errors for missing `PollingOptions.maxConcurrency`, worker observer types, `WebhookModuleOptions.workerObserver`, `DeliveryBacklogSummary`, and root exports.

- [ ] **Step 3: Add worker option and observer types**

In `src/interfaces/webhook-options.interface.ts`, replace `PollingOptions` with:

```ts
export interface PollingOptions {
  /** Set to false to disable the polling loop. Useful for API-only processes where a separate worker handles delivery. Default: true */
  enabled?: boolean;
  interval?: number;
  batchSize?: number;
  /** Minutes before a SENDING delivery is considered stale and reset to PENDING. Default: 5 */
  staleSendingMinutes?: number;
  /** Maximum delivery dispatches in flight per worker process. Default: batchSize */
  maxConcurrency?: number;
  /** When true, one poll cycle keeps claiming while backlog and capacity remain. Default: false */
  drainWhileBacklogged?: boolean;
  /** Maximum claim/drain loops inside one poll cycle. Default: 1, or 10 when drainWhileBacklogged is true */
  maxDrainLoopsPerPoll?: number;
  /** Optional sleep between continuous drain loops. Default: 0 */
  drainLoopDelayMs?: number;
}
```

After `PollingOptions`, insert:

```ts
export interface WebhookPollContext {
  batchSize: number;
  maxConcurrency: number;
  drainWhileBacklogged: boolean;
  maxDrainLoopsPerPoll: number;
  drainLoopDelayMs: number;
  activeDeliveries: number;
}

export interface WebhookPollResult {
  claimed: number;
  enriched: number;
  sent: number;
  failed: number;
  retried: number;
  recoveredStale: number;
  durationMs: number;
  loops: number;
}

export type WebhookDeliveryProcessingStatus = 'sent' | 'failed' | 'retried';

export interface WebhookDeliveryProcessingResult {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  tenantId: string | null;
  attempts: number;
  maxAttempts: number;
  status: WebhookDeliveryProcessingStatus;
  responseStatus: number | null;
  lastError: string | null;
  latencyMs: number | null;
  nextAttemptAt?: Date;
  failureKind?: DeliveryFailureKind;
  validationReason?: WebhookUrlValidationReason;
  validationUrl?: string;
  resolvedIp?: string;
}

export interface WebhookWorkerObserver {
  onPollStart?(context: WebhookPollContext): void;
  onPollComplete?(result: WebhookPollResult): void;
  onDeliveryComplete?(result: WebhookDeliveryProcessingResult): void;
  onPollError?(error: unknown): void;
}
```

In `WebhookModuleOptions`, after `polling?: PollingOptions;`, insert:

```ts
  /** Best-effort worker lifecycle and delivery metrics observer. Observer errors are logged and ignored. */
  workerObserver?: WebhookWorkerObserver;
```

- [ ] **Step 4: Add backlog summary to the delivery repository port**

In `src/ports/webhook-delivery.repository.ts`, after `PendingDelivery`, insert:

```ts
export interface DeliveryBacklogSummary {
  pendingCount: number;
  sendingCount: number;
  runnablePendingCount: number;
  oldestPendingAgeMs: number | null;
  oldestRunnableAgeMs: number | null;
}
```

In `WebhookDeliveryRepository`, after `recoverStaleSending(stalenessMinutes: number): Promise<number>;`, insert:

```ts
  getBacklogSummary?(): Promise<DeliveryBacklogSummary>;
```

- [ ] **Step 5: Export new public types**

In `src/index.ts`, add `DeliveryBacklogSummary` to the delivery repository type export block:

```ts
  DeliveryBacklogSummary,
```

Add these names to the options type export block:

```ts
  WebhookPollContext,
  WebhookPollResult,
  WebhookDeliveryProcessingStatus,
  WebhookDeliveryProcessingResult,
  WebhookWorkerObserver,
```

- [ ] **Step 6: Run the public contract test and verify GREEN**

Run:

```bash
npm test -- src/interfaces/public-contract.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/public-contract.spec.ts src/interfaces/webhook-options.interface.ts src/ports/webhook-delivery.repository.ts src/index.ts
git commit -m "feat: add worker capacity contracts"
```

---

### Task 2: Max Concurrency And Observer Metrics

**Files:**
- Modify: `src/webhook.delivery-worker.spec.ts`
- Modify: `src/webhook.delivery-worker.ts`

- [ ] **Step 1: Add worker capacity and observer unit tests**

In `src/webhook.delivery-worker.spec.ts`, inside `describe('poll', ...)`, add:

```ts
    it('limits a claim to available worker concurrency when batchSize is larger', async () => {
      const workerWithLimit = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 5, maxConcurrency: 2 } },
      );
      const d1 = makeDelivery({ id: 'd-limit-1' });
      const d2 = makeDelivery({ id: 'd-limit-2' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([d1, d2]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([d1, d2]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await workerWithLimit.poll();

      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenCalledWith(2);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(deliveryRepo.markSent).toHaveBeenCalledTimes(2);
    });

    it('defaults maxConcurrency to batchSize for compatibility', async () => {
      const d1 = makeDelivery({ id: 'd-default-1' });
      const d2 = makeDelivery({ id: 'd-default-2' });
      const d3 = makeDelivery({ id: 'd-default-3' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([d1, d2, d3]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([d1, d2, d3]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await worker.poll();

      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenCalledWith(10);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
    });

    it('reports poll and delivery metrics to the worker observer', async () => {
      const observer = {
        onPollStart: jest.fn(),
        onPollComplete: jest.fn(),
        onDeliveryComplete: jest.fn(),
        onPollError: jest.fn(),
      };
      const workerWithObserver = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: { batchSize: 10, maxConcurrency: 10 },
          workerObserver: observer,
        },
      );
      const sent = makeDelivery({ id: 'd-observer-sent' });
      const retried = makeDelivery({ id: 'd-observer-retry' });
      const retryAt = new Date('2026-05-03T00:00:00.000Z');

      deliveryRepo.recoverStaleSending.mockResolvedValueOnce(3);
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([sent, retried]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([sent, retried]);
      dispatcher.dispatch
        .mockResolvedValueOnce(makeSuccessResult())
        .mockResolvedValueOnce(makeFailureResult());
      retryPolicy.nextAttemptAt.mockReturnValueOnce(retryAt);

      await workerWithObserver.poll();

      expect(observer.onPollStart).toHaveBeenCalledWith({
        batchSize: 10,
        maxConcurrency: 10,
        drainWhileBacklogged: false,
        maxDrainLoopsPerPoll: 1,
        drainLoopDelayMs: 0,
        activeDeliveries: 0,
      });
      expect(observer.onDeliveryComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-observer-sent',
          status: 'sent',
          responseStatus: 200,
        }),
      );
      expect(observer.onDeliveryComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-observer-retry',
          status: 'retried',
          responseStatus: 500,
          nextAttemptAt: retryAt,
          failureKind: 'http_error',
        }),
      );
      expect(observer.onPollComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          claimed: 2,
          enriched: 2,
          sent: 1,
          failed: 0,
          retried: 1,
          recoveredStale: 3,
          loops: 1,
          durationMs: expect.any(Number),
        }),
      );
      expect(observer.onPollError).not.toHaveBeenCalled();
    });

    it('logs observer errors without failing delivery processing', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const observer = {
        onDeliveryComplete: jest.fn(() => {
          throw new Error('observer failed');
        }),
      };
      const workerWithObserver = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, workerObserver: observer },
      );
      const delivery = makeDelivery({ id: 'd-observer-error' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([delivery]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([delivery]);
      dispatcher.dispatch.mockResolvedValueOnce(makeSuccessResult());

      await workerWithObserver.poll();

      expect(deliveryRepo.markSent).toHaveBeenCalledWith(
        'd-observer-error',
        1,
        expect.objectContaining({ success: true }),
      );
      expect(loggerError).toHaveBeenCalledWith(
        'workerObserver.onDeliveryComplete callback error: observer failed',
        expect.any(String),
      );
      loggerError.mockRestore();
    });
```

In `describe('logging', ...)`, add:

```ts
    it('notifies observer when a poll-level error occurs', async () => {
      const observer = { onPollError: jest.fn(), onPollComplete: jest.fn() };
      const workerWithObserver = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, workerObserver: observer },
      );
      const error = new Error('claim failed');

      deliveryRepo.claimPendingDeliveries.mockRejectedValueOnce(error);

      await workerWithObserver.poll();

      expect(observer.onPollError).toHaveBeenCalledWith(error);
      expect(observer.onPollComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          claimed: 0,
          enriched: 0,
          sent: 0,
          failed: 0,
          retried: 0,
          loops: 0,
        }),
      );
    });
```

- [ ] **Step 2: Run worker tests and verify RED**

Run:

```bash
npm test -- src/webhook.delivery-worker.spec.ts
```

Expected: FAIL because the worker does not read `maxConcurrency`, does not emit worker observer events, and still claims `batchSize` rows.

- [ ] **Step 3: Add worker option fields and helpers**

In `src/webhook.delivery-worker.ts`, extend the options import:

```ts
  DeliveryFailureKind,
  WebhookDeliveryProcessingResult,
  WebhookModuleOptions,
  WebhookPollContext,
  WebhookPollResult,
```

Add fields after `staleSendingMinutes`:

```ts
  private readonly maxConcurrency: number;
  private readonly drainWhileBacklogged: boolean;
  private readonly maxDrainLoopsPerPoll: number;
  private readonly drainLoopDelayMs: number;
  private readonly activeDeliveryTasks = new Set<
    Promise<WebhookDeliveryProcessingResult | null>
  >();
```

In the constructor, after `this.staleSendingMinutes = ...`, insert:

```ts
    this.maxConcurrency = this.positiveInteger(
      options.polling?.maxConcurrency ?? this.batchSize,
      this.batchSize,
    );
    this.drainWhileBacklogged = options.polling?.drainWhileBacklogged ?? false;
    this.maxDrainLoopsPerPoll = this.positiveInteger(
      options.polling?.maxDrainLoopsPerPoll ??
        (this.drainWhileBacklogged ? 10 : 1),
      this.drainWhileBacklogged ? 10 : 1,
    );
    this.drainLoopDelayMs = this.nonNegativeInteger(
      options.polling?.drainLoopDelayMs ?? 0,
      0,
    );
```

Add these private helpers before `runPollCycle()`:

```ts
  private positiveInteger(value: number, fallback: number): number {
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeInteger(value: number, fallback: number): number {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private availableCapacity(): number {
    return Math.max(0, this.maxConcurrency - this.activeDeliveries);
  }

  private createPollContext(): WebhookPollContext {
    return {
      batchSize: this.batchSize,
      maxConcurrency: this.maxConcurrency,
      drainWhileBacklogged: this.drainWhileBacklogged,
      maxDrainLoopsPerPoll: this.drainWhileBacklogged
        ? this.maxDrainLoopsPerPoll
        : 1,
      drainLoopDelayMs: this.drainLoopDelayMs,
      activeDeliveries: this.activeDeliveries,
    };
  }

  private createEmptyPollResult(): WebhookPollResult {
    return {
      claimed: 0,
      enriched: 0,
      sent: 0,
      failed: 0,
      retried: 0,
      recoveredStale: 0,
      durationMs: 0,
      loops: 0,
    };
  }

  private notifyObserver<K extends keyof NonNullable<WebhookModuleOptions['workerObserver']>>(
    method: K,
    payload: Parameters<NonNullable<WebhookModuleOptions['workerObserver']>[K]>[0],
  ): void {
    const observer = this.options.workerObserver;
    const callback = observer?.[method] as
      | ((value: typeof payload) => void)
      | undefined;
    if (!callback) return;

    try {
      callback(payload);
    } catch (observerError) {
      this.logError(`workerObserver.${String(method)} callback error`, observerError);
    }
  }

  private createDeliveryProcessingResult(
    delivery: PendingDelivery,
    attempts: number,
    status: WebhookDeliveryProcessingResult['status'],
    result: DeliveryResult,
    nextAttemptAt: Date | undefined,
    meta: DeliveryFailureMeta = {},
  ): WebhookDeliveryProcessingResult {
    return {
      deliveryId: delivery.id,
      endpointId: delivery.endpointId,
      eventId: delivery.eventId,
      tenantId: delivery.tenantId,
      attempts,
      maxAttempts: delivery.maxAttempts,
      status,
      responseStatus: result.statusCode ?? null,
      lastError: result.error ?? null,
      latencyMs: result.latencyMs ?? null,
      nextAttemptAt,
      ...meta,
    };
  }
```

- [ ] **Step 4: Replace `runPollCycle()` with one-loop maxConcurrency behavior**

Replace the current `runPollCycle()` with:

```ts
  private async runPollCycle(): Promise<void> {
    const startedAt = Date.now();
    const pollResult = this.createEmptyPollResult();
    const pollTasks: Array<Promise<WebhookDeliveryProcessingResult | null>> = [];

    this.notifyObserver('onPollStart', this.createPollContext());

    try {
      await this.circuitBreaker.recoverEligibleEndpoints();

      const recovered = await this.deliveryRepo.recoverStaleSending(
        this.staleSendingMinutes,
      );
      pollResult.recoveredStale = recovered;
      if (recovered > 0) {
        this.logger.warn(`Recovered ${recovered} stale SENDING deliveries`);
      }

      const claimSize = Math.min(this.batchSize, this.availableCapacity());
      if (claimSize <= 0) return;

      const claimed = await this.deliveryRepo.claimPendingDeliveries(claimSize);
      if (claimed.length === 0) return;

      pollResult.claimed += claimed.length;
      pollResult.loops = 1;

      const deliveries = await this.deliveryRepo.enrichDeliveries(
        claimed.map((d) => d.id),
      );
      pollResult.enriched += deliveries.length;

      for (const delivery of deliveries) {
        pollTasks.push(this.scheduleDelivery(delivery, pollResult));
      }

      await Promise.all(pollTasks);
    } catch (error) {
      this.notifyObserver('onPollError', error);
      this.logError('Poll cycle failed', error);
    } finally {
      pollResult.durationMs = Date.now() - startedAt;
      this.notifyObserver('onPollComplete', pollResult);
    }
  }
```

Add `scheduleDelivery()` after `runPollCycle()`:

```ts
  private scheduleDelivery(
    delivery: PendingDelivery,
    pollResult: WebhookPollResult,
  ): Promise<WebhookDeliveryProcessingResult | null> {
    const task = this.processDelivery(delivery)
      .then((deliveryResult) => {
        if (!deliveryResult) return null;

        if (deliveryResult.status === 'sent') pollResult.sent++;
        if (deliveryResult.status === 'failed') pollResult.failed++;
        if (deliveryResult.status === 'retried') pollResult.retried++;

        this.notifyObserver('onDeliveryComplete', deliveryResult);
        return deliveryResult;
      })
      .finally(() => {
        this.activeDeliveryTasks.delete(task);
      });

    this.activeDeliveryTasks.add(task);
    return task;
  }
```

- [ ] **Step 5: Change `processDelivery()` to return delivery metrics**

Change the signature:

```ts
  private async processDelivery(
    delivery: PendingDelivery,
  ): Promise<WebhookDeliveryProcessingResult | null> {
```

In the success branch, after `await this.updateCircuitBreakerAfterDelivery(...)`, return:

```ts
        return this.createDeliveryProcessingResult(
          delivery,
          newAttempts,
          'sent',
          result,
          undefined,
        );
```

In the non-retryable HTTP failure branch, after `await this.updateCircuitBreakerAfterDelivery(...)`, return:

```ts
        return this.createDeliveryProcessingResult(
          delivery,
          newAttempts,
          'failed',
          result,
          undefined,
          this.classifyResultFailure(result),
        );
```

In the retry-exhausted result failure branch, after `await this.updateCircuitBreakerAfterDelivery(...)`, return:

```ts
        return this.createDeliveryProcessingResult(
          delivery,
          newAttempts,
          'failed',
          result,
          undefined,
          this.classifyResultFailure(result),
        );
```

In the retry branch, after `await this.updateCircuitBreakerAfterDelivery(...)`, return:

```ts
        return this.createDeliveryProcessingResult(
          delivery,
          newAttempts,
          'retried',
          result,
          nextAt,
          this.classifyResultFailure(result),
        );
```

In the exception path, after the fallback `markFailed()` branch completes circuit-breaker handling, return:

```ts
          return this.createDeliveryProcessingResult(
            delivery,
            newAttempts,
            'failed',
            errorResult,
            undefined,
            meta,
          );
```

In the exception path, after the fallback `markRetry()` branch completes circuit-breaker handling, return:

```ts
          return this.createDeliveryProcessingResult(
            delivery,
            newAttempts,
            'retried',
            errorResult,
            nextAt,
            meta,
          );
```

At the end of the outer catch block, after the fallback catch block, add:

```ts
      return null;
```

Keep the existing `finally { this.activeDeliveries--; }` block unchanged.

- [ ] **Step 6: Run worker tests and verify GREEN**

Run:

```bash
npm test -- src/webhook.delivery-worker.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/webhook.delivery-worker.spec.ts src/webhook.delivery-worker.ts
git commit -m "feat: add worker concurrency metrics"
```

---

### Task 3: Continuous Drain Mode

**Files:**
- Modify: `src/webhook.delivery-worker.spec.ts`
- Modify: `src/webhook.delivery-worker.ts`

- [ ] **Step 1: Add drain mode tests**

In `src/webhook.delivery-worker.spec.ts`, inside `describe('poll', ...)`, add:

```ts
    it('keeps drainWhileBacklogged disabled by default and claims one batch', async () => {
      const d1 = makeDelivery({ id: 'd-one-batch-1' });
      const d2 = makeDelivery({ id: 'd-one-batch-2' });

      deliveryRepo.claimPendingDeliveries
        .mockResolvedValueOnce([d1, d2])
        .mockResolvedValueOnce([makeDelivery({ id: 'd-should-not-claim' })]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([d1, d2]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await worker.poll();

      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenCalledTimes(1);
      expect(deliveryRepo.enrichDeliveries).toHaveBeenCalledWith([
        'd-one-batch-1',
        'd-one-batch-2',
      ]);
    });

    it('drains multiple batches while backlog remains when enabled', async () => {
      const observer = { onPollComplete: jest.fn() };
      const workerWithDrain = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: {
            batchSize: 2,
            maxConcurrency: 4,
            drainWhileBacklogged: true,
            maxDrainLoopsPerPoll: 3,
          },
          workerObserver: observer,
        },
      );
      const d1 = makeDelivery({ id: 'd-drain-1' });
      const d2 = makeDelivery({ id: 'd-drain-2' });
      const d3 = makeDelivery({ id: 'd-drain-3' });
      const d4 = makeDelivery({ id: 'd-drain-4' });

      deliveryRepo.claimPendingDeliveries
        .mockResolvedValueOnce([d1, d2])
        .mockResolvedValueOnce([d3, d4])
        .mockResolvedValueOnce([]);
      deliveryRepo.enrichDeliveries
        .mockResolvedValueOnce([d1, d2])
        .mockResolvedValueOnce([d3, d4]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await workerWithDrain.poll();

      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenNthCalledWith(1, 2);
      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenNthCalledWith(2, 2);
      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenNthCalledWith(3, 2);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(4);
      expect(observer.onPollComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          claimed: 4,
          enriched: 4,
          sent: 4,
          loops: 2,
        }),
      );
    });

    it('stops drain mode at maxDrainLoopsPerPoll', async () => {
      const workerWithDrainLimit = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: {
            batchSize: 1,
            maxConcurrency: 2,
            drainWhileBacklogged: true,
            maxDrainLoopsPerPoll: 2,
          },
        },
      );
      const d1 = makeDelivery({ id: 'd-loop-limit-1' });
      const d2 = makeDelivery({ id: 'd-loop-limit-2' });
      const d3 = makeDelivery({ id: 'd-loop-limit-3' });

      deliveryRepo.claimPendingDeliveries
        .mockResolvedValueOnce([d1])
        .mockResolvedValueOnce([d2])
        .mockResolvedValueOnce([d3]);
      deliveryRepo.enrichDeliveries
        .mockResolvedValueOnce([d1])
        .mockResolvedValueOnce([d2]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await workerWithDrainLimit.poll();

      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenCalledTimes(2);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    });

    it('recovers stale SENDING deliveries only once during a drain poll', async () => {
      const workerWithDrain = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: {
            batchSize: 1,
            maxConcurrency: 2,
            drainWhileBacklogged: true,
            maxDrainLoopsPerPoll: 2,
          },
        },
      );
      const d1 = makeDelivery({ id: 'd-stale-once-1' });
      const d2 = makeDelivery({ id: 'd-stale-once-2' });

      deliveryRepo.claimPendingDeliveries
        .mockResolvedValueOnce([d1])
        .mockResolvedValueOnce([d2]);
      deliveryRepo.enrichDeliveries
        .mockResolvedValueOnce([d1])
        .mockResolvedValueOnce([d2]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await workerWithDrain.poll();

      expect(deliveryRepo.recoverStaleSending).toHaveBeenCalledTimes(1);
    });
```

- [ ] **Step 2: Run worker tests and verify RED**

Run:

```bash
npm test -- src/webhook.delivery-worker.spec.ts
```

Expected: FAIL because `runPollCycle()` still claims at most one batch.

- [ ] **Step 3: Add drain wait helpers**

In `src/webhook.delivery-worker.ts`, add these helpers before `runPollCycle()`:

```ts
  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async waitForAvailableCapacity(): Promise<void> {
    while (
      !this.isShuttingDown &&
      this.availableCapacity() <= 0 &&
      this.activeDeliveryTasks.size > 0
    ) {
      await Promise.race(this.activeDeliveryTasks);
    }
  }
```

- [ ] **Step 4: Replace the single claim block in `runPollCycle()` with drain loop behavior**

Inside `runPollCycle()`, replace the code from `const claimSize = Math.min(this.batchSize, this.availableCapacity());` through `await Promise.all(pollTasks);` with:

```ts
      const maxLoops = this.drainWhileBacklogged
        ? this.maxDrainLoopsPerPoll
        : 1;

      for (let loop = 0; loop < maxLoops && !this.isShuttingDown; loop++) {
        if (loop > 0) {
          await this.sleep(this.drainLoopDelayMs);
        }

        await this.waitForAvailableCapacity();

        const claimSize = Math.min(this.batchSize, this.availableCapacity());
        if (claimSize <= 0) break;

        const claimed = await this.deliveryRepo.claimPendingDeliveries(claimSize);
        if (claimed.length === 0) break;

        pollResult.claimed += claimed.length;
        pollResult.loops++;

        const deliveries = await this.deliveryRepo.enrichDeliveries(
          claimed.map((d) => d.id),
        );
        pollResult.enriched += deliveries.length;

        for (const delivery of deliveries) {
          pollTasks.push(this.scheduleDelivery(delivery, pollResult));
        }

        if (!this.drainWhileBacklogged) break;
      }

      await Promise.all(pollTasks);
```

- [ ] **Step 5: Run worker tests and verify GREEN**

Run:

```bash
npm test -- src/webhook.delivery-worker.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webhook.delivery-worker.spec.ts src/webhook.delivery-worker.ts
git commit -m "feat: add worker backlog drain mode"
```

---

### Task 4: Backlog Summary And Delivery Indexes

**Files:**
- Modify: `src/adapters/prisma-delivery.repository.spec.ts`
- Modify: `src/adapters/prisma-delivery.repository.ts`
- Modify: `test/e2e/webhook.e2e-spec.ts`
- Modify: `src/sql/create-webhook-tables.sql`
- Create: `src/sql/migrations/v0.12.0.sql`

- [ ] **Step 1: Add Prisma backlog summary unit tests**

In `src/adapters/prisma-delivery.repository.spec.ts`, after `describe('claimPendingDeliveries', ...)`, insert:

```ts
  describe('getBacklogSummary', () => {
    it('returns default zero counts when the aggregate query returns no rows', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(repo.getBacklogSummary()).resolves.toEqual({
        pendingCount: 0,
        sendingCount: 0,
        runnablePendingCount: 0,
        oldestPendingAgeMs: null,
        oldestRunnableAgeMs: null,
      });
    });

    it('uses backlog diagnostic aliases expected by the public port', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            pendingCount: 3,
            sendingCount: 2,
            runnablePendingCount: 1,
            oldestPendingAgeMs: 12_000,
            oldestRunnableAgeMs: 4_000,
          },
        ]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(repo.getBacklogSummary()).resolves.toEqual({
        pendingCount: 3,
        sendingCount: 2,
        runnablePendingCount: 1,
        oldestPendingAgeMs: 12_000,
        oldestRunnableAgeMs: 4_000,
      });

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
      expect(sql).toContain('AS "pendingCount"');
      expect(sql).toContain('AS "sendingCount"');
      expect(sql).toContain('AS "runnablePendingCount"');
      expect(sql).toContain('AS "oldestPendingAgeMs"');
      expect(sql).toContain('AS "oldestRunnableAgeMs"');
      expect(sql).toContain("status = 'PENDING'");
      expect(sql).toContain("status = 'SENDING'");
    });
  });
```

- [ ] **Step 2: Add SQL index file tests**

At the top of `src/adapters/prisma-delivery.repository.spec.ts`, add:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
```

After the top-level `describe('PrismaDeliveryRepository', () => {` line, insert:

```ts
  describe('schema indexes', () => {
    it('declares partial indexes for runnable pending and sending scans', () => {
      const createTablesSql = readFileSync(
        join(__dirname, '..', 'sql', 'create-webhook-tables.sql'),
        'utf8',
      );
      const migrationSql = readFileSync(
        join(__dirname, '..', 'sql', 'migrations', 'v0.12.0.sql'),
        'utf8',
      );

      for (const sql of [createTablesSql, migrationSql]) {
        expect(sql).toContain('webhook_deliveries_runnable_pending_idx');
        expect(sql).toContain('ON webhook_deliveries (next_attempt_at, id)');
        expect(sql).toContain("WHERE status = 'PENDING'");
        expect(sql).toContain('webhook_deliveries_sending_claimed_idx');
        expect(sql).toContain('ON webhook_deliveries (claimed_at, id)');
        expect(sql).toContain("WHERE status = 'SENDING'");
      }
    });
  });
```

- [ ] **Step 3: Run Prisma repository tests and verify RED**

Run:

```bash
npm test -- src/adapters/prisma-delivery.repository.spec.ts
```

Expected: FAIL because `getBacklogSummary()` and `src/sql/migrations/v0.12.0.sql` do not exist and the create-table SQL does not contain the new indexes.

- [ ] **Step 4: Implement `getBacklogSummary()`**

In `src/adapters/prisma-delivery.repository.ts`, add `DeliveryBacklogSummary` to the repository import:

```ts
  DeliveryBacklogSummary,
```

After `recoverStaleSending()`, insert:

```ts
  async getBacklogSummary(): Promise<DeliveryBacklogSummary> {
    const rows = await this.prisma.$queryRaw<DeliveryBacklogSummary[]>`
      WITH backlog AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'PENDING')::int AS "pendingCount",
          COUNT(*) FILTER (WHERE status = 'SENDING')::int AS "sendingCount",
          COUNT(*) FILTER (
            WHERE status = 'PENDING'
              AND next_attempt_at <= NOW()
          )::int AS "runnablePendingCount",
          MIN(next_attempt_at) FILTER (
            WHERE status = 'PENDING'
          ) AS "oldestPendingAt",
          MIN(next_attempt_at) FILTER (
            WHERE status = 'PENDING'
              AND next_attempt_at <= NOW()
          ) AS "oldestRunnableAt"
        FROM webhook_deliveries
      )
      SELECT
        "pendingCount",
        "sendingCount",
        "runnablePendingCount",
        CASE
          WHEN "oldestPendingAt" IS NULL THEN NULL
          ELSE GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - "oldestPendingAt")) * 1000)::int
          )
        END AS "oldestPendingAgeMs",
        CASE
          WHEN "oldestRunnableAt" IS NULL THEN NULL
          ELSE GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - "oldestRunnableAt")) * 1000)::int
          )
        END AS "oldestRunnableAgeMs"
      FROM backlog`;

    return rows[0] ?? {
      pendingCount: 0,
      sendingCount: 0,
      runnablePendingCount: 0,
      oldestPendingAgeMs: null,
      oldestRunnableAgeMs: null,
    };
  }
```

- [ ] **Step 5: Add partial indexes to SQL files**

In `src/sql/create-webhook-tables.sql`, after `idx_webhook_deliveries_status_next`, insert:

```sql
CREATE INDEX IF NOT EXISTS webhook_deliveries_runnable_pending_idx
  ON webhook_deliveries (next_attempt_at, id)
  WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS webhook_deliveries_sending_claimed_idx
  ON webhook_deliveries (claimed_at, id)
  WHERE status = 'SENDING';
```

Create `src/sql/migrations/v0.12.0.sql` with:

```sql
-- @nestarc/webhook v0.12.0 - worker capacity diagnostics indexes
-- Adds partial indexes for high-volume delivery worker claim and stale recovery paths.

CREATE INDEX IF NOT EXISTS webhook_deliveries_runnable_pending_idx
  ON webhook_deliveries (next_attempt_at, id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS webhook_deliveries_sending_claimed_idx
  ON webhook_deliveries (claimed_at, id)
  WHERE status = 'SENDING';
```

- [ ] **Step 6: Add e2e backlog summary coverage**

In `test/e2e/webhook.e2e-spec.ts`, add `WEBHOOK_DELIVERY_REPOSITORY` and `WebhookDeliveryRepository` imports:

```ts
import {
  WEBHOOK_DELIVERY_REPOSITORY,
  WebhookDeliveryRepository,
} from '../../src';
```

Inside the top-level `describe`, add:

```ts
  let deliveryRepo: WebhookDeliveryRepository;
```

After `deliveryWorker = module.get(WebhookDeliveryWorker);`, insert:

```ts
    deliveryRepo = module.get(WEBHOOK_DELIVERY_REPOSITORY);
```

Before the manual retry test, add:

```ts
  it('reports delivery backlog summary counts and runnable ages', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    await webhookService.send(new TestOrderEvent('ord_backlog_pending'));
    await webhookService.send(new TestOrderEvent('ord_backlog_future'));
    await webhookService.send(new TestOrderEvent('ord_backlog_sending'));

    await prisma.$executeRawUnsafe(
      `UPDATE webhook_deliveries
       SET next_attempt_at = NOW() + INTERVAL '10 minutes'
       WHERE endpoint_id = '${endpoint.id}'::uuid
         AND id = (
           SELECT id
           FROM webhook_deliveries
           WHERE endpoint_id = '${endpoint.id}'::uuid
           ORDER BY id
           OFFSET 1
           LIMIT 1
         )`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE webhook_deliveries
       SET status = 'SENDING', claimed_at = NOW()
       WHERE endpoint_id = '${endpoint.id}'::uuid
         AND id = (
           SELECT id
           FROM webhook_deliveries
           WHERE endpoint_id = '${endpoint.id}'::uuid
           ORDER BY id
           OFFSET 2
           LIMIT 1
         )`,
    );

    const summary = await deliveryRepo.getBacklogSummary!();

    expect(summary.pendingCount).toBeGreaterThanOrEqual(2);
    expect(summary.sendingCount).toBeGreaterThanOrEqual(1);
    expect(summary.runnablePendingCount).toBeGreaterThanOrEqual(1);
    expect(summary.oldestPendingAgeMs).toEqual(expect.any(Number));
    expect(summary.oldestRunnableAgeMs).toEqual(expect.any(Number));
  });
```

- [ ] **Step 7: Run repository tests and verify GREEN**

Run:

```bash
npm test -- src/adapters/prisma-delivery.repository.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Run e2e tests and verify GREEN**

Run:

```bash
npm run test:e2e
```

Expected: PASS with local Postgres available from the existing e2e setup.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/prisma-delivery.repository.spec.ts src/adapters/prisma-delivery.repository.ts test/e2e/webhook.e2e-spec.ts src/sql/create-webhook-tables.sql src/sql/migrations/v0.12.0.sql
git commit -m "feat: add delivery backlog diagnostics"
```

---

### Task 5: Documentation And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document new configuration options**

In `README.md`, in the configuration table, replace the polling rows:

```md
| `polling.batchSize` | `50` | Max deliveries per poll cycle |
| `polling.staleSendingMinutes` | `5` | Minutes before a stuck SENDING delivery is recovered |
```

with:

```md
| `polling.batchSize` | `50` | Max rows claimed in one database claim |
| `polling.staleSendingMinutes` | `5` | Minutes before a stuck SENDING delivery is recovered |
| `polling.maxConcurrency` | `polling.batchSize` | Max delivery dispatches in flight per worker process |
| `polling.drainWhileBacklogged` | `false` | Keep claiming additional batches inside one poll while backlog and capacity remain |
| `polling.maxDrainLoopsPerPoll` | `1`, or `10` when drain mode is enabled | Max claim loops inside one poll cycle |
| `polling.drainLoopDelayMs` | `0` | Optional delay between drain loops |
```

- [ ] **Step 2: Add worker observer documentation**

In `README.md`, after the configuration table and retry schedule paragraph, insert:

````md
### Worker Capacity And Observer Metrics

The delivery worker keeps the previous default behavior: one poll claims up to `polling.batchSize` rows and waits for those deliveries before the next interval. Set `polling.maxConcurrency` to cap in-flight dispatches below or above a claim size, and set `polling.drainWhileBacklogged: true` when a worker should continue draining queued deliveries inside the same poll cycle.

```ts
WebhookModule.forRoot({
  prisma,
  polling: {
    interval: 1_000,
    batchSize: 100,
    maxConcurrency: 200,
    drainWhileBacklogged: true,
    maxDrainLoopsPerPoll: 10,
  },
  workerObserver: {
    onPollComplete(result) {
      metrics.count('webhook.worker.claimed', result.claimed);
      metrics.count('webhook.worker.sent', result.sent);
      metrics.count('webhook.worker.retried', result.retried);
      metrics.gauge('webhook.worker.poll.duration_ms', result.durationMs);
    },
    onDeliveryComplete(result) {
      metrics.count(`webhook.delivery.${result.status}`, 1);
    },
    onPollError(error) {
      logger.error({ error }, 'webhook worker poll failed');
    },
  },
});
```

Observer callbacks are best-effort. Exceptions thrown by observer callbacks are logged and do not fail delivery processing.

Backlog diagnostics are available on repository implementations that support `getBacklogSummary()`:

```ts
const summary = await deliveryRepository.getBacklogSummary?.();
```

The summary includes `pendingCount`, `sendingCount`, `runnablePendingCount`, `oldestPendingAgeMs`, and `oldestRunnableAgeMs`.
````

- [ ] **Step 3: Update changelog**

In `CHANGELOG.md`, under `## [Unreleased]`, insert:

```md
### Added

- Worker capacity controls: `polling.maxConcurrency`, `polling.drainWhileBacklogged`, `polling.maxDrainLoopsPerPoll`, and `polling.drainLoopDelayMs`.
- `workerObserver` with poll lifecycle and delivery processing metrics callbacks.
- `WebhookDeliveryRepository.getBacklogSummary()` and `DeliveryBacklogSummary` for delivery backlog diagnostics.
- Partial PostgreSQL indexes for runnable `PENDING` deliveries and stale `SENDING` recovery scans.

### Changed

- `WebhookDeliveryWorker` now separates database claim size from in-flight dispatch concurrency while preserving previous defaults.
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- src/interfaces/public-contract.spec.ts src/webhook.delivery-worker.spec.ts src/adapters/prisma-delivery.repository.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 7: Run e2e tests**

Run:

```bash
npm run test:e2e
```

Expected: PASS when the test database is available. If the database is unavailable, capture the connection error and run the focused Jest suite plus `npm run lint` and `npm run build` before handing off.

- [ ] **Step 8: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document worker capacity controls"
```

---

## Self-Review

- Spec coverage: The plan covers public polling options, `workerObserver`, `maxConcurrency`, opt-in drain loops, observer safety, stale recovery once per poll, backlog summary, partial indexes, documentation, and verification.
- Compatibility: Defaults keep `maxConcurrency = batchSize`, `drainWhileBacklogged = false`, `maxDrainLoopsPerPoll = 1`, `drainLoopDelayMs = 0`, and `workerObserver = undefined`.
- Type consistency: `WebhookDeliveryProcessingResult`, `WebhookPollContext`, `WebhookPollResult`, `WebhookWorkerObserver`, and `DeliveryBacklogSummary` are defined before later tasks use them.
- Testing: Unit tests cover the worker behavior and Prisma SQL; e2e tests cover repository behavior against PostgreSQL; full verification includes focused tests, typecheck, build, and e2e.
