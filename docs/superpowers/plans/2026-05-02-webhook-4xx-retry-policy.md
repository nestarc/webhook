# Webhook 4xx Retry Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop retrying permanent customer endpoint 4xx responses, while preserving retries for transient failures such as network errors, 5xx, 408, 409, 425, and 429.

**Architecture:** Add a small internal retry-classification helper and make `WebhookDeliveryWorker` consult it before scheduling a retry. Permanent 4xx responses become `FAILED` after the current attempt, with normal attempt logging, circuit-breaker failure accounting, and `onDeliveryFailed` notification.

**Tech Stack:** TypeScript, NestJS providers, Jest unit tests, existing PostgreSQL e2e test harness.

---

## File Structure

- Create `src/webhook.retry-classifier.ts`
  - Owns delivery-result retryability decisions.
  - Keeps HTTP status policy separate from `FetchHttpClient`, which should continue to only report what happened.
- Create `src/webhook.retry-classifier.spec.ts`
  - Unit tests for retryable vs non-retryable status codes.
- Modify `src/webhook.delivery-worker.ts`
  - Use the classifier before `markRetry`.
  - Mark permanent 4xx as `FAILED` immediately.
- Modify `src/webhook.delivery-worker.spec.ts`
  - Worker-level tests proving permanent 4xx does not schedule retry and still fires `onDeliveryFailed`.
- Modify `test/e2e/webhook.e2e-spec.ts`
  - Database-level regression test for persisted `FAILED` state and single attempt log on 410.
- Modify `README.md`
  - Document permanent 4xx behavior and transient 4xx exceptions.
- Modify `CHANGELOG.md`
  - Record the behavior change under `[Unreleased]`.

---

### Task 1: Add Retry Classifier

**Files:**
- Create: `src/webhook.retry-classifier.spec.ts`
- Create: `src/webhook.retry-classifier.ts`

- [ ] **Step 1: Write the failing classifier tests**

Create `src/webhook.retry-classifier.spec.ts`:

```ts
import { DeliveryResult } from './interfaces/webhook-delivery.interface';
import { isRetryableDeliveryResult } from './webhook.retry-classifier';

function failedHttp(statusCode: number): DeliveryResult {
  return {
    success: false,
    statusCode,
    body: 'receiver response',
    latencyMs: 10,
  };
}

describe('isRetryableDeliveryResult', () => {
  it.each([400, 401, 403, 404, 410, 422])(
    'treats permanent HTTP %i as non-retryable',
    (statusCode) => {
      expect(isRetryableDeliveryResult(failedHttp(statusCode))).toBe(false);
    },
  );

  it.each([408, 409, 425, 429, 500, 502, 503, 504])(
    'treats transient HTTP %i as retryable',
    (statusCode) => {
      expect(isRetryableDeliveryResult(failedHttp(statusCode))).toBe(true);
    },
  );

  it('treats dispatch failures without an HTTP status as retryable', () => {
    expect(
      isRetryableDeliveryResult({
        success: false,
        latencyMs: 10,
        error: 'ECONNREFUSED',
      }),
    ).toBe(true);
  });

  it('does not retry successful deliveries', () => {
    expect(
      isRetryableDeliveryResult({
        success: true,
        statusCode: 204,
        latencyMs: 10,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the classifier test and verify RED**

Run:

```bash
npm test -- src/webhook.retry-classifier.spec.ts
```

Expected: FAIL because `./webhook.retry-classifier` does not exist.

- [ ] **Step 3: Implement the classifier**

Create `src/webhook.retry-classifier.ts`:

```ts
import { DeliveryResult } from './interfaces/webhook-delivery.interface';

const RETRYABLE_CLIENT_ERROR_STATUSES = new Set([408, 409, 425, 429]);

