# v0.1.0 SOLID Verification Report

작성일: 2026-04-11
검증 대상: `@nestarc/webhook` v`0.1.0`
검증 환경: Node.js `v24.11.1`, npm `11.6.2`, 로컬 Docker PostgreSQL(`postgres:16-alpine`)

## 1. 결론

현재 구현은 기능 관점에서는 안정적이며, SOLID 관점에서는 **부분 준수** 수준이다.

- `SRP`: 대체로 준수, 다만 `WebhookDeliveryWorker`와 `WebhookAdminService`에 책임이 집중되어 있다.
- `OCP`: 부분 준수, 이벤트 추가는 열려 있으나 배달 정책과 전송 수단 확장은 코드 수정이 필요하다.
- `LSP`: 대체로 준수, `WebhookEvent` 기반 확장은 자연스럽다. 다만 `eventType` 계약이 관례에 의존한다.
- `ISP`: 부분 준수, DTO 인터페이스는 가볍지만 서비스들이 `WebhookModuleOptions`와 `prisma: any`에 과도하게 의존한다.
- `DIP`: 미흡, 핵심 유스케이스가 Prisma, `fetch`, `setInterval` 같은 구체 구현에 직접 결합되어 있다.

요약하면, 이 프로젝트는 **작은 모듈 기준으로는 구조가 명확한 편**이지만, 향후 기능 확장과 인프라 교체를 고려하면 `OCP`, `ISP`, `DIP` 보강이 필요하다.

## 2. 실행한 검증

### 2.1 정적/단위 검증

```bash
npm run lint
npm run build
npm test -- --runInBand
```

결과:

- `lint`: 통과
- `build`: 통과
- `test`: 7 suites, 66 tests 모두 통과

### 2.2 통합(E2E) 검증

```bash
docker compose -f docker-compose.test.yml up -d
npm run test:e2e -- --runInBand
docker compose -f docker-compose.test.yml down
```

결과:

- PostgreSQL 테스트 컨테이너 기동/종료 성공
- `test:e2e`: 1 suite, 8 tests 모두 통과

검증된 대표 시나리오:

- 정상 배달
- 이벤트 구독 필터링
- wildcard 구독
- 재시도 및 최종 실패 처리
- circuit breaker 비활성화
- 수동 재시도
- 테스트 이벤트 발송

## 3. SOLID 평가

### 3.1 S: Single Responsibility Principle

판정: **부분 준수**

잘된 점:

- `WebhookService`는 이벤트 저장과 delivery queue 생성이라는 하나의 유스케이스에 집중되어 있다. (`src/webhook.service.ts:19-90`)
- `WebhookSigner`는 서명 생성/검증과 secret 생성만 담당한다. (`src/webhook.signer.ts:12-50`)
- `WebhookCircuitBreaker`는 실패 누적, 비활성화, 복구 로직만 담당한다. (`src/webhook.circuit-breaker.ts:27-100`)

개선이 필요한 점:

- `WebhookDeliveryWorker`는 아래 책임을 동시에 가진다. (`src/webhook.delivery-worker.ts:52-279`)
  - pending delivery claim
  - endpoint/event enrichment
  - HTTP 전송
  - backoff 계산
  - delivery 상태 전이
  - circuit breaker 연동
  - graceful shutdown 관리
- `WebhookAdminService`도 endpoint CRUD, delivery 로그 조회, 수동 재시도, 테스트 이벤트 생성, secret 검증을 모두 포함한다. (`src/webhook.admin.service.ts:28-213`)

해석:

현재 크기에서는 관리 가능하지만, retry 정책 변경, HTTP 클라이언트 교체, admin API 확장 같은 요구가 들어오면 두 클래스가 동시에 비대해질 가능성이 높다.

### 3.2 O: Open/Closed Principle

판정: **부분 준수**

잘된 점:

- 새로운 이벤트 타입은 `WebhookEvent`를 상속한 클래스만 추가하면 된다. 기존 발행/전송 로직을 수정할 필요가 없다. (`src/webhook.event.ts:1-14`, `src/webhook.service.ts:19-33`)
- 모듈 설정도 `forRoot`, `useFactory`, `useClass`, `useExisting`으로 확장 가능하다. (`src/webhook.module.ts:35-97`)

