# Engine vs Platform — Handover Document

작성일: 2026-04-11
목적: backend-evaluation-report의 리스크 항목별로, @nestarc/webhook 엔진 수정이 필요한지 vs 플랫폼에서 해결 가능한지를 판정하고, 각각의 구체적인 변경 사항을 기술한다.

## 판정 기준

> "플랫폼(webhook-platform)이 아무리 래핑해도 해결할 수 없는가?"
>
> - Yes → 엔진 수정 필요
> - No → 플랫폼에서 해결

엔진의 raw SQL은 플랫폼에서 접근할 수 없다. Prisma 어댑터가 `$queryRawUnsafe`로 직접 쿼리를 실행하므로, SQL 안의 타입 캐스팅이나 상수는 엔진 코드를 수정하지 않으면 바꿀 수 없다.

---

## 요약

| # | 이슈 | 판정 | 변경 대상 |
|---|------|------|----------|
| 7.1a | API key 해싱 | **플랫폼** | 완료 (apiKey → apiKeyHash, SHA-256) |
| 7.1b | tenantId NOT NULL | **플랫폼** | 완료 (Prisma 스키마에서 nullable 제거) |
| 7.1c | tenantId FK → Application | **엔진** | tenant_id 비교 시 `::text` 캐스트 필요 |
| 7.2 | payload/response 노출 제한 | **플랫폼** | API 응답에서 필터링/truncate |
| 7.3 | UUID param 검증 + 전역 예외 | **플랫폼** | ParseUUIDPipe + AllExceptionsFilter |
| 7.4a | status 자유 문자열 | **엔진** | CHECK 제약 또는 PostgreSQL enum 추가 |
| 7.4b | maxAttempts 기본값 불일치 | **무시 가능** | 엔진이 항상 명시적으로 전달하므로 DB 기본값 미사용 |
| 7.5 | 운영성 자산 부족 | **플랫폼** | health, Dockerfile, 구조화 로그 |
| 7.6 | cursor vs offset | **이미 해결** | cursor 제거, offset 통일 완료 |
| 7.7 | 복합 인덱스 부족 | **플랫폼** | Prisma 마이그레이션으로 추가 |

---

## 엔진 수정 필요 항목

### E1. tenant_id FK를 위한 타입 캐스팅

**문제**: `webhook_endpoints.tenant_id`를 UUID 타입으로 변경하면 엔진의 raw SQL에서 `WHERE tenant_id = $1` 비교가 실패한다. PostgreSQL은 `uuid = text`를 자동 캐스팅하지 않는다.

**영향 받는 SQL** (prisma-endpoint.repository.ts):

```
L40: WHERE active = true AND tenant_id = $1
L64: WHERE active = true AND tenant_id = $1
L89: INSERT INTO webhook_endpoints (..., tenant_id) VALUES (..., $6)
L114: WHERE tenant_id = $1
```

**영향 받는 SQL** (prisma-event.repository.ts):

```
L14: INSERT INTO webhook_events (event_type, payload, tenant_id) VALUES (..., ${tenantId})
L26: INSERT INTO webhook_events (event_type, payload, tenant_id) VALUES (..., ${tenantId})
```

**권장 수정**: 비교 구문에 `::text` 캐스트를 추가하여, tenant_id가 text든 uuid든 동작하게 한다.

```sql
-- 변경 전
WHERE tenant_id = $1

-- 변경 후
WHERE tenant_id::text = $1
```

INSERT는 PostgreSQL이 text → uuid 암시적 캐스팅을 하므로 수정 불필요.

**대안 (FK 없이 진행)**: tenant_id를 text NOT NULL로 유지하고 FK를 포기. 현재 플랫폼은 이 방식으로 동작 중. 애플리케이션 레벨에서 `applicationId` 스코핑이 되어 있으므로 실용적으로는 충분하지만, DB 레벨 무결성은 없다.

**권고**: 당장은 FK 없이 text NOT NULL로 유지 (현재 상태). 엔진 0.4.0에서 `::text` 캐스트를 추가한 후 FK 마이그레이션을 적용.

### E2. delivery status CHECK 제약

**문제**: `webhook_deliveries.status`가 자유 문자열이라 잘못된 값이 들어갈 수 있다.

**영향 받는 SQL**: 엔진 내 모든 `SET status = 'PENDING'`, `'SENDING'`, `'SENT'`, `'FAILED'` 리터럴.

