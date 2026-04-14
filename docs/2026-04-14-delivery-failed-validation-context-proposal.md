# 제안: `onDeliveryFailed`에 URL validation reason 전파

- 날짜: 2026-04-14
- 대상 버전: `@nestarc/webhook` 현재 main 기준, semver minor 제안
- 제안 배경: `webhook-platform` worker 리뷰의 W2 후속 조치
- 관련 파일:
  - `src/interfaces/webhook-options.interface.ts`
  - `src/webhook.dispatcher.ts`
  - `src/webhook.delivery-worker.ts`
  - `src/webhook.url-validator.ts`

---

## 요약

엔진은 이미 `src/webhook.url-validator.ts`의 `WebhookUrlValidationError`로 URL/DNS validation 실패를 구조화해서 표현하고 있습니다. 하지만 delivery worker가 dispatch 예외를 처리하는 과정에서 이 구조화 정보가 사라지고, 최종적으로 `onDeliveryFailed` callback에는 `lastError: string | null`만 전달됩니다.

그 결과 consumer는 다음을 할 수 없습니다.

1. `private`, `loopback`, `link_local`, `scheme`, `parse` 같은 validation reason을 구조적으로 구분
2. 단순 네트워크 장애/HTTP 5xx와 URL validation 실패를 분리
3. worker/digest/alerting에서 안전하게 분기

결론적으로, URL validation error 클래스가 이미 있어도 **delivery hook context까지 reason이 전달되지 않으면 운영 관측 가능성은 여전히 부족**합니다.

---

## 현재 상태

### 1. validator는 구조화 정보를 이미 제공함

`src/webhook.url-validator.ts`에는 아래 정보가 이미 있습니다.

- `WebhookUrlValidationError`
- `reason: WebhookUrlValidationReason`
- `url?: string`
- `resolvedIp?: string`

즉 엔진 내부에서는 validation 실패의 세부 원인을 이미 알고 있습니다.

### 2. dispatch 단계에서 validation error가 throw 됨

`src/webhook.dispatcher.ts`에서 delivery 전마다 `resolveAndValidateHost(hostname)`를 호출합니다.

```ts
if (!this.allowPrivateUrls) {
  const hostname = new URL(delivery.url).hostname;
  await resolveAndValidateHost(hostname);
}
```

여기서 `WebhookUrlValidationError`가 발생할 수 있습니다.

### 3. 하지만 delivery worker에서 구조화 정보가 문자열로 축소됨

`src/webhook.delivery-worker.ts`의 `processDelivery()` catch 블록은 현재 예외를 다음처럼 처리합니다.

```ts
const errorResult = {
  success: false as const,
  latencyMs: 0,
  error: error instanceof Error ? error.message : String(error),
};
```

그리고 retries 소진 시 `fireDeliveryFailedHook()`에는 아래 정보만 전달합니다.

- `deliveryId`
- `endpointId`
- `eventId`
- `tenantId`
- `attempts`
- `maxAttempts`
- `lastError`
- `responseStatus`

현재 `DeliveryFailedContext`에는 validation metadata가 전혀 없습니다.

---

## 문제

### 1. consumer가 validation 실패를 문자열 매칭으로만 구분해야 함

현재 consumer가 hook에서 URL validation failure를 식별하려면 `lastError`를 보고 문자열 매칭을 해야 합니다.

예:
- `private address`
- `loopback address`
- `unable to parse`
- `scheme must be http or https`

이 방식은 brittle합니다.

### 2. 운영 관측이 흐려짐

worker/digest/alerting 관점에서는 아래가 모두 `lastError` 문자열 한 칸으로 뭉개집니다.

- DNS resolution 기반 private IP 차단
- malformed URL
- http/https 외 scheme
- 일반 네트워크 예외
- downstream 코드 버그

즉 “delivery 실패”는 알 수 있어도 “왜 실패했는지”를 안정적으로 구분할 수 없습니다.

### 3. 엔진이 이미 아는 정보를 consumer에게 버리고 있음

`WebhookUrlValidationError.reason`과 `resolvedIp`는 엔진 내부에서 이미 계산됩니다. 그런데 현재 경로에서는 그 정보를 버리고 `message`만 남깁니다.

이건 새 로직이 필요한 문제가 아니라, **기존 structured error를 hook contract로 이어주지 못한 문제**에 가깝습니다.

---

## 제안

### 권장안: `DeliveryFailedContext`를 optional field로 확장

기존 contract를 깨지 않도록 `DeliveryFailedContext`에 optional field를 추가합니다.

```ts
export interface DeliveryFailedContext {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  tenantId: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  responseStatus: number | null;

  failureKind?: 'url_validation' | 'dispatch_error' | 'http_error';
  validationReason?: WebhookUrlValidationReason;
  validationUrl?: string;
  resolvedIp?: string;
}
```

핵심은 `validationReason`을 optional로 추가하는 것입니다. `failureKind`는 consumer가 1차 분기를 더 쉽게 하도록 돕는 보조 필드입니다.

