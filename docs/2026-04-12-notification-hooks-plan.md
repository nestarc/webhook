# Notification Hooks Implementation Plan (`@nestarc/webhook` 0.6.0)

> **Goal:** `onDeliveryFailed`, `onEndpointDisabled` 콜백 옵션을 추가하여, 소비자(webhook-platform 등)가 배달 실패/엔드포인트 비활성화 시점에 커스텀 로직을 실행할 수 있게 한다.

**Spec:** `webhook-platform/docs/superpowers/specs/2026-04-12-failure-notifications-design.md` Phase A 참조

---

## File Structure

### 수정 파일

| 파일 | 변경 |
|------|------|
| `src/interfaces/webhook-options.interface.ts` | 콜백 2개 + Context 인터페이스 2개 추가 |
| `src/webhook.delivery-worker.ts` | `processDelivery()`에서 `markFailed()` 후 `onDeliveryFailed` 호출 |
| `src/webhook.circuit-breaker.ts` | `afterDelivery()`에서 `disableEndpoint()` 후 `onEndpointDisabled` 호출 |
| `src/index.ts` | 새 인터페이스 re-export |
| `package.json` | version `0.5.0` → `0.6.0` |

---

## Task 1: Context 인터페이스 + 콜백 옵션 추가

**Files:**
- Modify: `src/interfaces/webhook-options.interface.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Context 인터페이스 정의**

`src/interfaces/webhook-options.interface.ts`에 추가:

```typescript
export interface DeliveryFailedContext {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  tenantId: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  responseStatus: number | null;
}

export interface EndpointDisabledContext {
  endpointId: string;
  tenantId: string;
  url: string;
  reason: string;
  consecutiveFailures: number;
}
```

- [ ] **Step 2: WebhookModuleOptions에 콜백 추가**

같은 파일의 `WebhookModuleOptions` 인터페이스에 추가:

```typescript
export interface WebhookModuleOptions {
  // ... 기존 필드 ...

  /** Called when a delivery exhausts all retry attempts. Fire-and-forget — errors are logged, not propagated. */
  onDeliveryFailed?: (context: DeliveryFailedContext) => void | Promise<void>;

  /** Called when the circuit breaker disables an endpoint. Fire-and-forget — errors are logged, not propagated. */
  onEndpointDisabled?: (context: EndpointDisabledContext) => void | Promise<void>;
}
```

- [ ] **Step 3: index.ts에서 re-export**

`src/index.ts`에 추가:

```typescript
export type { DeliveryFailedContext, EndpointDisabledContext } from './interfaces/webhook-options.interface';
```

- [ ] **Step 4: 커밋**

```bash
git add src/interfaces/webhook-options.interface.ts src/index.ts
git commit -m "feat: add DeliveryFailedContext, EndpointDisabledContext interfaces and callback options"
```

---

## Task 2: DeliveryWorker에 onDeliveryFailed 호출 추가

**Files:**
- Modify: `src/webhook.delivery-worker.ts`

- [ ] **Step 1: 생성자에 options 저장 확인**

`WebhookDeliveryWorker` 생성자에 이미 `options: WebhookModuleOptions`가 주입되어 있음. 이를 통해 `this.options.onDeliveryFailed`에 접근.

- [ ] **Step 2: processDelivery()에서 markFailed() 직후에 콜백 호출**

`processDelivery()` 메서드 내 `markFailed()` 호출 후 (2곳: 정상 실패 + 예외 실패):

```typescript
// 정상 실패 경로 (result.success === false && attempts exhausted)
await this.deliveryRepo.markFailed(delivery.id, newAttempts, result);
this.logger.warn(`Delivery ${delivery.id} exhausted retries (${newAttempts}/${delivery.max_attempts})`);