개선이 필요한 점:

- `DeliveryOptions`에 `backoff` 옵션이 있지만 실제 구현은 `DEFAULT_BACKOFF_SCHEDULE`에 고정되어 있다. (`src/interfaces/webhook-options.interface.ts:3-8`, `src/webhook.delivery-worker.ts:199-207`)
- 배달 전송 수단이 `fetch`로 하드코딩되어 있어, 다른 HTTP 클라이언트나 프록시/관측 계층을 붙이려면 `WebhookDeliveryWorker`를 직접 수정해야 한다. (`src/webhook.delivery-worker.ts:164-174`)
- circuit breaker 정책도 연속 실패 기반으로 고정되어 있어, half-open 상태나 `Retry-After` 기반 정책으로 확장하려면 구현 수정이 필요하다. (`src/webhook.circuit-breaker.ts:46-92`)

해석:

이벤트 타입 확장에는 열려 있지만, **전송 정책과 인프라 정책 확장에는 닫혀 있지 않다.**

### 3.3 L: Liskov Substitution Principle

판정: **대체로 준수**

잘된 점:

- `WebhookService`는 `WebhookEvent`의 구체 타입을 알 필요 없이 `eventType`, `toPayload()`만 사용한다. (`src/webhook.service.ts:27-33`)
- `WebhookEvent` 하위 타입은 같은 방식으로 직렬화되어 동일하게 처리된다. (`src/webhook.event.ts:4-14`)
- `WebhookOptionsFactory`도 동일한 `WebhookModuleOptions`만 반환하면 `useClass`/`useExisting`에서 대체 가능하다. (`src/interfaces/webhook-options.interface.ts:27-35`, `src/webhook.module.ts:63-82`)

주의점:

- `WebhookEvent`는 `static eventType` 존재를 타입 시스템이나 런타임에서 강제하지 않는다. (`src/webhook.event.ts:1-6`)
- 하위 클래스가 이 관례를 지키지 않으면 `WebhookService`는 `undefined`를 `event_type`에 넣으려 하게 되고, 실제 실패는 DB 제약에서 늦게 드러난다. (`src/webhook.service.ts:31-40`, `src/sql/create-webhook-tables.sql:30-36`)

해석:

현재 상속 구조는 자연스럽지만, 하위 타입 계약이 문서/관례에 의존한다는 점에서 완전한 LSP 준수라고 보기는 어렵다.

### 3.4 I: Interface Segregation Principle

판정: **부분 준수**

잘된 점:

- `CreateEndpointDto`, `UpdateEndpointDto`, `DeliveryLogFilters`는 목적별로 분리되어 있고 불필요하게 큰 인터페이스가 아니다. (`src/interfaces/webhook-endpoint.interface.ts`, `src/interfaces/webhook-delivery.interface.ts`)
- `WebhookOptionsFactory`도 `createWebhookOptions()` 한 메서드만 요구한다. (`src/interfaces/webhook-options.interface.ts:27-29`)

개선이 필요한 점:

- 모든 핵심 서비스가 동일한 `WebhookModuleOptions` 전체에 의존하고, 그 안의 `prisma: any`를 직접 꺼내 쓴다. (`src/webhook.service.ts:12-17`, `src/webhook.admin.service.ts:20-26`, `src/webhook.delivery-worker.ts:40-50`, `src/webhook.circuit-breaker.ts:16-25`)
- 결과적으로 각 서비스는 실제로 필요한 것보다 훨씬 큰 의존 객체에 결합된다.
- `WebhookAdminService` 역시 endpoint 관리만 필요한 소비자에게 delivery 로그, retry, test event까지 포함한 넓은 API를 함께 노출한다. (`src/webhook.admin.service.ts:28-195`)

해석:

인터페이스는 작게 시작했지만, **인프라 의존 인터페이스는 아직 분리되지 않았다.**

### 3.5 D: Dependency Inversion Principle

판정: **미흡**

잘된 점:

