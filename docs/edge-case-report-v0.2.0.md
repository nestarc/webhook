# v0.2.0 Edge Case Report

작성일: 2026-04-11
검증 대상: `@nestarc/webhook` v`0.2.0`
검증 환경: Node.js `v24.11.1`, npm `11.6.2`, 로컬 Docker PostgreSQL(`postgres:16-alpine`)

## 1. 결론

현재 구현은 핵심 delivery 흐름의 엣지케이스를 이미 꽤 잘 커버하고 있다.

- 단위 테스트: `11 suites / 110 tests` 통과
- E2E 테스트: `1 suite / 8 tests` 통과
- 과거에 리스크로 분류됐던 `이벤트 저장+delivery 생성 트랜잭션화`, `pending delivery가 없어도 circuit breaker 복구 수행`은 현재 코드에서 해소되었다.

다만 운영 신뢰성과 보안 관점에서 우선 추적해야 할 항목이 3가지 남아 있다.

- SSRF 우회 가능성: hostname 기반 private target, redirect, IPv4-mapped IPv6
- 비정상 종료 시 `SENDING` delivery 영구 고착 가능성
- delivery 상태 저장 이후 후속 로직 실패 시 `PENDING`으로 되돌리는 상태 회귀 문제

## 2. 이번에 확인한 범위

실행한 검증:

```bash
npm run build
npm test -- --runInBand
docker compose -f docker-compose.test.yml up -d
npm run test:e2e -- --runInBand
docker compose -f docker-compose.test.yml down
```

추가 확인:

```bash
node -e "const {validateWebhookUrl}=require('./dist/webhook.url-validator'); ..."
node -e "const u=new Request('http://example.com'); console.log(u.redirect)"
```

## 3. 현재 커버된 엣지케이스

### 3.1 입력/보안

커버됨:

- 잘못된 scheme 차단
- 파싱 불가 URL 차단
- `localhost`, loopback, private IPv4, link-local, metadata IP 차단
- private IPv6, loopback IPv6 차단
- base64 secret 형식 및 최소 길이 검증

관련 테스트:

- `src/webhook.url-validator.spec.ts`
- `src/webhook.endpoint-admin.service.spec.ts`

### 3.2 delivery 상태 전이

커버됨:

- 성공 시 `SENT`
- 실패 후 재시도 예약
- 최대 재시도 초과 시 `FAILED`
- dispatch 예외 시 `PENDING` 복구
- graceful shutdown 중 active delivery 대기
- poll 중복 실행 방지

관련 테스트:

- `src/webhook.delivery-worker.spec.ts`
- `test/e2e/webhook.e2e-spec.ts`

### 3.3 circuit breaker / 복구

커버됨:

- threshold 미만 실패 누적
- threshold 도달/초과 시 비활성화
- cooldown 경과 시 자동 복구
- pending delivery가 없어도 복구 루틴 수행

관련 코드/테스트:

- `src/webhook.circuit-breaker.ts`
- `src/webhook.delivery-worker.ts`
- `src/webhook.circuit-breaker.spec.ts`
- `src/webhook.delivery-worker.spec.ts`

### 3.4 데이터 정합성

커버됨:

- 이벤트 저장과 delivery 생성이 하나의 transaction에서 실행됨
- delivery 생성 실패 시 전체 실패로 전파
- tenant scope 전달

관련 코드/테스트:

- `src/webhook.service.ts`
- `src/webhook.service.spec.ts`

## 4. 확인된 리스크

### 리스크 1. SSRF 우회 경로가 남아 있음

우선순위: 높음

근거:

- `validateWebhookUrl()`는 literal IP와 일부 hostname만 차단한다. `src/webhook.url-validator.ts:10-37`
- hostname이 private IP로 해석되는 경우는 검사하지 않는다.
- `FetchHttpClient`는 `fetch()` 호출 시 redirect 정책을 지정하지 않는다. `src/adapters/fetch-http-client.ts:18-28`
- 표준 fetch 기본값은 redirect `follow`이며, 이번 확인에서도 `new Request('http://example.com').redirect` 결과가 `follow`였다.

이번 로컬 확인 결과:

- `http://[::ffff:127.0.0.1]/hook` → 허용됨
- `http://[::ffff:10.0.0.1]/hook` → 허용됨
- `http://customer.127.0.0.1.nip.io/hook` → 허용됨

영향:

- endpoint 등록 시 public-looking hostname으로 우회 가능하다.
- public URL이 등록된 뒤 private target으로 redirect 되면 내부망 접근이 가능할 수 있다.

권고:

- hostname 등록 시 DNS lookup 후 private/link-local/loopback 여부를 검사
- IPv4-mapped IPv6(`::ffff:x.x.x.x`) 명시 차단
- HTTP client에서 redirect를 `manual`로 두고 `3xx`는 실패 처리
- 해당 케이스를 unit + integration 테스트로 추가

### 리스크 2. 프로세스 비정상 종료 시 `SENDING` delivery가 고착될 수 있음

우선순위: 높음

근거:

- claim 단계에서 row를 `SENDING`으로 바꾼다. `src/adapters/prisma-delivery.repository.ts:35-53`
- 복구 로직은 worker 내부 catch에서만 `resetToPending()`을 호출한다. `src/webhook.delivery-worker.ts:89-91`
- stale `SENDING` row를 다시 claim하거나 timeout으로 복구하는 코드가 없다.

영향:

- worker 프로세스가 `kill -9`, OOM, container eviction 등으로 죽으면 일부 delivery가 영구 정체될 수 있다.
- graceful shutdown 테스트는 있어도 hard crash 복구는 보장되지 않는다.

권고:

- `claimed_at` 또는 `updated_at` 기반 lease timeout 도입
- 다음 poll에서 오래된 `SENDING` row를 `PENDING`으로 재복구하는 reaper 추가
- 강제 종료/중단 후 재기동 시 delivery가 다시 처리되는 E2E 추가

### 리스크 3. 상태 저장 이후 후속 처리 실패 시 delivery가 잘못 복구될 수 있음

우선순위: 높음

근거:

- `processDelivery()`는 `markSent()`/`markFailed()`/`markRetry()`와 `circuitBreaker.afterDelivery()`를 같은 `try` 블록 안에서 처리한다. `src/webhook.delivery-worker.ts:66-91`
- 이 중 앞 단계의 DB 상태 저장은 성공했지만 뒤 단계(`afterDelivery`)가 실패하면 catch에서 무조건 `resetToPending()`을 수행한다.

영향:

- 이미 `SENT`로 저장된 delivery가 다시 `PENDING`이 되어 중복 발송될 수 있다.
- 이미 `FAILED`로 확정된 delivery가 다시 `PENDING`이 되어 `max_attempts`를 넘겨 재처리될 수 있다.

현재 테스트 한계:

- `src/webhook.delivery-worker.spec.ts`는 `markSent()` 자체가 throw 하는 경우만 검증한다.
- `markSent()` 성공 후 `afterDelivery()` 실패, `markFailed()` 성공 후 `afterDelivery()` 실패는 검증하지 않는다.

권고:

- delivery 상태 저장과 circuit breaker 후속 처리를 분리
- 상태 저장 이후 단계 실패 시 delivery 상태는 되돌리지 않도록 변경
- 위 두 조합에 대한 단위 테스트 추가

## 5. 보강이 필요한 테스트 구간

### 우선 추가할 테스트

1. URL validator 단위 테스트

- `http://[::ffff:127.0.0.1]/hook`
- `http://[::ffff:10.0.0.1]/hook`
- `http://customer.127.0.0.1.nip.io/hook`

2. HTTP client 단위 테스트

- timeout 시 abort 결과가 `success: false`로 기록되는지
- `302/307` redirect를 따라가지 않도록 막는지
- 매우 큰 응답 body에 대해 메모리 사용 없이 길이 제한이 동작하는지

3. delivery worker 단위 테스트

- `markSent()` 성공 후 `afterDelivery()` 실패
- `markFailed()` 성공 후 `afterDelivery()` 실패
- `markRetry()` 성공 후 `afterDelivery()` 실패

4. cross-instance E2E

- 동일 DB를 공유하는 worker 2개가 동시에 poll 해도 한 delivery가 1번만 전송되는지

5. crash recovery E2E

- `SENDING` 상태로 남겨둔 row를 재기동 후 다시 처리하는지

### 추가하면 좋은 테스트

- manual retry 후 실패했을 때 attempts/상태가 어떻게 남는지 명세화
- delivery log filter의 `since`/`until`/pagination 조합
- disabled endpoint가 manual retry 대상일 때의 동작
- large fan-out에서 `batchSize` 경계값 동작

## 6. 현재 기준 판단

현재 `@nestarc/webhook`는 일반적인 장애 흐름과 재시도/circuit breaker 시나리오까지는 자동 검증이 가능한 상태다. 즉, "사용자가 아직 없어서 엣지케이스 테스트를 못 한다"는 상태는 아니다.

다만 운영 배포 전 신뢰성 기준으로 보면, 다음 순서로 보강하는 것이 적절하다.

1. SSRF 우회 차단
2. stale `SENDING` 복구
3. post-persist 예외 시 상태 회귀 방지
4. multi-worker E2E 추가

이 4가지를 정리하면 현재 코드의 핵심 리스크 대부분이 해소된다.