// 콜백 호출 추가
if (this.options.onDeliveryFailed) {
  try {
    await this.options.onDeliveryFailed({
      deliveryId: delivery.id,
      endpointId: delivery.endpoint_id,
      eventId: delivery.event_id,
      tenantId: delivery.tenant_id,
      attempts: newAttempts,
      maxAttempts: delivery.max_attempts,
      lastError: result.error ?? null,
      responseStatus: result.statusCode ?? null,
    });
  } catch (cbError) {
    this.logger.error(`onDeliveryFailed callback error: ${cbError}`);
  }
}
```

같은 패턴을 예외 실패 경로(`catch` 블록 내 `markFailed()` 후)에도 동일 적용. `result` 대신 `errorResult` 사용:

```typescript
// 예외 실패 경로
await this.deliveryRepo.markFailed(delivery.id, newAttempts, errorResult);
this.logger.warn(`Delivery ${delivery.id} exhausted retries on exception (${newAttempts}/${delivery.max_attempts})`);

if (this.options.onDeliveryFailed) {
  try {
    await this.options.onDeliveryFailed({
      deliveryId: delivery.id,
      endpointId: delivery.endpoint_id,
      eventId: delivery.event_id,
      tenantId: delivery.tenant_id,
      attempts: newAttempts,
      maxAttempts: delivery.max_attempts,
      lastError: errorResult.error ?? null,
      responseStatus: null,
    });
  } catch (cbError) {
    this.logger.error(`onDeliveryFailed callback error: ${cbError}`);
  }
}
```

- [ ] **Step 3: 빌드 확인**

```bash
npm run build
```

- [ ] **Step 4: 커밋**

```bash
git add src/webhook.delivery-worker.ts
git commit -m "feat: call onDeliveryFailed callback when delivery exhausts retries"
```

---

## Task 3: CircuitBreaker에 onEndpointDisabled 호출 추가

**Files:**
- Modify: `src/webhook.circuit-breaker.ts`

- [ ] **Step 1: 생성자에 options 주입 확인**

`WebhookCircuitBreaker`가 `WEBHOOK_MODULE_OPTIONS`를 주입받는지 확인. 주입받지 않으면 추가:

```typescript
constructor(
  @Inject(WEBHOOK_ENDPOINT_REPOSITORY)
  private readonly endpointRepo: WebhookEndpointRepository,
  @Inject(WEBHOOK_MODULE_OPTIONS)
  private readonly options: WebhookModuleOptions,
) {
  this.failureThreshold = options.circuitBreaker?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
  this.cooldownMinutes = options.circuitBreaker?.cooldownMinutes ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES;
}
```

- [ ] **Step 2: afterDelivery()에서 disableEndpoint() 직후에 콜백 호출**

`disableEndpoint()` 호출 후:

```typescript
await this.endpointRepo.disableEndpoint(endpointId, 'consecutive_failures_exceeded');
this.logger.warn(`Endpoint ${endpointId} disabled: consecutive_failures_exceeded`);