export function isRetryableDeliveryResult(result: DeliveryResult): boolean {
  if (result.success) {
    return false;
  }

  if (result.statusCode == null) {
    return true;
  }

  if (result.statusCode >= 400 && result.statusCode < 500) {
    return RETRYABLE_CLIENT_ERROR_STATUSES.has(result.statusCode);
  }

  return true;
}
```

- [ ] **Step 4: Run the classifier test and verify GREEN**

Run:

```bash
npm test -- src/webhook.retry-classifier.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the classifier**

```bash
git add src/webhook.retry-classifier.ts src/webhook.retry-classifier.spec.ts
git commit -m "feat: classify non-retryable webhook responses"
```

---

### Task 2: Wire Classifier Into Delivery Worker

**Files:**
- Modify: `src/webhook.delivery-worker.ts`
- Modify: `src/webhook.delivery-worker.spec.ts`

- [ ] **Step 1: Add failing worker tests for permanent 4xx**

In `src/webhook.delivery-worker.spec.ts`, add this test inside `describe('dispatch — success/failure paths', ...)`, after `should schedule retry on failure with attempts remaining`:

```ts
    it.each([400, 401, 403, 404, 410, 422])(
      'should mark permanent HTTP %i as FAILED without scheduling retry',
      async (statusCode) => {
        const enriched = makeDelivery({
          id: `d-${statusCode}`,
          endpointId: `ep-${statusCode}`,
          attempts: 0,
          maxAttempts: 5,
        });
        const result: DeliveryResult = {
          success: false,
          statusCode,
          body: 'permanent receiver error',
          latencyMs: 100,
        };

        deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
        deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
        dispatcher.dispatch.mockResolvedValueOnce(result);

        await worker.poll();

        expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
          `d-${statusCode}`,
          1,
          result,
        );
        expect(deliveryRepo.markRetry).not.toHaveBeenCalled();
        expect(retryPolicy.nextAttemptAt).not.toHaveBeenCalled();
        expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
          `ep-${statusCode}`,
          false,
          { tenantId: 'tenant-1', url: 'https://example.com/hook' },
        );
      },
    );
```

In the same file, add this test inside `describe('onDeliveryFailed callback', ...)`, after `should fire onDeliveryFailed when delivery exhausts retries`:

```ts
    it('should fire onDeliveryFailed when delivery has a non-retryable HTTP status', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );
      const result: DeliveryResult = {
        success: false,
        statusCode: 410,
        body: 'gone',
        latencyMs: 100,
      };
      const enriched = makeDelivery({
        id: 'd-gone',
        endpointId: 'ep-gone',
        attempts: 0,
        maxAttempts: 5,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(result);

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).toHaveBeenCalledWith({
        deliveryId: 'd-gone',
        endpointId: 'ep-gone',
        eventId: 'evt-1',
        tenantId: 'tenant-1',
        attempts: 1,
        maxAttempts: 5,
        lastError: null,
        responseStatus: 410,
        failureKind: 'http_error',
      });
    });
```

- [ ] **Step 2: Run worker tests and verify RED**

Run:

```bash
npm test -- src/webhook.delivery-worker.spec.ts
```

Expected: FAIL because permanent 4xx still goes through `markRetry`.

- [ ] **Step 3: Import the classifier**

In `src/webhook.delivery-worker.ts`, add this import near the other local imports:

```ts
import { isRetryableDeliveryResult } from './webhook.retry-classifier';
```

- [ ] **Step 4: Replace the retry branch**

In `src/webhook.delivery-worker.ts`, replace the current `result.success` branch in `processDelivery` with:

```ts
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
      }
```

- [ ] **Step 5: Run worker tests and verify GREEN**

Run:

```bash
npm test -- src/webhook.delivery-worker.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit worker integration**

```bash
git add src/webhook.delivery-worker.ts src/webhook.delivery-worker.spec.ts
git commit -m "fix: stop retrying permanent webhook 4xx responses"
```

---

### Task 3: Add E2E Regression Coverage

**Files:**
- Modify: `test/e2e/webhook.e2e-spec.ts`

- [ ] **Step 1: Add failing e2e test for 410**

In `test/e2e/webhook.e2e-spec.ts`, add this test after `should retry on failure and eventually succeed`:

```ts
  it('should fail permanent client errors without scheduling retry', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    await webhookService.send(new TestOrderEvent('ord_4_perm'));

    serverResponseStatus = 410;
    await deliveryWorker.poll();

    expect(receivedRequests).toHaveLength(1);

    const logs = await adminService.getDeliveryLogs(endpoint.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('FAILED');
    expect(logs[0].attempts).toBe(1);
    expect(logs[0].maxAttempts).toBe(3);
    expect(logs[0].responseStatus).toBe(410);
    expect(logs[0].nextAttemptAt).toBeNull();
    expect(logs[0].completedAt).toBeInstanceOf(Date);

    const attempts = await adminService.getDeliveryAttempts(logs[0].id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[0].responseStatus).toBe(410);
  });
```

- [ ] **Step 2: Run e2e test and verify behavior**

Run:

```bash
npm run test:e2e -- --runTestsByPath test/e2e/webhook.e2e-spec.ts
```

Expected after Task 2: PASS. If run before Task 2, expected failure is `status` being `PENDING` instead of `FAILED`.

- [ ] **Step 3: Commit e2e coverage**

```bash
git add test/e2e/webhook.e2e-spec.ts
git commit -m "test: cover terminal webhook client errors"
```

---

### Task 4: Document the Retry Policy

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update README retry policy text**

In `README.md`, replace the retry schedule paragraph around the configuration section with:

```md
The retry schedule is fixed exponential (`30s`, `5m`, `30m`, `2h`, `24h`). Use `delivery.jitter` to enable or disable random jitter.

Webhook receiver responses are classified before scheduling another attempt:

| Response | Behavior |
|---|---|
| `2xx` | Mark delivery `SENT` |
| `408`, `409`, `425`, `429` | Retry while attempts remain |
| Other `4xx` | Mark delivery `FAILED` after the current attempt |
| `5xx` | Retry while attempts remain |
| Network, DNS, timeout, or dispatch error | Retry while attempts remain |

Permanent `4xx` failures still record the response status/body, append a failed attempt log, count as a circuit-breaker failure, and trigger `onDeliveryFailed`.
```

In the delivery failure classification paragraph, replace:

```md
**Delivery failure classification.** `DeliveryFailedContext.failureKind` categorizes why a delivery was abandoned after all retries:
```

with:

```md
**Delivery failure classification.** `DeliveryFailedContext.failureKind` categorizes why a delivery was abandoned after retries are exhausted or a non-retryable receiver response is observed:
```

- [ ] **Step 2: Update CHANGELOG**

In `CHANGELOG.md`, add this under `## [Unreleased]`:

```md
### Changed

- Webhook deliveries now treat permanent receiver `4xx` responses as terminal failures instead of retrying them through the full backoff budget. `408`, `409`, `425`, and `429` remain retryable.
```

- [ ] **Step 3: Commit docs**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document webhook response retry policy"
```

---

### Task 5: Full Verification

**Files:**
- No file edits.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
npm test -- src/webhook.retry-classifier.spec.ts src/webhook.delivery-worker.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run full unit test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run e2e suite**

Run:

```bash
npm run test:e2e
```

Expected: PASS with the local PostgreSQL test database available.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS and `dist/` reflects the TypeScript changes.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat HEAD
git diff HEAD -- src/webhook.retry-classifier.ts src/webhook.delivery-worker.ts README.md CHANGELOG.md
```

Expected: only the classifier, worker retry branch, tests, docs, changelog, and generated build output if tracked.

---

## Self-Review

- Spec coverage: the plan covers permanent 4xx immediate termination, preserves retry behavior for 429 and other transient statuses, records attempt state through existing repository methods, keeps circuit-breaker accounting, and documents the new policy.
- Placeholder scan: no task relies on unspecified behavior or deferred implementation.
- Type consistency: all code uses existing `DeliveryResult`, `WebhookDeliveryWorker`, `WebhookDeliveryRepository`, and `DeliveryFailedContext` shapes.