### worker에서 `WebhookUrlValidationError`를 보존

`src/webhook.delivery-worker.ts`의 예외 경로에서 `error instanceof WebhookUrlValidationError`를 분기하고, retries 소진 시 hook으로 구조화 정보를 같이 넘깁니다.

예상 형태(즉, `fireDeliveryFailedHook()` helper도 optional metadata를 받도록 함께 조정):

```ts
if (error instanceof WebhookUrlValidationError) {
  this.fireDeliveryFailedHook(delivery, newAttempts, error.message, null, {
    failureKind: 'url_validation',
    validationReason: error.reason,
    validationUrl: error.url ?? delivery.url,
    resolvedIp: error.resolvedIp,
  });
}
```

일반 예외는 기존처럼 `lastError`만 넘기면 됩니다.

### hook 함수 시그니처는 유지

`onDeliveryFailed?: (context: DeliveryFailedContext) => void | Promise<void>`는 그대로 유지하고, context 내부 필드만 확장합니다.

이렇게 하면 기존 consumer는 아무 수정 없이 계속 동작합니다.

---

## 왜 이 방식이 좋은가

### 1. 하위 호환성이 높음

기존 필드를 삭제/변경하지 않고 optional field만 추가하므로 minor release로 처리할 수 있습니다.

### 2. worker/platform consumer가 바로 활용 가능함

예를 들어 consumer는 다음처럼 안정적으로 분기할 수 있습니다.

```ts
if (ctx.validationReason === 'private' || ctx.validationReason === 'loopback') {
  // endpoint 설정 오류로 분류
}
```

문자열 매칭이 필요 없습니다.

### 3. 기존 URL validator 제안과 자연스럽게 이어짐

이미 `WebhookUrlValidationError` 자체는 엔진에 존재하므로, 이번 작업은 새 분류 체계를 만드는 것이 아니라 **기존 분류를 hook contract까지 연결하는 마무리 작업**입니다.

---

## 비권장 대안

### 1. `lastError` 문자열만 유지하고 consumer에서 파싱

단기 우회는 가능하지만, 에러 메시지 wording 변경에 취약합니다. 엔진이 structured reason을 이미 알고 있으므로 굳이 consumer에게 문자열 파싱 부담을 넘길 이유가 없습니다.

### 2. 새 callback (`onDeliveryValidationFailed`) 추가

가능은 하지만 범위가 커집니다. 먼저 `onDeliveryFailed` context 확장만으로도 W2의 실질 문제는 해소됩니다. 별도 callback은 후속 단계가 더 적절합니다.

### 3. `DeliveryFailedContext`를 discriminated union으로 재설계

타입적으로 가장 깔끔할 수 있지만, 기존 consumer 영향과 문서/테스트 범위가 커집니다. 이번 요구는 optional field 확장이 현실적입니다.

---

## 구현 범위

### 필수

1. `DeliveryFailedContext`에 optional metadata 추가
2. `WebhookDeliveryWorker`에서 `WebhookUrlValidationError`를 분기
3. retries exhausted 경로에서 validation metadata를 `onDeliveryFailed`로 전달
4. `webhook.delivery-worker.spec.ts`에 validation error propagation 테스트 추가
5. README 또는 hook 예제 문서에 새 필드 사용 예시 추가

### 선택

- `failureKind`를 더 세분화할지 결정
- 내부 persistence layer에도 validation reason을 저장할지 검토
- 장기적으로 `onDeliveryFailed` 외 별도 validation hook 도입 검토

---

## 테스트 제안

### worker spec

`src/webhook.delivery-worker.spec.ts`에 아래 케이스가 필요합니다.

1. `WebhookDispatcher.dispatch()`가 `WebhookUrlValidationError('private')`를 throw
2. retries exhausted
3. `onDeliveryFailed`가 아래를 받는지 검증

```ts
expect(onDeliveryFailed).toHaveBeenCalledWith(
  expect.objectContaining({
    lastError: expect.stringContaining('private address'),
    failureKind: 'url_validation',
    validationReason: 'private',
    resolvedIp: '10.0.0.1',
  }),
);
```

### regression

- 일반 HTTP 실패는 기존처럼 `validationReason` 없이 동작해야 함
- 일반 exception path도 기존 consumer를 깨지 않아야 함
- 기존 `onDeliveryFailed` 테스트는 모두 계속 통과해야 함

---

## semver 판단

- 분류: `minor`
- 이유: public interface에 optional field 추가, 기존 hook 시그니처 유지, 기존 consumer 동작 유지

---

## 정리

이 개선은 “URL validation error 클래스를 만들자”가 아니라, **이미 있는 structured validation error를 delivery hook contract까지 보존해서 전달하자**는 요구입니다.

현재 상태에서는 엔진 내부 정보가 worker hook 직전 사라집니다. 이 한 군데만 연결해 주면 platform/worker consumer가 validation 실패를 안정적으로 분류할 수 있고, worker 리뷰의 W2도 엔진 차원에서 깔끔하게 해소됩니다.