**권장 수정**: 엔진의 참조 마이그레이션 SQL에 CHECK 제약을 추가.

```sql
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT chk_delivery_status
  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED'));
```

이 제약은 엔진이 사용하는 값과 정확히 일치하므로 엔진 코드 변경은 불필요. 다만 엔진의 공식 스키마 (`src/sql/create-webhook-tables.sql`)에 포함시켜 신규 사용자도 적용받게 해야 한다.

**대안 (플랫폼에서 적용)**: 플랫폼의 Prisma 마이그레이션에서 CHECK 제약을 직접 추가. 엔진 수정 없이도 가능하나, 엔진의 공식 스키마와 괴리가 생긴다.

**권고**: 플랫폼에서 먼저 CHECK 제약을 마이그레이션으로 추가하고, 엔진 0.4.0에서도 공식 스키마에 반영.

### E3. endpoint secret 암호화 (장기)

**문제**: `webhook_endpoints.secret`이 평문으로 저장된다.

**현재 한계**: 엔진의 `enrichDeliveries()`가 secret을 DB에서 평문으로 읽어 HMAC 서명에 직접 사용한다. 암호화하려면 엔진이 복호화 로직을 내장하거나, secret 해석을 외부에 위임하는 포트가 필요하다.

**권고**: 엔진 0.4.0 이후 로드맵으로 남김. MVP에서는 DB 접근 통제(네트워크/인증)로 대응.

---

## 플랫폼에서 해결 가능한 항목

### P1. payload/responseBody 노출 제한 (P0-2)

API 응답에서 민감 필드를 truncate/제거.

파일: `apps/api/src/deliveries/deliveries.service.ts`

변경:
- `findAll()`, `findByEndpoint()` 결과에서 `responseBody`를 최대 256자로 truncate
- `lastError`는 유지 (디버깅용)
- `payload`는 의도된 데이터이므로 제한 불필요

### P2. UUID path param 검증 + 전역 예외 필터 (P0-3)

파일:
- `apps/api/src/endpoints/endpoints.controller.ts` — `@Param('id', ParseUUIDPipe)` 추가
- `apps/api/src/messages/messages.controller.ts` — 동일
- `apps/api/src/deliveries/deliveries.controller.ts` — 동일
- `apps/api/src/common/filters/http-exception.filter.ts` — `@Catch()` (인자 없음)로 변경하여 모든 예외 처리

### P3. 복합 인덱스 (P1-2)

파일: `prisma/schema.prisma` + 신규 마이그레이션

추가할 인덱스:
```prisma
// WebhookEndpoint
@@index([tenantId, active])

// WebhookEvent
@@index([tenantId, createdAt])

// WebhookDelivery
@@index([endpointId, status])
```

### P4. health/readiness 엔드포인트 (P2-1)

파일: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`

NestJS `@nestjs/terminus` 모듈 사용. `/health` 엔드포인트에 DB 연결 확인.

### P5. Dockerfile (P2-2)

파일: `Dockerfile`

Multi-stage 빌드: 의존성 설치 → 빌드 → 런타임 이미지.

### P6. seed idempotent (P2-3)

파일: `prisma/seed.ts`

이미 해결됨 (upsert + count 체크 패턴 적용 완료).

---

## 실행 순서 권고

### 즉시 (플랫폼만으로 해결)

1. P2 — UUID 검증 + 전역 예외 필터
2. P1 — responseBody truncate
3. P3 — 복합 인덱스
4. P4 — health endpoint
5. P5 — Dockerfile

### 엔진 0.4.0과 함께

6. E1 — tenant_id `::text` 캐스트 → FK 마이그레이션
7. E2 — status CHECK 제약을 공식 스키마에 반영

### 장기 로드맵

8. E3 — endpoint secret 암호화

---

## 현재 상태 참고

- `apiKey` → `apiKeyHash` 변환 완료 (SHA-256 해싱)
- `tenantId` NOT NULL 적용 완료 (text 타입, FK 없음)
- 마이그레이션 `20260411110000_p0_tenant_fk_apikey_hash` 생성됨 (미커밋)
- `cursor` pagination 제거 완료
- `maxAttempts` 기본값 불일치는 실질적 영향 없음 (엔진이 항상 명시적 전달)
- seed idempotent 수정 완료
