# Backend Evaluation Report

- Date: 2026-04-11
- Repository: `@nestarc/webhook`
- Scope: architecture, security, reliability, operations, test readiness
- Overall grade: `B-`
- Release recommendation: `Hold for production release until P0 items are fixed`

## Executive Summary

The project is functionally strong and has a good baseline architecture. Core webhook capabilities are implemented: fan-out delivery, HMAC signing, retry scheduling, circuit breaker behavior, delivery logging, and manual retry flows.

The main blockers are not basic correctness issues. They are production risks around security boundaries, retry accounting, and deployment assumptions:

1. DNS rebinding can bypass current SSRF defenses.
2. Dispatch/persistence exceptions can bypass retry limits and create unbounded retry loops.
3. The published SQL migration assumes `pgcrypto` without declaring that dependency.

## Validation Performed

The following checks were executed during review:

- `npm run lint`
- `npm test -- --runInBand`
- `npm test -- --coverage --runInBand`
- `docker compose -f docker-compose.test.yml up -d`
- `npm run test:e2e`
- `docker compose -f docker-compose.test.yml down`

Observed results:

- Type check: passed
- Unit tests: `11/11` suites, `121/121` tests
- Coverage: `95.7%` statements, `90.62%` branches
- E2E tests: `8/8` passed

## Strengths

- Clear service decomposition: signing, retry policy, circuit breaker, dispatcher, worker, and admin concerns are separated.
- Good use of ports/adapters with injectable repository and HTTP client overrides.
- Transactional event and delivery creation prevents partial fan-out recording.
- `FOR UPDATE SKIP LOCKED` is used for multi-worker-safe claiming.
- Graceful shutdown handling and stale `SENDING` recovery exist.
- Test coverage is strong across unit and end-to-end scenarios.

## Findings

### P0-1. DNS rebinding SSRF remains possible

- Severity: `High`
- Priority: `P0`
- Files:
  - [src/webhook.endpoint-admin.service.ts](../src/webhook.endpoint-admin.service.ts)
  - [src/adapters/fetch-http-client.ts](../src/adapters/fetch-http-client.ts)

URL validation only runs when an endpoint is created or updated. Delivery later posts to the stored hostname as-is. A hostname can validate as public at registration time and later resolve to a private or metadata IP at dispatch time, which leaves an SSRF path open through DNS rebinding.

Impact:

- Private network targets can still become reachable.
- Metadata endpoints can become reachable after validation succeeds.
- Current SSRF protection is incomplete under real DNS behavior.

Recommended fix:

- Re-validate DNS/IP at send time, not only at create/update time.
- Prefer resolving the hostname immediately before dispatch and rejecting private, loopback, link-local, and metadata targets.
- Consider IP pinning per attempt and validating redirects remain disabled.

### P0-2. Dispatch exceptions bypass retry limits

- Severity: `High`
- Priority: `P0`
- Files:
  - [src/webhook.delivery-worker.ts](../src/webhook.delivery-worker.ts)
  - [src/adapters/prisma-delivery.repository.ts](../src/adapters/prisma-delivery.repository.ts)

When dispatch or persistence throws, the worker catch block resets the row to `PENDING` without incrementing `attempts` and without scheduling the next retry. A persistent failure can therefore return to the queue immediately on every poll and bypass both max retry accounting and circuit breaker intent.

Impact:

- Unbounded retry loops are possible.
- Backoff policy is skipped on exception paths.
- Circuit breaker behavior becomes less meaningful for persistent internal failures.

Recommended fix:

- Replace `resetToPending()` with a failure transition that increments attempts and sets `next_attempt_at`.
- If the retry budget is exhausted, mark the delivery `FAILED`.
- Add tests that verify exception-driven retries are delayed and bounded.

### P0-3. Published migration assumes `pgcrypto`

- Severity: `High`
- Priority: `P0`
- File:
  - [src/sql/create-webhook-tables.sql](../src/sql/create-webhook-tables.sql)

The migration uses `gen_random_uuid()` for all primary keys, but the SQL file does not create or document the required `pgcrypto` extension. On a clean PostgreSQL instance, the migration can fail before the package is usable.

Impact:

- Clean installs can fail.
- Release quality is affected because the published setup is incomplete.

Recommended fix:

- Add `CREATE EXTENSION IF NOT EXISTS pgcrypto;` to the migration, or
- clearly document the prerequisite in `README.md` and installation steps.

### P1-1. Stale `SENDING` recovery can duplicate live work

- Severity: `Medium`
- Priority: `P1`
- File:
  - [src/adapters/prisma-delivery.repository.ts](../src/adapters/prisma-delivery.repository.ts)

Recovery moves `SENDING` rows back to `PENDING` based on `next_attempt_at + staleSendingMinutes`. Because a claimed delivery does not renew a lease while still in progress, a slow but valid request can be recovered and claimed again by another worker.

Impact:

- Duplicate webhook deliveries are possible.
- Slow downstream receivers can trigger false recovery.

Recommended fix:

- Track a lease timestamp such as `claimed_at` or `heartbeat_at`.
- Recover rows based on lease expiry rather than original `next_attempt_at`.
- Consider worker heartbeats for long-running requests.

### P1-2. Endpoint read paths expose signing secrets

- Severity: `Medium`
- Priority: `P1`
- File:
  - [src/adapters/prisma-endpoint.repository.ts](../src/adapters/prisma-endpoint.repository.ts)

Endpoint queries always select `secret`, and admin services return raw endpoint records. If an application exposes these methods without strict DTO filtering and tenant/object authorization, signing secrets can leak across tenants.

Impact:

- Secret disclosure risk on list/get flows.
- Higher risk of accidental cross-tenant exposure in shared admin APIs.

Recommended fix:

- Split endpoint read models into internal and external shapes.
- Exclude `secret` from default read queries.
- Require explicit privileged methods for secret access and rotation.
- Enforce tenant/object-level authorization in consuming application layers.

## Architecture Notes

The current architecture is generally solid, but there are maintainability tradeoffs:

- Repository ports expose transaction-specific methods such as `saveEventInTransaction(...)` and `findMatchingEndpointsInTransaction(...)`, which weakens the abstraction boundary and ties the service layer to persistence details.
- `WebhookModule` is global and automatically starts a poller on import. That is convenient for simple usage, but it assumes a long-lived process and makes worker lifecycle less configurable.

These are not immediate blockers, but they reduce flexibility for future evolution.

## Operations Notes

- The module currently relies on application logs for observability.
- There are no built-in health, readiness, metrics, or tracing hooks.
- `README.md` does not currently describe all operational knobs, including `allowPrivateUrls` and `polling.staleSendingMinutes`.
- `docs/handover.md` describes configuration and auto-generated REST APIs that do not match the shipped module surface.

## Release Decision

Current recommendation: do not treat this package as production-ready until all `P0` items are addressed.

Minimum bar for release:

1. Fix the retry-accounting exception path.
2. Close the DNS rebinding SSRF gap.
3. Make the migration self-sufficient or clearly declare the `pgcrypto` prerequisite.

After those are fixed, the next improvement tier should focus on secret exposure, stale-lease recovery, and stronger operational observability.