if (this.options.onEndpointDisabled) {
  try {
    const endpoint = await this.endpointRepo.getEndpoint(endpointId);
    await this.options.onEndpointDisabled({
      endpointId,
      tenantId: endpoint?.tenant_id ?? '',
      url: endpoint?.url ?? '',
      reason: 'consecutive_failures_exceeded',
      consecutiveFailures: this.failureThreshold,
    });
  } catch (cbError) {
    this.logger.error(`onEndpointDisabled callback error: ${cbError}`);
  }
}
```

`getEndpoint`가 비용이 걱정되면, `disableEndpoint`의 반환값이나 이미 가지고 있는 정보로 대체 가능. 엔드포인트 정보(url, tenantId)가 `afterDelivery` 호출 시점에 이미 있다면 파라미터로 받는 것이 더 효율적:

```typescript
async afterDelivery(endpointId: string, success: boolean, meta?: { tenantId: string; url: string }) {
```

기존 호출 시그니처가 바뀌므로, `delivery-worker`에서 호출하는 부분도 함께 수정:

```typescript
await this.circuitBreaker.afterDelivery(delivery.endpoint_id, result.success, {
  tenantId: delivery.tenant_id,
  url: delivery.endpoint_url,
});
```

이미 `PendingDelivery`에 `tenant_id`와 `endpoint_url`이 포함되어 있는지 확인 후 결정. 없으면 `getEndpoint()` 방식 사용.

- [ ] **Step 3: 빌드 확인**

```bash
npm run build
```

- [ ] **Step 4: 커밋**

```bash
git add src/webhook.circuit-breaker.ts src/webhook.delivery-worker.ts
git commit -m "feat: call onEndpointDisabled callback when circuit breaker triggers"
```

---

## Task 4: 테스트

**Files:**
- Modify or create: `test/webhook.delivery-worker.spec.ts`
- Modify or create: `test/webhook.circuit-breaker.spec.ts`

- [ ] **Step 1: DeliveryWorker 콜백 테스트**

```typescript
describe('onDeliveryFailed callback', () => {
  it('should call onDeliveryFailed when delivery exhausts retries', async () => {
    const onDeliveryFailed = jest.fn();
    // Setup worker with onDeliveryFailed in options
    // Mock deliveryRepo to return a delivery at max attempts
    // Mock dispatcher to return failure
    await worker.poll();
    expect(onDeliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: expect.any(String),
        tenantId: expect.any(String),
        attempts: expect.any(Number),
      }),
    );
  });

  it('should not propagate callback errors to delivery processing', async () => {
    const onDeliveryFailed = jest.fn().mockRejectedValue(new Error('callback error'));
    // Setup worker with failing callback
    // Mock delivery at max attempts
    await worker.poll();
    // Delivery should still be marked as FAILED — callback error doesn't affect it
    expect(deliveryRepo.markFailed).toHaveBeenCalled();
  });

  it('should not call callback when retries remain', async () => {
    const onDeliveryFailed = jest.fn();
    // Mock delivery with attempts < maxAttempts
    await worker.poll();
    expect(onDeliveryFailed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: CircuitBreaker 콜백 테스트**

```typescript
describe('onEndpointDisabled callback', () => {
  it('should call onEndpointDisabled when circuit breaker disables endpoint', async () => {
    const onEndpointDisabled = jest.fn();
    // Setup circuit breaker with threshold = 2, consecutive failures = 1
    // Call afterDelivery with success=false twice
    await circuitBreaker.afterDelivery(endpointId, false, meta);
    await circuitBreaker.afterDelivery(endpointId, false, meta);
    expect(onEndpointDisabled).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointId,
        reason: 'consecutive_failures_exceeded',
      }),
    );
  });

  it('should not call callback on successful delivery', async () => {
    const onEndpointDisabled = jest.fn();
    await circuitBreaker.afterDelivery(endpointId, true, meta);
    expect(onEndpointDisabled).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 테스트 실행**

```bash
npm test
```

Expected: 모든 테스트 통과

- [ ] **Step 4: 커밋**

```bash
git add test/
git commit -m "test: add notification callback tests for DeliveryWorker and CircuitBreaker"
```

---

## Task 5: 버전 업 + 배포

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 버전 업**

`package.json`의 `version`을 `0.5.0` → `0.6.0`으로 변경.

- [ ] **Step 2: 전체 빌드 + 테스트**

```bash
npm run build && npm test
```

Expected: 빌드 성공, 모든 테스트 통과

- [ ] **Step 3: 커밋 + 태그**

```bash
git add package.json
git commit -m "chore: bump version to 0.6.0"
git tag v0.6.0
```

- [ ] **Step 4: npm 배포**

```bash
npm publish
```

---

## 요약

| Task | 내용 | 변경 파일 수 |
|------|------|-------------|
| 1 | Context 인터페이스 + 콜백 옵션 | 2 |
| 2 | DeliveryWorker — onDeliveryFailed 호출 | 1 |
| 3 | CircuitBreaker — onEndpointDisabled 호출 | 1~2 |
| 4 | 테스트 | 2 |
| 5 | 버전 업 + 배포 | 1 |

설계 원칙:
- 콜백은 fire-and-forget — try-catch로 감싸서 배달 처리에 영향 없음
- 콜백 미등록 시 기존 동작과 동일 (하위호환)
- `void | Promise<void>` 지원 — 동기/비동기 모두 사용 가능
