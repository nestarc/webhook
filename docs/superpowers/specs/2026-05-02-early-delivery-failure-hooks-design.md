# Early Delivery Failure Hooks Design

## Goal

Add engine-level hooks that let the platform observe delivery failures before retry exhaustion, without changing the terminal-only meaning of `onDeliveryFailed` or the active-to-inactive transition meaning of `onEndpointDisabled`.

The minimum release contract is that `@nestarc/webhook` exports:

- `DeliveryRetryScheduledContext`
- `EndpointDegradedContext`
- `CircuitBreakerOptions.degradedThreshold`
- `WebhookModuleOptions.onDeliveryRetryScheduled`
- `WebhookModuleOptions.onEndpointDegraded`

This is an additive API change and should be released as a minor version.

## Non-Goals

- Do not emit public platform events directly from the engine. Platform mapping to `delivery_retrying` happens outside this package.
- Do not change retry policy, retryable HTTP status classification, or `onDeliveryFailed` timing.
- Do not change `onEndpointDisabled` timing or payload.
- Do not add database schema for a persisted degraded endpoint state.
- Do not add a new endpoint repository method. Use the existing `getEndpoint()` method for the degraded active check.

## Public API

Add `degradedThreshold` to `CircuitBreakerOptions`:

```ts
export interface CircuitBreakerOptions {
  failureThreshold?: number;
  degradedThreshold?: number;
  cooldownMinutes?: number;
}
```

Add the retry-scheduled context:

```ts
export interface DeliveryRetryScheduledContext {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  tenantId: string | null;

  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;

  lastError: string | null;
  responseStatus: number | null;

  failureKind?: DeliveryFailureKind;
  validationReason?: WebhookUrlValidationReason;
  validationUrl?: string;
  resolvedIp?: string;
}
```

Add the endpoint-degraded context:

```ts
export interface EndpointDegradedContext {
  endpointId: string;
  tenantId: string | null;
  url: string;

  reason: 'consecutive_failures_degraded';
  consecutiveFailures: number;
  degradedThreshold: number;
  failureThreshold: number;
}
```

Add the hook options:

```ts
export interface WebhookModuleOptions<TPrisma = unknown> {
  // existing options remain unchanged

  onDeliveryRetryScheduled?: (
    context: DeliveryRetryScheduledContext,
  ) => void | Promise<void>;

  onEndpointDegraded?: (
    context: EndpointDegradedContext,
  ) => void | Promise<void>;
}
```

Export the new context types from `src/index.ts` alongside the existing option and hook context types.

## Delivery Worker Behavior

`WebhookDeliveryWorker.processDelivery()` should fire `onDeliveryRetryScheduled` only after a retry has been persisted.

For dispatch results:

1. Dispatch returns `success: false`.
2. The result remains retryable under the existing retry classifier.
3. `newAttempts < delivery.maxAttempts`.
4. `retryPolicy.nextAttemptAt(newAttempts)` produces `nextAttemptAt`.
5. `deliveryRepo.markRetry(delivery.id, newAttempts, nextAttemptAt, result)` resolves.
6. The worker fires `onDeliveryRetryScheduled` fire-and-forget with:
   - delivery identity and tenant fields from `PendingDelivery`
   - `attempts: newAttempts`
   - `maxAttempts: delivery.maxAttempts`
   - `nextAttemptAt`
   - `lastError: result.error ?? null`
   - `responseStatus: result.statusCode ?? null`
   - `failureKind` from the existing `classifyResultFailure()` logic used for terminal `onDeliveryFailed`

For dispatcher exceptions:

1. `dispatcher.dispatch(delivery)` throws before returning a `DeliveryResult`.
2. The worker builds the same `errorResult` used today in the catch path.
3. The worker builds failure metadata once:
   - `WebhookUrlValidationError` maps to `failureKind: 'url_validation'`, `validationReason`, `validationUrl: error.url ?? delivery.url`, and `resolvedIp`.
   - Other dispatcher exceptions map to `failureKind: 'dispatch_error'`.
