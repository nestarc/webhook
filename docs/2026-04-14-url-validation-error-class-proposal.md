# 제안: URL 검증 에러 클래스 도입

- **일자:** 2026-04-14
- **제안 버전 타깃:** `@nestarc/webhook` v0.7.0 (minor, 비파괴적)
- **제안자:** 소비자 프로젝트 (`webhook-platform`) API 코드 리뷰 과정에서 도출
- **관련 파일:** `src/webhook.url-validator.ts`, `src/webhook.endpoint-admin.service.ts`, `src/index.ts`

---

## 배경

`validateWebhookUrl()`과 `resolveAndValidateHost()`는 검증 실패 시 **plain `Error`** 를 던진다. 소비자가 HTTP 4xx/5xx를 분기하려면 메시지 문자열 매칭에 의존해야 한다.

### 소비자 측 실제 사례 (`webhook-platform/apps/api/src/endpoints/endpoints.service.ts`)

```ts
try {
  return await this.endpointAdmin.createEndpoint({ ... });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.toLowerCase().includes('invalid webhook url') ||
    msg.toLowerCase().includes('private address')
  ) {
    throw new BadRequestException(msg);
  }
  throw err;  // 500
}
```

**문제:**
1. 현재 던져지는 메시지는 최소 6종이며 일부만 매칭됨 (`loopback`, `link-local`, `not a valid target`, `scheme must be`, `unable to parse`는 우연히 prefix로 커버).
2. 엔진이 메시지를 리팩터링하면 소비자가 **조용히 400 → 500으로 회귀**.
3. DB/네트워크 에러와 URL 검증 에러가 같은 `Error` 타입이라 catch 분기 불가.

---

## 제안: 전용 에러 클래스 export

### API

```ts
// src/webhook.url-validator.ts 신규 export
export type WebhookUrlValidationReason =
  | 'parse'            // URL 파싱 실패
  | 'scheme'           // http/https 외 스킴
  | 'blocked_hostname' // localhost 등 차단 목록
  | 'loopback'         // 127.0.0.0/8, ::1
  | 'private'          // RFC1918, fc00::/7
  | 'link_local'       // 169.254.0.0/16, fe80::/10, 메타데이터 IP
  | 'invalid_target';  // 기타 유효하지 않은 타깃

export class WebhookUrlValidationError extends Error {
  readonly name = 'WebhookUrlValidationError';
  constructor(
    message: string,
    readonly reason: WebhookUrlValidationReason,
    readonly url?: string,
    readonly resolvedIp?: string,
  ) {
    super(message);
  }
}
```

### 기존 `throw new Error(...)` 위치 치환 예

```ts
// Before
throw new Error(`Invalid webhook URL: "${ip}" is a private address`);

// After
throw new WebhookUrlValidationError(
  `Invalid webhook URL: "${ip}" is a private address`,
  'private',
  url,
  ip,
);
```

메시지 문자열은 **그대로 유지**(호환성). 소비자가 `instanceof` 또는 `err.reason` 기반으로 분기하도록 유도.

### 재export

```ts
// src/index.ts
export {
  validateWebhookUrl,
  resolveAndValidateHost,
  WebhookUrlValidationError,
  type WebhookUrlValidationReason,
} from './webhook.url-validator';
```

---

## 소비자 측 영향 (예상)

```ts
import { WebhookUrlValidationError } from '@nestarc/webhook';

try {
  return await this.endpointAdmin.createEndpoint({ ... });
} catch (err) {
  if (err instanceof WebhookUrlValidationError) {
    throw new BadRequestException({
      message: err.message,
      reason: err.reason,
    });
  }
  throw err;
}
```

- 문자열 매칭 완전 제거
- 엔진 메시지 개정에 회귀 리스크 없음
- `reason` 필드로 **구조화된 에러 응답** 가능 (i18n, 클라이언트 분기)

---

## 하위 호환성

| 기준 | 영향 |
|---|---|
| 기존 `err instanceof Error` 소비자 | ✅ `WebhookUrlValidationError extends Error` → 유지 |
| 기존 문자열 매칭 소비자 | ✅ 메시지 포맷 유지 → 유지 |
| `validateWebhookUrl` 시그니처 | ✅ 변경 없음 (`Promise<void>`) |
| `createEndpoint`, `updateEndpoint` 반환 타입 | ✅ 변경 없음 |

**semver:** minor (신규 export 추가, 기존 동작 유지). 타깃 `0.7.0`.

---

## 구현 범위

### 필수

1. `WebhookUrlValidationError` 클래스 및 `WebhookUrlValidationReason` 타입 추가 (`src/webhook.url-validator.ts`).
2. `validateWebhookUrl`, `resolveAndValidateHost` 내부의 모든 `throw new Error(...)` 자리 치환.
3. `src/index.ts`에서 신규 심볼 export.
4. 테스트: `validateWebhookUrl`이 `WebhookUrlValidationError`를 던지는지, 각 `reason`이 정확히 매핑되는지.

### 선택 (후속 PR 가능)

- `WebhookDeliveryError`, `WebhookSignatureError` 등 다른 plain `Error` 지점도 동일 패턴으로 확장 (본 제안 범위 외).
- `reason` 기반의 i18n 키 매핑 가이드를 README에 추가.

---

## 체크리스트 (구현자용)

- [ ] `WebhookUrlValidationError` 클래스 추가
- [ ] `validateIPv4`, `validateIPv6`, `resolveAndValidateHost`, `validateWebhookUrl` 내부 throw 치환
- [ ] `index.ts` export 추가
- [ ] 기존 스펙(`webhook.url-validator.spec.ts`가 있다면) 업데이트: `expect(...).rejects.toThrow(WebhookUrlValidationError)` + `reason` 검증
- [ ] CHANGELOG.md: "0.7.0 — feat: structured URL validation errors"
- [ ] README: 소비자용 예제 코드 1개 추가
- [ ] `peerDependencies`/빌드 산출물 변화 없음을 확인
- [ ] `npm run prepublishOnly` 통과

---

## 참고: 소비자 측 계약 테스트 예시

엔진 릴리스 후 소비자 측에서 regression 방지:

```ts
it('엔진 URL 검증 에러를 구조화된 400으로 변환', async () => {
  await expect(
    service.create('app_1', { url: 'http://127.0.0.1/hook', events: ['*'] }),
  ).rejects.toMatchObject({
    status: 400,
    response: expect.objectContaining({ reason: 'loopback' }),
  });
});
```

---

## 관련 자료

- 소비자 측 리뷰 보고서: `webhook-platform/docs/reports/2026-04-14-api-code-review.md` W1 항목
- 현 엔진 메시지 리스트 (치환 대상):
  - `Invalid webhook URL: unable to parse "<url>"` → `reason: 'parse'`
  - `Invalid webhook URL: scheme must be http or https, got "<scheme>"` → `reason: 'scheme'`
  - `Invalid webhook URL: "<host>" is not allowed (loopback address)` → `reason: 'blocked_hostname'`
  - `Invalid webhook URL: "<ip>" is a loopback address` → `reason: 'loopback'`
  - `Invalid webhook URL: "<ip>" is a private address` → `reason: 'private'`
  - `Invalid webhook URL: "<ip>" is a link-local/metadata address` → `reason: 'link_local'`
  - `Invalid webhook URL: "<ip>" is not a valid target` → `reason: 'invalid_target'`
