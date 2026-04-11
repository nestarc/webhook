# INSERT tenant_id UUID 캐스트 누락

## 문제

`tenant_id` 컬럼이 UUID 타입인 DB에서 INSERT 시 타입 불일치 에러가 발생한다.

```
ERROR: column "tenant_id" is of type uuid but expression is of type text
HINT: You will need to rewrite or cast the expression.
```

0.4.0에서 SELECT의 `WHERE tenant_id::text = $1` 캐스트는 추가했으나, INSERT에서 text → uuid 캐스트가 빠져 있다.

## 수정 대상

### 1. `src/adapters/prisma-endpoint.repository.ts` L95

```sql
-- 현재
VALUES ($1, $2, $3::varchar[], $4, $5::jsonb, $6)

-- 수정
VALUES ($1, $2, $3::varchar[], $4, $5::jsonb, $6::uuid)
```

### 2. `src/adapters/prisma-event.repository.ts` L14, L27

tagged template literal(`$queryRaw`)을 사용하므로 SQL 문자열 수정이 아니라 캐스트를 추가해야 한다.

```sql
-- 현재
VALUES (${eventType}, ${JSON.stringify(payload)}::jsonb, ${tenantId})

-- 수정
VALUES (${eventType}, ${JSON.stringify(payload)}::jsonb, ${tenantId}::uuid)
```

L14 (`saveEvent`)와 L27 (`saveEventInTransaction`) 두 곳 모두 동일하게 적용.

## 검증

수정 후 아래 테스트가 통과해야 한다:

```bash
npm test
```

추가로, webhook-platform에서 `tenant_id`를 UUID 타입 + FK(`applications.id` 참조)로 변경한 뒤 E2E 테스트가 통과하는지 확인한다.

## 비고

- `tenant_id`가 text인 DB에서는 `::uuid` 캐스트가 무시되므로 하위 호환성 문제 없음
- 이 수정이 반영되면 SaaS 플랫폼에서 `tenant_id UUID NOT NULL REFERENCES applications(id)` FK를 적용할 수 있음
