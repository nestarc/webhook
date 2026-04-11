# v0.1.0 Verification Report

작성일: 2026-04-11
검증 대상: `@nestarc/webhook` v`0.1.0`
검증 환경: Node.js `v24.11.1`, 로컬 Docker PostgreSQL(`postgres:16-alpine`)

## 1. 결론

`0.1.0` 구현은 기본 기능 기준으로는 배포 가능한 수준이다.

- 타입체크 통과
- 빌드 통과
- 단위 테스트 45/45 통과
- E2E 테스트 8/8 통과
- 패키징 드라이런 통과

다만, 실제 운영 신뢰성 관점에서 릴리스 전에 추적해야 할 구현 리스크 3건이 확인되었다.

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
- `test`: 6 suites, 45 tests 모두 통과

### 2.2 통합(E2E) 검증

```bash
docker compose -f docker-compose.test.yml up -d
npm run test:e2e -- --runInBand
```

결과:

- PostgreSQL 테스트 컨테이너 기동 성공
- `test:e2e`: 1 suite, 8 tests 모두 통과

검증된 시나리오:

- 등록된 endpoint로 정상 배달
- 이벤트 구독 필터링
- wildcard(`*`) 구독
- 실패 후 재시도
- 최대 재시도 초과 시 `FAILED`
- 연속 실패 시 circuit breaker 비활성화
- 수동 재시도
- `webhook.test` 테스트 이벤트

### 2.3 패키징 검증

```bash
npm pack --dry-run --cache .npm-cache
```

결과:

- tarball 생성 드라이런 통과
- `dist/**`, `README.md`, `LICENSE`, `src/sql/create-webhook-tables.sql` 포함 확인

참고:

- 기본 npm 캐시 디렉터리(`~/.npm`)는 로컬 권한 문제로 실패했고, 프로젝트 로컬 캐시(`.npm-cache`)로 우회했다.
- 이는 현재 개발 환경 이슈이며 패키지 산출물 자체 문제는 아니다.

## 3. 확인된 이슈

### 이슈 1. 자동 복구가 "대기 중 delivery가 있을 때만" 동작함

관련 코드:

- `src/webhook.delivery-worker.ts:75`
- `src/webhook.delivery-worker.ts:85`
- `README.md:12`

설명:

`poll()`은 pending delivery가 하나도 없으면 즉시 `return`한다. 따라서 `recoverEligibleEndpoints()`는 delivery를 실제로 처리한 poll cycle에서만 호출된다.

영향:

- 장애 후 cooldown 시간이 지나도 시스템에 pending delivery가 없으면 endpoint가 자동 복구되지 않는다.
- README의 "auto-recover after cooldown" 설명과 실제 동작이 다르다.

권고:

- `recoverEligibleEndpoints()`를 delivery 유무와 무관하게 매 poll cycle에서 실행하도록 이동
- 이 동작을 검증하는 테스트 추가

### 이슈 2. 이벤트 저장과 delivery 생성이 하나의 트랜잭션이 아님

관련 코드:

- `src/webhook.service.ts:35`
- `src/webhook.service.ts:55`
- `src/webhook.service.ts:94`

설명:

이벤트는 먼저 `webhook_events`에 저장되고, 이후 별도 쿼리로 `webhook_deliveries`가 생성된다. 중간 단계에서 예외가 나면 이벤트만 저장되고 실제 배달 레코드는 생성되지 않을 수 있다.

영향:

- 프로듀서 입장에서는 `send()`가 실패하거나 중단되었는데 DB에는 이벤트가 남는 불완전 상태가 발생할 수 있다.
- "유실 없는 delivery queue" 기대치가 있는 사용자에게는 운영상 혼란을 줄 수 있다.

권고:

- event insert, endpoint 조회, delivery insert를 하나의 DB transaction으로 묶기
- 부분 실패 시 롤백되는 테스트 추가

### 이슈 3. 문서화된 signing 옵션이 실제 구현에 반영되지 않음

관련 코드:

- `src/interfaces/webhook-options.interface.ts:3`
- `src/webhook.signer.ts:12`
- `README.md:51`
- `README.md:162`

설명:

공개 옵션 타입과 README는 `signing.algorithm`, `signing.headerName`을 지원하는 것처럼 보이지만, `WebhookSigner`는 옵션을 주입받지 않고 항상 `sha256`과 고정 헤더(`webhook-id`, `webhook-timestamp`, `webhook-signature`)만 사용한다.

영향:

- 사용자는 설정이 반영된다고 오해할 수 있다.
- 문서와 실제 API 계약이 어긋난다.

권고:

- 옵션을 실제 구현에 연결하거나
- 0.1.0 범위라면 README와 타입에서 아직 미지원인 옵션을 제거

## 4. 잔여 리스크

- 테스트는 PostgreSQL happy path 기준이며, 네트워크 타임아웃/연결 재설정/대용량 응답 본문 등 운영 환경 변형 케이스는 추가 검증이 필요하다.
- `WebhookModule`의 poll interval은 단순 `setInterval()` 기반이라, poll 실행 시간이 interval보다 길어질 때 중첩 실행 거동을 별도로 검증하지 않았다.
- 수동 secret 입력 시 base64 형식 검증이 없어, 사용자 문서에 secret 포맷 요구사항을 명시하는 편이 안전하다.

## 5. 최종 판단

현재 `0.1.0`은 핵심 기능 구현과 기본 테스트 커버리지는 확보되었다. 단, 운영 신뢰성 기대치를 높게 잡는 패키지 성격상 위 3개 이슈는 `0.1.1` 또는 다음 마이너 릴리스에서 우선 정리하는 것이 적절하다.