- 내부 협력 객체인 `WebhookSigner`, `WebhookCircuitBreaker`는 생성자 주입으로 연결된다. (`src/webhook.delivery-worker.ts:40-45`, `src/webhook.admin.service.ts:20-24`)
- Nest DI를 활용해 모듈 옵션을 토큰으로 주입한다. (`src/webhook.module.ts:39-49`)

개선이 필요한 점:

- 핵심 유스케이스가 추상 포트가 아니라 Prisma 구체 API에 직접 의존한다. (`src/webhook.service.ts:35-70`, `src/webhook.admin.service.ts:37-191`, `src/webhook.circuit-breaker.ts:35-92`)
- `WebhookDeliveryWorker`는 전송 추상화 없이 전역 `fetch`를 직접 호출한다. (`src/webhook.delivery-worker.ts:164-174`)
- 스케줄링도 `setInterval()`에 직접 의존한다. (`src/webhook.module.ts:100-107`)
- `prisma` 타입이 `any`이기 때문에 의존 경계가 문서화되지 않고, 테스트에서도 ad-hoc mock 객체로만 맞춰지고 있다. (`src/interfaces/webhook-options.interface.ts:20-24`)

해석:

현재 구조는 "Nest DI를 사용한다"는 수준이지, **도메인 계층이 추상화에 의존한다**는 수준에는 도달하지 못했다.

## 4. 우선순위별 개선 권고

### 우선순위 1. 저장소와 전송 포트 도입

다음 추상화를 먼저 도입하는 것이 가장 효과적이다.

- `WebhookEventRepository`
- `WebhookEndpointRepository`
- `WebhookDeliveryRepository`
- `WebhookHttpClient`

효과:

- `DIP`, `ISP`를 동시에 개선
- Prisma 교체 또는 SQL 구조 변경 영향 축소
- `WebhookDeliveryWorker` 테스트를 더 단순한 단위 테스트로 축소 가능

### 우선순위 2. `WebhookDeliveryWorker` 분해

권장 분해 방향:

- `DeliveryPoller`: claim + batching
- `WebhookDispatcher`: HTTP 전송
- `RetryPolicy`: 다음 시도 시각 계산
- `DeliveryStateService`: SENT/FAILED/PENDING 상태 전이

효과:

- `SRP` 개선
- 전송 정책과 backoff 정책을 별도 전략으로 바꿔 `OCP` 개선

### 우선순위 3. 옵션 구조 축소와 타입 명확화

권장 방향:

- `WebhookModuleOptions.prisma: any` 제거
- 필요한 최소 메서드만 가진 포트 인터페이스로 교체
- delivery/polling/circuit breaker 설정도 서비스별 토큰으로 분리

효과:

- `ISP`, `DIP` 개선
- 테스트 더블이 계약 기반으로 정리됨

### 우선순위 4. `WebhookEvent` 계약 강화

권장 방향:

- `send()` 초입에서 `event.eventType` 유효성 검사
- 또는 `WebhookEvent`에 `assertValid()` 같은 보호 메서드 추가

효과:

- `LSP` 리스크 감소
- 오류를 DB 제약 전에 빠르게 노출

### 우선순위 5. Admin API 분리

다음처럼 나누는 편이 자연스럽다.

- `WebhookEndpointAdminService`
- `WebhookDeliveryAdminService`

효과:

- `SRP`, `ISP` 개선
- 향후 REST/API 권한 분리 시에도 유리

## 5. 최종 판단

`@nestarc/webhook` v`0.1.0`은 작은 라이브러리 규모에 맞는 실용적 구조를 갖고 있고, 현재 테스트와 E2E 기준으로는 안정적으로 동작한다. 다만 SOLID 기준으로 보면 **기능 구현은 잘 되어 있지만, 확장성과 의존성 역전은 아직 초기 단계**다.

특히 다음 두 축이 핵심이다.

- 배달 워커의 책임 분해
- Prisma/HTTP/스케줄러에 대한 추상화 도입

이 두 가지를 우선 정리하면, 현재 코드의 장점인 단순성과 테스트 가능성을 유지하면서도 `v0.2.x` 이후 기능 확장에 훨씬 유리한 구조가 될 가능성이 높다.
