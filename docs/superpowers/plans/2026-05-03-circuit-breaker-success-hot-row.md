# Circuit Breaker Success Hot Row Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop successful webhook deliveries from rewriting already-healthy endpoint rows, removing the endpoint hot-row lock bottleneck observed during worker scale-out.

**Architecture:** Keep `WebhookCircuitBreaker.afterDelivery(success=true)` semantics unchanged and push the optimization into `PrismaEndpointRepository.resetFailures()`. The repository should issue a single guarded `UPDATE` that becomes a PostgreSQL no-op when the endpoint already has `consecutive_failures = 0` and is not disabled by the circuit breaker. This avoids adding a read-before-write query to the success hot path.

**Tech Stack:** TypeScript, NestJS providers, Jest unit tests, Prisma raw SQL adapter, PostgreSQL e2e tests, npm package changelog.

---

## Background

The platform load test found that `@nestarc/webhook@0.12.0` worker scale-out regressed under a high-throughput all-200 receiver profile. The important path is:

```text
delivery succeeds
-> WebhookDeliveryWorker.processDelivery()
-> WebhookCircuitBreaker.afterDelivery(endpointId, true, meta)
-> WebhookEndpointRepository.resetFailures(endpointId)
-> UPDATE webhook_endpoints
```

Current behavior rewrites the same `webhook_endpoints` row on every successful delivery, even when the endpoint is already healthy. With one hot endpoint and multiple workers, that creates row-level contention on `webhook_endpoints`.

Platform verification with a temporary guarded update:

| Scenario | p95 / p99 | HTTP 500 | Prisma transaction start timeouts | max pending | drain | endpoint lock waits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline 1 worker, C100/L5 | 47.9 / 172.5ms | 0 | 0 | 9362 | 49.9s | present |
| guarded 1 worker, C100/L5 | 46.1 / 100.5ms | 0 | 0 | 8516 | 43.8s | 0 |
| baseline 2 workers, C100/L5 | 6064.7 / 6064.7ms | 2300 | 2300 | 8945 | 24.2s | high |
| guarded 2 workers, C100/L5 | 71.5 / 94.6ms | 0 | 0 | 1 | 1.7s | 0 |

Local load generator `EADDRNOTAVAIL` errors were still present and should not be used for production SLO decisions. They were similar between baseline and guarded runs, so they do not explain the DB lock improvement.

## File Structure

- Modify `src/adapters/prisma-endpoint.repository.ts`
  - Add a guarded `WHERE` predicate to `resetFailures()`.
  - Preserve reset behavior when failures are non-zero.
  - Preserve circuit-breaker-disabled endpoint recovery.
  - Preserve non-circuit-breaker disabled endpoint safety.
- Modify `src/adapters/prisma-endpoint.repository.spec.ts`
  - Assert the reset SQL only updates rows with changed circuit-breaker state.
  - Assert non-circuit-breaker disabled state is still protected.
- Modify `test/e2e/webhook.e2e-spec.ts`
  - Add database-backed coverage that successful delivery does not update an already healthy endpoint row.
  - Add database-backed coverage that a successful delivery still resets accumulated failures.
- Modify `CHANGELOG.md`
  - Record the performance fix under `Unreleased`.

## Non-Goals

- Do not change retry classification.
- Do not change circuit-breaker failure accounting.
- Do not add an endpoint lookup before `resetFailures()`.
- Do not change `WebhookEndpointRepository.resetFailures()` return type.
- Do not add a new public option for this behavior.

---

### Task 1: Guard `resetFailures()` In The Prisma Adapter

**Files:**
- Modify: `src/adapters/prisma-endpoint.repository.ts`
- Test: `src/adapters/prisma-endpoint.repository.spec.ts`

- [ ] **Step 1: Write the failing SQL-shape test**

In `src/adapters/prisma-endpoint.repository.spec.ts`, inside `describe('resetFailures', ...)`, add this test after `only clears disabled state when the circuit breaker disabled the endpoint`:

```ts
    it('skips healthy endpoint success resets by guarding the UPDATE predicate', async () => {
      const prisma = {
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      const repo = new PrismaEndpointRepository(prisma);

      await repo.resetFailures('endpoint-1');

      const sql = (prisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray)
        .join(' ')
        .replace(/\s+/g, ' ');
      const values = prisma.$executeRaw.mock.calls[0].slice(1);

      expect(sql).toContain('WHERE id =');
      expect(sql).toContain('consecutive_failures <> 0');
      expect(sql).toContain('OR disabled_reason =');
      expect(values).toContain(ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED);
    });
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- src/adapters/prisma-endpoint.repository.spec.ts --runInBand
```

