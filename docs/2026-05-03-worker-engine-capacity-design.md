# Worker Engine Capacity Improvement Design

Date: 2026-05-03

## Summary

The platform load test showed that API ingestion and database writes remain healthy while webhook delivery backlog grows under higher sustained load. This points to the worker delivery loop as the first capacity boundary.

This document proposes engine-level improvements for `@nestarc/webhook` so applications can tune and observe delivery capacity without rewriting the worker in each platform.

## Load Test Evidence

The measurements below were taken from the local `webhook-platform` load-test runner against local Docker Postgres/Redis and a local sink.

| Scenario | Workers | Max arrival rate | API result | Delivery result | Max backlog | Drain time |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| Capacity baseline | 1 | 100 | 15,600/15,600 2xx, p95 23.8ms, p99 85.6ms | all SENT | not measured | not measured |
| Capacity sweep | 1 | 200 | 12,015/12,015 2xx, p95 12.1ms, p99 19.1ms | all SENT | 2,810 | 28.9s |
| Capacity sweep | 1 | 300 | 17,865/17,865 2xx, p95 36.2ms, p99 133ms | all SENT | 7,409 | 75.8s |
| Worker scale | 2 | 300 | 17,865/17,865 2xx, p95 63.4ms, p99 169ms | all SENT | 1,449 | 8.4s |

DB sampler errors, lock waits, and blocking samples were zero in these runs. The bottleneck is not API latency or DB locking in the tested profile. The bottleneck is delivery worker throughput.

## Current Engine Behavior

The current engine worker behavior is:

```text
setInterval(interval)
  -> worker.poll()
  -> skip if previous poll is still running
  -> recover stale SENDING rows
  -> claim batchSize PENDING rows
  -> enrich deliveries
  -> Promise.all(dispatch each claimed delivery)
  -> stop until next interval tick
```

The practical single-worker ceiling is bounded by:

```text
min(batchSize / interval, actual HTTP dispatch + DB update throughput)
```

With `batchSize=100` and `interval=1000ms`, one worker can only start around 100 claimed deliveries per second, before HTTP and DB overhead. When input exceeds that rate, backlog grows even if API latency remains excellent.

## Design Goals

1. Make worker capacity explicit and tunable.
2. Separate claim batch size from concurrent dispatch count.
3. Allow a worker to drain backlog continuously instead of sleeping after one batch.
4. Expose metrics needed for SLOs and autoscaling.
5. Preserve current behavior by default for compatibility.
6. Keep multi-worker safety based on `FOR UPDATE SKIP LOCKED`.

## Non-Goals

1. Replace Postgres-backed delivery with an external queue in this change.
2. Change webhook retry semantics.
3. Change circuit breaker semantics.
4. Guarantee exactly-once delivery. The engine should continue to target at-least-once delivery with idempotent state transitions.
5. Add platform-specific monitoring integrations directly into the engine.

## Proposed Engine API

Extend `PollingOptions`:

```ts
export interface PollingOptions {
  enabled?: boolean;
  interval?: number;
  batchSize?: number;
  staleSendingMinutes?: number;

  /**
   * Maximum delivery dispatches in flight per worker process.
   * Default: batchSize, preserving current behavior.
   */
  maxConcurrency?: number;

  /**
   * When true, a poll cycle keeps claiming additional batches while backlog is available
   * and capacity remains. This reduces idle time under backlog.
   * Default: false, preserving current interval-only behavior.
   */
  drainWhileBacklogged?: boolean;

  /**
   * Maximum number of claim/drain loops inside one poll cycle.
   * Prevents a single worker from monopolizing the event loop indefinitely.
   * Default: 1 when drainWhileBacklogged is false, 10 when true.
   */
  maxDrainLoopsPerPoll?: number;

  /**
   * Optional sleep between continuous drain loops.
   * Default: 0.
   */
  drainLoopDelayMs?: number;
}
```

Add an optional observer interface:

```ts
export interface WebhookWorkerObserver {
  onPollStart?(context: WebhookPollContext): void;
  onPollComplete?(result: WebhookPollResult): void;
  onDeliveryComplete?(result: WebhookDeliveryProcessingResult): void;
  onPollError?(error: unknown): void;
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
```

Add to `WebhookModuleOptions`:

```ts
workerObserver?: WebhookWorkerObserver;
```

The observer must be best-effort. Observer failures must be caught and logged, not allowed to fail delivery processing.

## Worker Loop Design

The improved worker should maintain a per-process concurrency limiter:

```text
poll()
  if shutting down or already polling: return

  recover stale SENDING rows only once per poll

  loop until:
    - drainWhileBacklogged is false and one loop completed
    - maxDrainLoopsPerPoll reached
    - no capacity remains
    - claim returns zero rows

    capacity = maxConcurrency - activeDeliveries
    claimSize = min(batchSize, capacity)
    claim claimSize rows
    enrich rows
    schedule dispatch through concurrency limiter
```

Important behavior:

1. `batchSize` controls how many rows are claimed per DB claim.
2. `maxConcurrency` controls how many deliveries can be in flight per worker.
3. If `maxConcurrency < batchSize`, the worker should not claim more rows than it can start soon. This avoids moving too many rows to `SENDING`.
4. If `drainWhileBacklogged=true`, the worker can claim another batch after dispatch slots free up, without waiting for the next interval.
5. Existing `isPolling` guard should remain to prevent overlapping poll loops in one process.
6. Multi-worker safety remains delegated to `FOR UPDATE SKIP LOCKED`.