4. If `newAttempts < delivery.maxAttempts`, `markRetry()` resolves, then `onDeliveryRetryScheduled` fires with the metadata above.
5. If `newAttempts >= delivery.maxAttempts`, `markFailed()` resolves, then existing `onDeliveryFailed` fires. The retry-scheduled hook does not fire.

The worker should distinguish dispatcher exceptions from persistence exceptions. Current catch logic also handles errors from `markSent()`, `markRetry()`, and `markFailed()`. Those errors should not count as endpoint delivery failures in the circuit breaker because they may be database or repository failures, not receiver endpoint failures.

A minimal implementation can keep the existing outer catch and track whether dispatch returned:

```ts
let dispatchReturned = false;

try {
  const result = await this.dispatcher.dispatch(delivery);
  dispatchReturned = true;
  // Continue with the existing success, terminal failure, and retry branches.
} catch (error) {
  // Only errors thrown before dispatch returned have dispatchReturned === false.
}
```

Only the `dispatchReturned === false` path should call the circuit breaker after a persisted failed attempt.

## Exception Path Circuit Breaker Update

After a dispatcher exception causes a failed attempt to be persisted through `markRetry()` or `markFailed()`, the worker should call:

```ts
await this.circuitBreaker.afterDelivery(delivery.endpointId, false, {
  tenantId: delivery.tenantId,
  url: delivery.url,
});
```

This call must be isolated exactly like the normal result path circuit breaker update:

- It happens after the delivery state transition succeeds.
- It is wrapped in its own `try/catch`.
- It logs errors and never re-enters fallback delivery state handling.
- It is skipped if `markRetry()` or `markFailed()` fails.
- It is skipped for persistence exceptions that occur after dispatch already returned.

This closes the existing gap where URL validation, URL parse failures, and other dispatcher exceptions can consume retry attempts without contributing to endpoint degradation or disablement.

## Circuit Breaker Behavior

`WebhookCircuitBreaker.afterDelivery()` keeps existing success and disable behavior:

- `success === true`: call `endpointRepo.resetFailures(endpointId)` and do not fire degraded or disabled hooks.
- `success === false`: call `endpointRepo.incrementFailures(endpointId)`.
- When failures reach `failureThreshold`, call `disableEndpoint()` and fire `onEndpointDisabled` only if the repository reports an active-to-inactive transition.

Add degraded behavior between incrementing failures and disabling:

1. Read `degradedThreshold` from `options.circuitBreaker?.degradedThreshold`.
2. If it is absent, do nothing.
3. If `degradedThreshold >= failureThreshold`, do nothing.
4. If `failures !== degradedThreshold`, do nothing.
5. When `failures === degradedThreshold`, call `endpointRepo.getEndpoint(endpointId)`.
6. Fire `onEndpointDegraded` only when the endpoint exists and `endpoint.active === true`.

The degraded hook payload is:

```ts
{
  endpointId,
  tenantId: meta.tenantId,
  url: meta.url,
  reason: 'consecutive_failures_degraded',
  consecutiveFailures: failures,
  degradedThreshold,
  failureThreshold: this.failureThreshold,
}
```

This produces one degraded hook per consecutive-failure run because the count must exactly equal `degradedThreshold`. It does not fire again for counts above the degraded threshold. If a later success resets failures to zero and the endpoint degrades again, the hook may fire again, which matches the consecutive-failure semantics.

## Hook Safety

Both new hooks must follow the safest existing hook pattern:

```ts
try {
  void Promise.resolve(hook(context)).catch((hookError) => {
    this.logError('hook callback error', hookError);
  });
} catch (hookError) {
  this.logError('hook callback error', hookError);
}
```

`WebhookCircuitBreaker` does not currently have `logError()`. The implementation can either add a small private helper there or use the existing logger directly with a synchronous `try/catch` and a promise rejection catch. Hook errors must be logged only. They must not reject `afterDelivery()` or `poll()`.

Existing hooks should keep their behavior. Improving `onEndpointDisabled` to also isolate synchronous throws is acceptable only if it is covered by tests and does not change when it fires.

## Test Plan

### Public Contract Tests

Update `src/interfaces/public-contract.spec.ts` to verify the minimum release surface:

- `WebhookModuleOptions` accepts `onDeliveryRetryScheduled`.
- `WebhookModuleOptions` accepts `onEndpointDegraded`.
- `CircuitBreakerOptions` accepts `degradedThreshold`.
- `DeliveryRetryScheduledContext` has required `nextAttemptAt`.
- `EndpointDegradedContext` has required `degradedThreshold` and `failureThreshold`.
- `EndpointDegradedContext.reason` only accepts `'consecutive_failures_degraded'`.
- The new context types are exported from the package root.

### Delivery Worker Tests

Add or extend tests in `src/webhook.delivery-worker.spec.ts`:

- `onDeliveryRetryScheduled` fires after a retriable HTTP failure and persisted `markRetry()`.
- The context includes `attempts`, `maxAttempts`, `nextAttemptAt`, `responseStatus`, and `failureKind: 'http_error'`.
- It does not fire on final retry exhaustion, while `onDeliveryFailed` still fires.
- It does not fire for non-retryable HTTP failures, while `onDeliveryFailed` still fires.
- It fires for retriable dispatcher exceptions with `failureKind: 'dispatch_error'`.
- It fires for retriable `WebhookUrlValidationError` with `failureKind: 'url_validation'`, `validationReason`, `validationUrl`, and `resolvedIp`.
- Dispatcher exception retry paths call `circuitBreaker.afterDelivery(endpointId, false, { tenantId, url })` after `markRetry()` succeeds.
- Dispatcher exception terminal paths call the same circuit breaker method after `markFailed()` succeeds.
- Circuit breaker update is skipped when fallback persistence fails.
- Retry hook rejection and synchronous throw are logged and do not reject worker processing.

### Circuit Breaker Tests

Add or extend tests in `src/webhook.circuit-breaker.spec.ts`:

- No degraded event fires when `degradedThreshold` is omitted.
- `onEndpointDegraded` fires when `failures === degradedThreshold`, `degradedThreshold < failureThreshold`, and `getEndpoint()` returns an active endpoint.
- The degraded context includes `endpointId`, `tenantId`, `url`, reason, `consecutiveFailures`, `degradedThreshold`, and `failureThreshold`.
- It does not fire when failures are above the degraded threshold.
- It does not fire when `degradedThreshold >= failureThreshold`.
- It does not fire when `getEndpoint()` returns `null` or an inactive endpoint.
- `onEndpointDisabled` still fires at `failureThreshold` using the existing active-to-inactive transition result.
- Degraded hook rejection and synchronous throw are logged and do not reject `afterDelivery()`.

## Documentation

Update `README.md` option tables and hook behavior notes:

- Document `circuitBreaker.degradedThreshold`.
- Document `onDeliveryRetryScheduled`.
- Document `onEndpointDegraded`.
- State that `onDeliveryFailed` remains terminal-only.
- State that degraded events are disabled unless `degradedThreshold` is configured.

Update `CHANGELOG.md` under `[Unreleased]`:

- Add the new optional hooks.
- Add the new `degradedThreshold` option.
- Note the exception-path circuit breaker accounting fix.
- State compatibility: existing hooks retain their semantics.

## Compatibility and Release

This change is backward compatible:

- No existing option is removed.
- No existing hook signature changes.
- `onDeliveryFailed` remains terminal-only.
- `onEndpointDisabled` remains active-to-inactive only.
- New hooks and `degradedThreshold` are optional.

The current package version is `0.10.0`. Because the change adds optional API and fixes an internal accounting gap, the expected next release version is `0.11.0`.

## Open Decisions Resolved

- Degraded active check: use existing `endpointRepo.getEndpoint()` only at the exact degraded threshold. This avoids schema and port expansion while preventing notifications for endpoints known to be inactive.
- Duplicate degraded events: exact equality on `failures === degradedThreshold` means no duplicate for counts above threshold. A later success reset can allow a new degraded event in a new consecutive-failure run.
- Persistence exceptions: do not count as endpoint failures when dispatch already returned. This avoids endpoint degraded or disabled notifications caused by repository/database errors.