Expected result:

```text
FAIL src/adapters/prisma-endpoint.repository.spec.ts
Expected substring: "consecutive_failures <> 0"
```

- [ ] **Step 3: Implement the guarded update**

In `src/adapters/prisma-endpoint.repository.ts`, replace the final `WHERE` clause in `resetFailures()`:

```ts
      WHERE id = ${endpointId}::uuid`;
```

with:

```ts
      WHERE id = ${endpointId}::uuid
        AND (
          consecutive_failures <> 0
          OR disabled_reason = ${ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED}
        )`;
```

Keep the existing `SET` expressions unchanged:

```ts
      SET consecutive_failures = 0,
          active = CASE
            WHEN disabled_reason = ${ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED}
              THEN true
            ELSE active
          END,
          disabled_at = CASE
            WHEN disabled_reason = ${ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED}
              THEN NULL
            ELSE disabled_at
          END,
          disabled_reason = CASE
            WHEN disabled_reason = ${ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED}
              THEN NULL
            ELSE disabled_reason
          END,
          updated_at = NOW()
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm test -- src/adapters/prisma-endpoint.repository.spec.ts --runInBand
```

Expected result:

```text
PASS src/adapters/prisma-endpoint.repository.spec.ts
```

- [ ] **Step 5: Commit the adapter guard**

Run:

```bash
git add src/adapters/prisma-endpoint.repository.ts src/adapters/prisma-endpoint.repository.spec.ts
git commit -m "fix: avoid healthy endpoint reset writes"
```

---

### Task 2: Add Database-Backed Success No-Op Coverage

**Files:**
- Modify: `test/e2e/webhook.e2e-spec.ts`

- [ ] **Step 1: Add an e2e test for healthy endpoint no-op reset**

In `test/e2e/webhook.e2e-spec.ts`, add this test after `it('should deliver a webhook to a registered endpoint', ...)`:

```ts
  it('should not update a healthy endpoint row after a successful delivery', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    const beforeRows = await prisma.$queryRaw<
      Array<{ updated_at: Date; consecutive_failures: number; disabled_reason: string | null }>
    >`
      SELECT updated_at, consecutive_failures, disabled_reason
      FROM webhook_endpoints
      WHERE id = ${endpoint.id}::uuid
    `;
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].consecutive_failures).toBe(0);
    expect(beforeRows[0].disabled_reason).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 25));

    await webhookService.send(new TestOrderEvent('ord_success_noop_reset'));
    await deliveryWorker.poll();

    const afterRows = await prisma.$queryRaw<
      Array<{ updated_at: Date; consecutive_failures: number; disabled_reason: string | null }>
    >`
      SELECT updated_at, consecutive_failures, disabled_reason
      FROM webhook_endpoints
      WHERE id = ${endpoint.id}::uuid
    `;

    expect(receivedRequests).toHaveLength(1);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].consecutive_failures).toBe(0);
    expect(afterRows[0].disabled_reason).toBeNull();
    expect(afterRows[0].updated_at.getTime()).toBe(beforeRows[0].updated_at.getTime());
  });
```

- [ ] **Step 2: Run the e2e test and verify it passes**

Run:

```bash
npm run test:e2e -- --runInBand
```

Expected result:

```text
PASS test/e2e/webhook.e2e-spec.ts
```

- [ ] **Step 3: Commit the no-op reset e2e test**

Run:

```bash
git add test/e2e/webhook.e2e-spec.ts
git commit -m "test: cover healthy endpoint reset no-op"
```

---

### Task 3: Add Database-Backed Failure Reset Coverage

**Files:**
- Modify: `test/e2e/webhook.e2e-spec.ts`

- [ ] **Step 1: Add an e2e test for non-zero failure reset**

In `test/e2e/webhook.e2e-spec.ts`, add this test after `should not update a healthy endpoint row after a successful delivery`:

```ts
  it('should clear accumulated endpoint failures after a successful delivery', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    await prisma.$executeRaw`
      UPDATE webhook_endpoints
      SET consecutive_failures = 2,
          updated_at = NOW() - INTERVAL '1 minute'
      WHERE id = ${endpoint.id}::uuid
    `;

    const beforeRows = await prisma.$queryRaw<Array<{ consecutive_failures: number }>>`
      SELECT consecutive_failures
      FROM webhook_endpoints
      WHERE id = ${endpoint.id}::uuid
    `;
    expect(beforeRows[0].consecutive_failures).toBe(2);

    await webhookService.send(new TestOrderEvent('ord_success_resets_failures'));
    await deliveryWorker.poll();

    const afterRows = await prisma.$queryRaw<
      Array<{
        active: boolean;
        consecutive_failures: number;
        disabled_at: Date | null;
        disabled_reason: string | null;
      }>
    >`
      SELECT active, consecutive_failures, disabled_at, disabled_reason
      FROM webhook_endpoints
      WHERE id = ${endpoint.id}::uuid
    `;

    expect(receivedRequests).toHaveLength(1);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].active).toBe(true);
    expect(afterRows[0].consecutive_failures).toBe(0);
    expect(afterRows[0].disabled_at).toBeNull();
    expect(afterRows[0].disabled_reason).toBeNull();
  });
```

- [ ] **Step 2: Run the e2e suite**

Run:

```bash
npm run test:e2e -- --runInBand
```

Expected result:

```text
PASS test/e2e/webhook.e2e-spec.ts
```

- [ ] **Step 3: Commit the failure reset coverage**

Run:

```bash
git add test/e2e/webhook.e2e-spec.ts
git commit -m "test: preserve endpoint failure reset behavior"
```

---

### Task 4: Document The Performance Fix

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the changelog**

In `CHANGELOG.md`, under `## [Unreleased]`, add:

```md
### Fixed

- Successful delivery circuit-breaker resets now avoid rewriting already-healthy endpoint rows, reducing `webhook_endpoints` row-lock contention during high-throughput worker scale-out.
```

- [ ] **Step 2: Run package verification**

Run:

```bash
npm run lint
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
```

Expected result:

```text
All commands complete successfully.
```

- [ ] **Step 3: Commit the changelog**

Run:

```bash
git add CHANGELOG.md
git commit -m "docs: note endpoint reset hot-row fix"
```

---

### Task 5: Release And Platform Verification Handoff

**Files:**
- No code changes required if package release tooling already updates version metadata.

- [ ] **Step 1: Inspect package version and release policy**

Run:

```bash
node -p "require('./package.json').version"
```

Expected result:

```text
0.12.x
```

Choose patch version `0.12.1` unless the repository release process requires a different patch number.

- [ ] **Step 2: Run prepublish verification**

Run:

```bash
npm run prepublishOnly
```

Expected result:

```text
npm run clean && npm run lint && npm test && npm run build
```

and the command exits with status 0.

- [ ] **Step 3: Platform verification after publish**

After publishing the package and updating `webhook-platform` to the new version, run these platform checks:

```bash
npm run test:load:unit
LOAD_TEST_ALLOW_STAGING_CAPACITY=true npm run test:load -- --profile=capacity-ramp --duration=90 --max-arrival-rate=500
LOAD_TEST_ALLOW_STAGING_CAPACITY=true npm run test:load -- --profile=worker-scale --duration=90 --max-arrival-rate=500
```

Expected platform result:

```text
capacity-ramp exits 0 with no HTTP 500 responses.
worker-scale exits 0 with no HTTP 500 responses.
worker-scale drain stays near seconds, not tens of seconds.
DB samples show no material Lock:tuple, Lock:transactionid, or MultiXact wait accumulation from webhook_endpoints.
```

Local platform runs may still show `EADDRNOTAVAIL` from the load generator at 500 arrival rate. Treat that as local generator saturation unless HTTP 500 responses or DB lock waits also return.

---

## Review Checklist

- [ ] `resetFailures()` remains a single SQL statement.
- [ ] Healthy endpoint success path does not update `updated_at`.
- [ ] Success after non-zero `consecutive_failures` still clears failure count.
- [ ] Circuit-breaker-disabled endpoint recovery still clears `disabled_at` and `disabled_reason`.
- [ ] Non-circuit-breaker disabled endpoints are not forcibly reactivated.
- [ ] No public API shape changes are introduced.
- [ ] `npm run lint`, `npm test -- --runInBand`, `npm run test:e2e -- --runInBand`, and `npm run build` pass.