## Backlog Metrics

The engine should provide a repository-level method for backlog diagnostics:

```ts
export interface DeliveryBacklogSummary {
  pendingCount: number;
  sendingCount: number;
  runnablePendingCount: number;
  oldestPendingAgeMs: number | null;
  oldestRunnableAgeMs: number | null;
}

export interface WebhookDeliveryRepository {
  getBacklogSummary?(): Promise<DeliveryBacklogSummary>;
}
```

For the Prisma adapter, this can be implemented with a single aggregate SQL query over `webhook_deliveries`.

Recommended indexes:

```sql
CREATE INDEX IF NOT EXISTS webhook_deliveries_runnable_pending_idx
ON webhook_deliveries (next_attempt_at, id)
WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS webhook_deliveries_sending_claimed_idx
ON webhook_deliveries (claimed_at, id)
WHERE status = 'SENDING';
```

The existing `(status, next_attempt_at)` index is useful, but partial indexes reduce hot-path index size for high-volume delivery workloads.

## SLOs Enabled By This Design

Applications should be able to alert on:

1. `pendingCount`
2. `oldestPendingAgeMs`
3. `runnablePendingCount`
4. `oldestRunnableAgeMs`
5. worker `claimed` rate
6. worker `sent` rate
7. retry rate
8. failed rate
9. poll duration
10. active delivery concurrency

Example SLOs for a platform integration:

```text
delivery p95 completion time <= 30s
delivery p99 completion time <= 120s
oldest runnable pending age <= 60s
drain time after 10 minute peak <= 120s
worker poll error rate == 0
duplicate terminal attempts == 0
```

## Compatibility Plan

Defaults must preserve existing behavior:

```text
maxConcurrency = batchSize
drainWhileBacklogged = false
maxDrainLoopsPerPoll = 1
drainLoopDelayMs = 0
workerObserver = undefined
```

Existing users who only set `interval`, `batchSize`, or `staleSendingMinutes` should see no behavioral change unless they opt in to the new options.

## Testing Plan

Unit tests:

1. `maxConcurrency` limits simultaneous dispatches below `batchSize`.
2. `drainWhileBacklogged=false` claims at most one batch per poll.
3. `drainWhileBacklogged=true` claims multiple batches until empty or `maxDrainLoopsPerPoll`.
4. worker does not claim more than available concurrency.
5. observer receives poll and delivery metrics.
6. observer exceptions do not fail delivery.
7. stale recovery still runs once per poll.
8. shutdown waits for active deliveries as before.

Integration tests:

1. Two worker instances claim disjoint delivery rows using `SKIP LOCKED`.
2. Partial indexes are present after migration.
3. backlog summary reports pending, sending, runnable, and oldest ages correctly.
4. retries remain scheduled according to existing retry policy.

Load tests:

1. Re-run local capacity sweeps with:
   - `batchSize=100`
   - `interval=1000ms`
   - `maxConcurrency=100`
   - `drainWhileBacklogged=false`
2. Re-run with:
   - `batchSize=100`
   - `interval=1000ms`
   - `maxConcurrency=200`
   - `drainWhileBacklogged=true`
3. Compare:
   - max pending backlog
   - drain time
   - API p95/p99
   - DB max active connections
   - lock waits
   - failed delivery count

## Rollout Plan

1. Add types and defaults without changing runtime behavior.
2. Implement concurrency limiter and observer hooks behind opt-in options.
3. Add backlog summary repository method.
4. Add partial indexes in a migration.
5. Release as a minor version.
6. Update platform wrapper to expose:
   - `WEBHOOK_DELIVERY_MAX_CONCURRENCY`
   - `WEBHOOK_DELIVERY_DRAIN_WHILE_BACKLOGGED`
   - `WEBHOOK_DELIVERY_MAX_DRAIN_LOOPS_PER_POLL`
   - `WEBHOOK_DELIVERY_DRAIN_LOOP_DELAY_MS`
7. Re-run platform load tests locally and then against EC2/RDS.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Higher concurrency overloads DB connections | Document recommended connection limits and measure max active connections in load tests. |
| Higher concurrency overloads receiver endpoints | Keep circuit breaker behavior and allow platform-level endpoint throttling later. |
| Worker claims too many rows into `SENDING` | Claim no more than available concurrency. |
| Continuous drain monopolizes process | Limit with `maxDrainLoopsPerPoll` and optional `drainLoopDelayMs`. |
| Metrics callbacks create new failure path | Catch observer errors and log only. |
| Partial indexes affect migration time | Use concurrent index creation if supported by the migration process for production. |

## Recommended First Implementation Slice

Implement the lowest-risk engine improvement first:

1. Add `maxConcurrency` and enforce it inside one poll.
2. Add observer metrics for claimed, sent, failed, retried, recovered, duration.
3. Preserve current `drainWhileBacklogged=false`.

This slice improves safety and observability without changing the polling cadence. After that passes tests and load tests, add adaptive drain mode as a second slice.

## Open Decisions

1. Whether the engine should own a built-in metrics registry or only expose observer hooks.
2. Whether `drainWhileBacklogged` should default to false forever or become true in a future major release.
3. Whether backlog summary belongs in the delivery repository interface or a separate diagnostics service.
4. Whether partial indexes should be shipped in the engine package migrations or documented for host applications that own schema migrations.
