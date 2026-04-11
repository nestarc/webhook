# Engine Improvements Design — v0.4.0

작성일: 2026-04-11
목적: 핸드오버 문서의 엔진 수정 필요 항목 E1, E2, E3을 설계한다.

---

## E1. tenant_id `::text` 캐스트

### 문제

`webhook_endpoints.tenant_id`를 UUID FK로 변경하면 엔진의 raw SQL에서 `WHERE tenant_id = $1` 비교가 실패한다. PostgreSQL은 `uuid = text` 자동 캐스팅을 하지 않는다.

### 변경 대상

| 파일 | 라인 | 패턴 | 변경 |
|------|------|------|------|
| `src/adapters/prisma-endpoint.repository.ts` | L40 | `WHERE active = true AND tenant_id = $1` | `tenant_id::text = $1` |
| `src/adapters/prisma-endpoint.repository.ts` | L64 | `WHERE active = true AND tenant_id = $1` | `tenant_id::text = $1` |
| `src/adapters/prisma-endpoint.repository.ts` | L114 | `WHERE tenant_id = $1` | `tenant_id::text = $1` |
| `src/adapters/prisma-event.repository.ts` | L14 | INSERT (tenant_id) | 변경 불필요 (text→uuid 암시적 캐스팅) |
| `src/adapters/prisma-event.repository.ts` | L27 | INSERT (tenant_id) | 변경 불필요 |

### 테스트 검증

기존 tenant_id 관련 테스트가 text 타입 기준으로 통과하는지 확인. `::text` 캐스트는 text 컬럼에도 무해하므로 하위 호환성 유지.

---

## E2. delivery status CHECK 제약

### 문제

`webhook_deliveries.status`가 `VARCHAR(20)`으로 자유 문자열이라 잘못된 값이 들어갈 수 있다.

### 변경 대상

**파일:** `src/sql/create-webhook-tables.sql`

테이블 정의에 인라인 CHECK 제약 추가:

```sql
status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
```

기존 DB 사용자를 위한 ALTER TABLE 마이그레이션 SQL을 주석으로 포함:

```sql
-- 기존 DB 마이그레이션:
-- ALTER TABLE webhook_deliveries
--   ADD CONSTRAINT chk_delivery_status
--   CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED'));
```

### 테스트 검증

엔진이 사용하는 4가지 상태값(`PENDING`, `SENDING`, `SENT`, `FAILED`)만 허용되므로 기존 코드와 정확히 일치. 엔진 코드 변경 불필요.

---

## E3. WebhookSecretVault 포트

### 문제

`webhook_endpoints.secret`이 평문으로 저장된다. `enrichDeliveries()`가 DB에서 평문 secret을 읽어 HMAC 서명에 직접 사용한다.

### 설계

#### 포트 인터페이스

```typescript
// src/ports/webhook-secret-vault.ts
export interface WebhookSecretVault {
  encrypt(plainSecret: string): Promise<string>;
  decrypt(encryptedSecret: string): Promise<string>;
}
```

#### 기본 어댑터 (noop)

```typescript
// src/adapters/plaintext-secret-vault.ts
export class PlaintextSecretVault implements WebhookSecretVault {
  async encrypt(secret: string): Promise<string> { return secret; }
  async decrypt(secret: string): Promise<string> { return secret; }
}
```

기존 사용자는 아무 설정 없이 기존 동작 유지. 하위 호환성 보장.

#### 흐름 변경

1. **`createEndpoint()`** (`prisma-endpoint.repository.ts`)
   - secret 저장 전 `vault.encrypt(secret)` 호출
   - 암호화된 값을 DB에 저장

2. **`enrichDeliveries()`** (`prisma-delivery.repository.ts`)
   - DB에서 조회한 secret에 대해 `vault.decrypt(secret)` 호출
   - 복호화된 평문 secret을 `PendingDelivery.secret`에 전달

3. **`WebhookDispatcher` / `WebhookSigner`**
   - 변경 없음. 이미 평문 secret을 받아 HMAC 서명에 사용.

#### 주입 경로

`WebhookModuleOptions`에 `secretVault?: WebhookSecretVault` 추가:

```typescript
export interface WebhookModuleOptions {
  // ... 기존 옵션
  secretVault?: WebhookSecretVault;
}
```

미제공 시 `PlaintextSecretVault`를 기본값으로 사용.

#### 의존성 주입

`WebhookModule.forRoot()`에서 vault 인스턴스를 resolve하여 endpoint repository와 delivery repository에 주입.

### 테스트 검증

- `PlaintextSecretVault`: encrypt/decrypt가 값을 그대로 반환하는지 단위 테스트
- endpoint repository: `createEndpoint()` 시 `vault.encrypt()` 호출 검증
- delivery repository: `enrichDeliveries()` 시 `vault.decrypt()` 호출 검증
- 통합: 기존 테스트가 vault 미제공 상태에서 동일하게 통과하는지 확인

---

## 버전 및 하위 호환성

- **버전**: 이 변경은 v0.4.0으로 릴리즈
- **E1**: 하위 호환. `::text` 캐스트는 text 컬럼에서도 동작
- **E2**: 하위 호환. CHECK 제약은 엔진이 사용하는 값만 허용
- **E3**: 하위 호환. `secretVault` 옵션 미제공 시 `PlaintextSecretVault` 기본값 사용

BREAKING CHANGE 없음.
