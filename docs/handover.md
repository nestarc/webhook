# @nestarc/webhook — 핸드오버 문서

> **작성일**: 2026-04-11
> **목적**: 다음 세션(Claude Code 등)에서 바로 구현을 시작할 수 있도록 설계 결정사항과 컨텍스트를 정리
> **선행 패키지**: `@nestarc/tenancy` (published), `@nestarc/idempotency` v0.1.3 (published), `@nestarc/outbox` (설계 완료)
> **GitHub**: `nestarc/webhook` 레포 생성 예정

---

## 1. 해결하는 문제

SaaS를 만들 때, **고객에게 웹훅을 제공**하는 것은 필수 기능이지만 제대로 만들기는 매우 어렵다.

### 1.1 두 가지 방향 — "받기" vs "보내기"

- **웹훅 받기 (Inbound/Consumer)**: Stripe, GitHub 등 외부 서비스의 이벤트를 내 앱이 수신. → 이건 간단함 (POST 엔드포인트 + 서명 검증). `@golevelup/nestjs-stripe` 같은 패키지가 이미 존재.
- **웹훅 보내기 (Outbound/Provider)**: 내 SaaS의 이벤트를 고객의 서버에 전달. → **이게 어려운 부분이고, @nestarc/webhook이 해결하는 영역.**

### 1.2 웹훅 보내기가 어려운 이유 — 실제 개발자 페인 포인트

리서치에서 반복적으로 등장하는 문제들:

**"이벤트가 조용히 사라진다"**
고객 서버가 다운됐을 때 이벤트가 유실됨. 에러도, 알림도 없음. 이커머스에서 `order.paid` 웹훅이 드랍되면 주문 이행이 안 되고, SaaS에서 `subscription.cancelled`가 실패하면 해지한 고객에게 계속 과금.

**"재시도 로직을 직접 만들기 힘들다"**
Exponential backoff, jitter, 429 Retry-After 헤더 처리, 최대 재시도 횟수, dead letter queue... 이걸 프로덕션 수준으로 만드는 건 단순 HTTP POST와 차원이 다름.

**"고객 엔드포인트가 생각보다 자주 실패한다"**
Svix 설명에 따르면 "고객 엔드포인트는 생각보다 훨씬 자주 실패하거나 멈춘다." 계속 실패하는 엔드포인트를 자동 비활성화하고 고객에게 알려야 함 (circuit breaker).

**"보안을 제대로 못 한다"**
HMAC 서명 없이 보내는 웹훅은 아무나 위조 가능. SSRF, replay attack 방어 필요. Standard Webhooks (standardwebhooks.com) 표준이 등장했지만 아직 채택이 낮음.

**"배달 로그/감사 추적이 없다"**
고객이 "어제 웹훅 왜 안 왔어?"라고 물으면 답할 수 없음. 언제, 어떤 이벤트가, 어디로, 몇 번 시도됐고, 응답이 뭐였는지 기록 필요.

**"하나의 이벤트를 여러 고객에게 보내는 fan-out 부하"**
이벤트 하나에 100명의 고객 서버에 POST를 보내야 하면, 동기 처리 시 메인 서비스가 죽음. 비동기 큐잉 필수.

---

## 2. 경쟁 분석

### 2.1 외부 서비스/인프라 (경쟁이 아닌 보완 대상)

| 솔루션 | 타입 | 특징 | 한계 |
|--------|------|------|------|
| **Svix** | SaaS + 오픈소스 (Rust) | 시장 리더. 자동 재시도, 서명, 고객 포탈, SOC2. Brex, Drata 등 사용 | Rust 서버 별도 운영 필요. 오픈소스는 기능 제한 (open-core) |
| **Hook0** | 오픈소스 | self-hosted와 cloud 동일 기능. 순수 오픈소스 | 커뮤니티 작음 |
| **Hookdeck Outpost** | 오픈소스 SDK | SQS, Kafka, RabbitMQ 지원. 100B+ 이벤트 경험 | NestJS 래퍼뿐, 별도 Outpost 서버 필요 |
| **Convoy** (Go) | 오픈소스 | inbound + outbound 모두 지원. VC funded | Go 서버. 별도 인프라 |

**공통 한계**: 전부 **별도 서버/인프라**를 운영해야 함. NestJS 앱 안에 내장되는 모듈이 아님.

### 2.2 NestJS 생태계 내

| 솔루션 | 역할 | 한계 |
|--------|------|------|
| `@golevelup/nestjs-webhooks` | 웹훅 **받기** (raw body parsing) | 보내기 기능 없음 |
| `@golevelup/nestjs-stripe` | Stripe 웹훅 **받기** | Stripe 전용 |
| `@nestjs/axios` | HTTP 클라이언트 | 재시도, 서명, 큐잉 등 없음. 직접 구현 필요 |
| DEV.to 블로그 패턴들 | 튜토리얼 수준 | 프로덕션 레디 아님. 트랜잭션 보장, circuit breaker 등 누락 |

### 2.3 차별화 포인트

**"Svix를 NestJS 앱 안에 내장한 것"** — 이 한 문장이 포지셔닝.

| 기능 | Svix | Hookdeck Outpost | 직접 구현 | **@nestarc/webhook** |
|------|:---:|:---:|:---:|:---:|
| NestJS 네이티브 모듈 | ❌ | ❌ | - | **✅** |
| 별도 서버/인프라 불필요 | ❌ | ❌ | ✅ | **✅** |
| 자동 재시도 + backoff | ✅ | ✅ | 직접 구현 | **✅** |
| HMAC 서명 | ✅ | ✅ | 직접 구현 | **✅** |
| 배달 로그 (PostgreSQL) | 외부 DB | 외부 DB | 직접 구현 | **✅ (Prisma)** |
| 엔드포인트 헬스 / circuit breaker | ✅ | ✅ | 직접 구현 | **✅** |
| 고객별 이벤트 구독 관리 | ✅ | ✅ | 직접 구현 | **✅** |
| Dead Letter Queue | ✅ | ✅ | 직접 구현 | **✅** |
| 데코레이터 기반 API | ❌ | ❌ | ❌ | **✅** |
| @nestarc/tenancy 연동 | ❌ | ❌ | ❌ | **✅** |
| @nestarc/outbox 연동 | ❌ | ❌ | ❌ | **✅** |
| self-hosted (무료) | 부분 | ✅ | ✅ | **✅** |

핵심 차별화: **별도 인프라 없이, NestJS 앱의 PostgreSQL만으로 프로덕션 수준의 아웃바운드 웹훅 시스템을 데코레이터 한 줄로 구축.**

---

## 3. 설계 — API 인터페이스

### 3.1 모듈 등록

```typescript
import { WebhookModule } from '@nestarc/webhook';

@Module({
  imports: [
    WebhookModule.forRoot({
      prisma: PrismaService,
      signing: {
        algorithm: 'sha256',           // HMAC-SHA256 (Standard Webhooks 호환)
        headerName: 'webhook-signature',
      },
      delivery: {
        timeout: 10_000,               // 10초 타임아웃
        maxRetries: 5,
        backoff: 'exponential',        // 30s → 5m → 30m → 2h → 24h
        jitter: true,
      },
      circuitBreaker: {
        failureThreshold: 5,           // 5회 연속 실패 시 비활성화
        cooldownMinutes: 60,           // 1시간 후 재시도
      },
      polling: {
        interval: 5000,                // 5초마다 재시도 큐 폴링
        batchSize: 50,
      },
    }),
  ],
})
export class AppModule {}
```

### 3.2 이벤트 정의

```typescript
import { WebhookEvent } from '@nestarc/webhook';

export class OrderCreatedEvent extends WebhookEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly customerId: string,
    public readonly total: number,
  ) {
    super();
  }
}

export class OrderPaidEvent extends WebhookEvent {
  static readonly eventType = 'order.paid';

  constructor(
    public readonly orderId: string,
    public readonly paymentId: string,
  ) {
    super();
  }
}
```

### 3.3 이벤트 발행

```typescript
import { WebhookService } from '@nestarc/webhook';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookService,
  ) {}

  async createOrder(dto: CreateOrderDto) {
    const order = await this.prisma.order.create({ data: dto });

    // 이 이벤트를 구독한 모든 엔드포인트에 비동기 전달
    await this.webhooks.send(
      new OrderCreatedEvent(order.id, dto.customerId, dto.total),
    );

    return order;
  }
}
```

### 3.4 고객 엔드포인트 관리 (REST API 자동 노출)

```typescript
// 모듈이 자동으로 아래 REST API를 생성 (선택적으로 비활성화 가능)
// 또는 WebhookAdminService를 주입받아 직접 구현

// POST   /webhooks/endpoints          — 엔드포인트 등록
// GET    /webhooks/endpoints          — 목록 조회
// GET    /webhooks/endpoints/:id      — 상세 조회
// PATCH  /webhooks/endpoints/:id      — 수정 (URL, 이벤트 구독 변경)
// DELETE /webhooks/endpoints/:id      — 삭제
// GET    /webhooks/endpoints/:id/logs — 배달 로그 조회
// POST   /webhooks/endpoints/:id/test — 테스트 이벤트 전송

// 엔드포인트 등록 요청 예시
{
  "url": "https://customer.com/webhooks",
  "events": ["order.created", "order.paid"],  // 구독할 이벤트 타입
  "secret": "auto"  // 'auto'면 서버가 생성, 또는 고객이 직접 지정
}
```

### 3.5 전체 플로우

```
[OrderService.createOrder()]
    │
    ├─ DB에 주문 저장
    └─ webhooks.send(OrderCreatedEvent)
          │
          ├─ 1. webhook_events 테이블에 이벤트 저장
          │
          ├─ 2. 구독한 엔드포인트 조회
          │     ├─ Customer A: ["order.created"] → ✅ 매칭
          │     ├─ Customer B: ["order.paid"] → ❌ 스킵
          │     └─ Customer C: ["*"] → ✅ 매칭
          │
          ├─ 3. 각 매칭 엔드포인트에 대해 webhook_deliveries 레코드 생성
          │
          └─ (비동기) WebhookDeliveryWorker
                │
                ├─ HMAC-SHA256 서명 생성
                ├─ POST https://customer-a.com/webhooks
                │     Headers:
                │       webhook-id: evt_abc123
                │       webhook-timestamp: 1712836800
                │       webhook-signature: v1,K5oZfP...
                │     Body: { "type": "order.created", "data": {...} }
                │
                ├─ 응답 기록 (status code, latency, body)
                │
                ├─ 성공 (2xx) → status=SENT
                ├─ 실패 → retry_count++
                │     ├─ retry_count < maxRetries → 다음 재시도 스케줄링
                │     └─ retry_count >= maxRetries → status=FAILED (DLQ)
                │
                └─ Circuit Breaker 체크
                      ├─ 연속 5회 실패 → 엔드포인트 비활성화 + 알림
                      └─ cooldown 후 test delivery로 복구 시도
```

---

## 4. DB 스키마 (Prisma)

```prisma
// 고객이 등록한 웹훅 엔드포인트
model WebhookEndpoint {
  id          String   @id @default(uuid()) @db.Uuid
  url         String   @db.VarChar(2048)
  secret      String   @db.VarChar(255)          // HMAC 서명용 시크릿
  events      String[] @db.VarChar(255)           // 구독 이벤트 타입 배열
  active      Boolean  @default(true)
  description String?  @db.VarChar(500)
  metadata    Json?                               // 고객 정의 메타데이터
  tenantId    String?  @map("tenant_id") @db.VarChar(255)

  // Circuit breaker 상태
  consecutiveFailures Int      @default(0) @map("consecutive_failures")
  disabledAt          DateTime? @map("disabled_at") @db.Timestamptz
  disabledReason      String?  @map("disabled_reason") @db.VarChar(255)

  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz

  deliveries  WebhookDelivery[]

  @@index([tenantId, active])
  @@index([active, events])
  @@map("webhook_endpoints")
}

// 발행된 웹훅 이벤트
model WebhookEvent {
  id        String   @id @default(uuid()) @db.Uuid
  eventType String   @map("event_type") @db.VarChar(255)
  payload   Json
  tenantId  String?  @map("tenant_id") @db.VarChar(255)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  deliveries WebhookDelivery[]

  @@index([eventType, createdAt])
  @@map("webhook_events")
}

// 개별 배달 시도 (이벤트 × 엔드포인트)
model WebhookDelivery {
  id           String   @id @default(uuid()) @db.Uuid
  eventId      String   @map("event_id") @db.Uuid
  endpointId   String   @map("endpoint_id") @db.Uuid
  status       String   @default("PENDING") @db.VarChar(20)  // PENDING | SENDING | SENT | FAILED
  attempts     Int      @default(0)
  maxAttempts  Int      @default(5) @map("max_attempts")
  nextAttemptAt DateTime? @map("next_attempt_at") @db.Timestamptz
  lastAttemptAt DateTime? @map("last_attempt_at") @db.Timestamptz
  completedAt  DateTime? @map("completed_at") @db.Timestamptz

  // 마지막 시도 결과
  responseStatus Int?    @map("response_status")
  responseBody   String? @map("response_body") @db.Text  // 첫 1KB만 저장
  latencyMs      Int?    @map("latency_ms")
  lastError      String? @map("last_error") @db.Text

  event    WebhookEvent    @relation(fields: [eventId], references: [id])
  endpoint WebhookEndpoint @relation(fields: [endpointId], references: [id])

  @@index([status, nextAttemptAt])
  @@index([endpointId, status])
  @@index([eventId])
  @@map("webhook_deliveries")
}
```

---

## 5. 핵심 컴포넌트

### 5.1 WebhookService (이벤트 발행)

```typescript
export interface WebhookService {
  /**
   * 이벤트를 발행하고, 구독한 모든 엔드포인트에 대해 배달 레코드를 생성.
   * 실제 HTTP 전송은 비동기 워커가 처리.
   */
  send(event: WebhookEvent): Promise<string>;  // returns eventId

  /**
   * 특정 테넌트의 엔드포인트에만 전달 (multi-tenant).
   */
  sendToTenant(tenantId: string, event: WebhookEvent): Promise<string>;
}
```

### 5.2 WebhookDeliveryWorker (비동기 전달)

- `@nestjs/schedule`의 `@Interval()`로 폴링
- `FOR UPDATE SKIP LOCKED`로 다중 인스턴스 안전
- 각 배달: HMAC 서명 생성 → HTTP POST → 응답 기록 → 상태 업데이트
- 실패 시 exponential backoff 계산 후 `nextAttemptAt` 업데이트

### 5.3 WebhookSigner (서명)

```typescript
// Standard Webhooks (standardwebhooks.com) 호환 서명
// Headers:
//   webhook-id: evt_abc123
//   webhook-timestamp: 1712836800 (unix seconds)
//   webhook-signature: v1,K5oZfP...

function sign(payload: string, secret: string, timestamp: number): string {
  const toSign = `${msgId}.${timestamp}.${payload}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(toSign)
    .digest('base64');
  return `v1,${signature}`;
}
```

### 5.4 CircuitBreaker (엔드포인트 헬스)

```typescript
interface CircuitBreakerConfig {
  failureThreshold: number;   // 연속 N회 실패 시 open
  cooldownMinutes: number;    // open 후 대기 시간
}

// 상태 전이:
// CLOSED (정상) → 연속 실패 → OPEN (비활성화) → cooldown → HALF_OPEN (테스트) → 성공 → CLOSED
// HALF_OPEN → 실패 → OPEN (cooldown 리셋)
```

### 5.5 WebhookAdminService (엔드포인트 CRUD)

- 엔드포인트 등록/수정/삭제
- 배달 로그 조회 (필터: 상태, 날짜, 이벤트 타입)
- 수동 재시도 (`retryDelivery(deliveryId)`)
- 테스트 이벤트 전송 (`sendTestEvent(endpointId)`)
- 실패한 배달 수동 재시도

---

## 6. MVP 스코프 (v0.1.0)

### 포함
- [x] `WebhookModule.forRoot()` / `forRootAsync()`
- [x] `WebhookEvent` 추상 기반 클래스
- [x] `WebhookService.send()` — 이벤트 발행 + fan-out
- [x] `WebhookDeliveryWorker` — polling 기반 비동기 전달
- [x] HMAC-SHA256 서명 (Standard Webhooks 호환 헤더)
- [x] Exponential backoff 재시도 (jitter 포함)
- [x] Circuit breaker (엔드포인트 자동 비활성화/복구)
- [x] Dead Letter Queue (최대 재시도 초과 시)
- [x] `WebhookAdminService` — 엔드포인트 CRUD + 배달 로그 조회
- [x] Prisma raw query (스키마 독립) + SQL 마이그레이션 제공
- [x] `FOR UPDATE SKIP LOCKED` — 다중 인스턴스 안전
- [x] Graceful shutdown
- [x] README + 예제

### v0.2.0 이후
- [ ] 자동 REST API 컨트롤러 (`WebhookModule.forRoot({ exposeApi: true })`)
- [ ] 고객용 임베더블 포탈 UI (React 컴포넌트)
- [ ] @nestarc/tenancy 연동 (테넌트별 엔드포인트 격리)
- [ ] @nestarc/outbox 연동 (이벤트 저장을 outbox 트랜잭션으로)
- [ ] PostgreSQL LISTEN/NOTIFY (즉시 전달)
- [ ] 이벤트 타입 레지스트리 + JSON Schema 검증
- [ ] Replay API (특정 이벤트를 모든 엔드포인트에 재전달)
- [ ] 배달 메트릭 (성공률, 평균 지연, 엔드포인트별 헬스)
- [ ] Rate limiting per endpoint
- [ ] Payload transformation (엔드포인트별 커스텀 변환)

---

## 7. 프로젝트 구조

```
@nestarc/webhook/
├── src/
│   ├── index.ts                        # public API exports
│   ├── webhook.module.ts               # NestJS DynamicModule
│   ├── webhook.service.ts              # 이벤트 발행 + fan-out
│   ├── webhook.delivery-worker.ts      # 비동기 배달 + 재시도
│   ├── webhook.signer.ts               # HMAC-SHA256 서명
│   ├── webhook.circuit-breaker.ts      # 엔드포인트 헬스 관리
│   ├── webhook.admin.service.ts        # 엔드포인트 CRUD + 로그 조회
│   ├── webhook.event.ts                # WebhookEvent 추상 클래스
│   ├── webhook.constants.ts            # injection tokens, 기본값, backoff 스케줄
│   ├── interfaces/
│   │   ├── webhook-options.interface.ts
│   │   ├── webhook-endpoint.interface.ts
│   │   └── webhook-delivery.interface.ts
│   └── sql/
│       └── create-webhook-tables.sql   # 마이그레이션 SQL (3개 테이블)
├── test/
│   ├── webhook.service.spec.ts
│   ├── webhook.delivery-worker.spec.ts
│   ├── webhook.signer.spec.ts
│   ├── webhook.circuit-breaker.spec.ts
│   ├── webhook.admin.service.spec.ts
│   └── e2e/
│       └── webhook.e2e-spec.ts
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── jest.config.ts
├── LICENSE                             # MIT
└── README.md
```

---

## 8. 기술 스택

`@nestarc` 패키지 공통 규격:

- **런타임**: Node.js 20+
- **NestJS**: 10.x / 11.x
- **TypeScript**: 5.4+
- **DB**: PostgreSQL + Prisma (`$queryRaw`)
- **HTTP 클라이언트**: Node.js 내장 `fetch` (외부 의존성 없음)
- **스케줄러**: `@nestjs/schedule`
- **CI/CD**: GitHub Actions → npm publish
- **라이선스**: MIT

### 의존성
- **필수 peer**: `@nestjs/common`, `@nestjs/core`, `@nestjs/schedule`, `@prisma/client`
- **내장 deps**: 없음 (crypto, fetch는 Node.js 내장)

---

## 9. 핵심 구현 포인트

### 9.1 Exponential Backoff 스케줄

```typescript
// Svix/Stripe 스타일 스케줄
const BACKOFF_SCHEDULE = [
  30,        // 30초 후
  300,       // 5분 후
  1800,      // 30분 후
  7200,      // 2시간 후
  86400,     // 24시간 후
];

function nextAttemptAt(attempt: number): Date {
  const delay = BACKOFF_SCHEDULE[Math.min(attempt, BACKOFF_SCHEDULE.length - 1)];
  const jitter = Math.random() * delay * 0.1; // 10% jitter
  return new Date(Date.now() + (delay + jitter) * 1000);
}
```

### 9.2 Standard Webhooks 호환 서명

```typescript
// standardwebhooks.com 스펙 준수
// 세 개의 헤더:
//   webhook-id: 이벤트 고유 ID
//   webhook-timestamp: Unix timestamp (초)
//   webhook-signature: v1,{base64_hmac}

function signPayload(eventId: string, timestamp: number, body: string, secret: string): {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
} {
  const toSign = `${eventId}.${timestamp}.${body}`;
  const hmac = crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(toSign)
    .digest('base64');

  return {
    'webhook-id': eventId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${hmac}`,
  };
}
```

### 9.3 Polling Worker (FOR UPDATE SKIP LOCKED)

```sql
UPDATE webhook_deliveries
SET status = 'SENDING'
WHERE id IN (
  SELECT id FROM webhook_deliveries
  WHERE status = 'PENDING'
    AND next_attempt_at <= NOW()
  ORDER BY next_attempt_at ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

### 9.4 Circuit Breaker 로직

```typescript
async afterDelivery(endpointId: string, success: boolean) {
  if (success) {
    // 성공 → 연속 실패 카운터 리셋, 비활성화 상태면 복구
    await this.resetFailures(endpointId);
  } else {
    // 실패 → 카운터 증가
    const failures = await this.incrementFailures(endpointId);
    if (failures >= this.config.failureThreshold) {
      // 임계치 초과 → 엔드포인트 비활성화
      await this.disableEndpoint(endpointId, 'consecutive_failures_exceeded');
      // TODO: 고객 알림 (이메일, 슬랙 등) — v0.2
    }
  }
}
```

### 9.5 Fan-out (이벤트 → 여러 엔드포인트)

```typescript
async send(event: WebhookEvent): Promise<string> {
  // 1. 이벤트 저장
  const eventId = await this.saveEvent(event);

  // 2. 매칭 엔드포인트 조회 (active + 이벤트 타입 구독)
  const endpoints = await this.findMatchingEndpoints(event.eventType);

  // 3. 각 엔드포인트에 대해 배달 레코드 생성 (batch insert)
  await this.createDeliveries(eventId, endpoints);

  return eventId;
}
```

---

## 10. @nestarc 에코시스템 시너지

```
@nestarc/tenancy           ← 테넌트별 엔드포인트 격리
     │
@nestarc/outbox            ← 이벤트를 비즈니스 트랜잭션과 원자적 저장
     │
@nestarc/webhook           ← 이벤트를 고객 서버에 안전하게 전달 (NEW)
     │
@nestarc/idempotency       ← 고객 측에서 중복 웹훅 방지 (webhook-id 활용)
```

`@nestarc/outbox`와의 관계: outbox가 "이벤트를 안전하게 저장"하는 레이어라면, webhook은 "저장된 이벤트를 외부에 전달"하는 레이어. v0.2에서 outbox의 `@OnOutboxEvent`가 webhook의 `send()`를 호출하는 통합 구현 가능.

---

## 11. 리스크 & 대응

| 리스크 | 심각도 | 대응 |
|--------|:------:|------|
| Svix가 NestJS SDK를 만들 가능성 | 중 | 차별점은 "내장 모듈 vs 외부 서비스". 별도 서버 불필요가 핵심 가치 |
| 구현 범위가 outbox보다 넓음 | 상 | MVP를 엄격히 제한. REST API 자동 노출은 v0.2로 |
| 고성능 fan-out 부하 | 중 | MVP는 polling 기반. v0.2에서 BullMQ 옵션 추가 |
| Standard Webhooks 스펙 변경 | 하 | 서명 알고리즘을 설정 가능하게 설계 |

---

## 12. 참고 자료

- Standard Webhooks: https://www.standardwebhooks.com/
- Svix 오픈소스: https://github.com/svix/svix-webhooks
- Hook0: https://documentation.hook0.com/comparisons
- Hookdeck Outpost + NestJS: https://hookdeck.com/outpost/guides/send-webhooks-with-nestjs-guide
- Webhook retry best practices (Hookdeck): https://hookdeck.com/outpost/guides/outbound-webhook-retry-best-practices
- Webhook retry best practices (Svix): https://www.svix.com/resources/webhook-best-practices/retries/
- "Webhooks Are Broken by Design" (DEV.to): https://dev.to/roombambar9/webhooks-are-broken-by-design-so-i-built-a-fix-4pk7
- "Webhook Failure Modes Nobody Warns You About" (DEV.to): https://dev.to/jamesbrown/the-webhook-failure-modes-nobody-warns-you-about-346m

---

## 13. 다음 세션에서 할 일

1. GitHub `nestarc/webhook` 레포 생성
2. 프로젝트 스캐폴딩 (package.json, tsconfig, jest, eslint)
3. SQL 마이그레이션 파일 작성 (3개 테이블)
4. 인터페이스 정의 (`WebhookOptions`, `EndpointRecord`, `DeliveryRecord`)
5. `WebhookEvent` 추상 클래스 구현
6. `WebhookSigner` 구현 (Standard Webhooks 호환)
7. `WebhookService.send()` 구현 (이벤트 저장 + fan-out)
8. `WebhookDeliveryWorker` 구현 (polling + 재시도 + backoff)
9. `CircuitBreaker` 구현 (엔드포인트 헬스 관리)
10. `WebhookAdminService` 구현 (CRUD + 로그 조회)
11. `WebhookModule` 모듈 등록 로직
12. 단위 테스트 작성
13. E2E 테스트 (실제 HTTP 서버 mock)
14. README 작성
15. npm publish (`@nestarc/webhook`)

---

*이 문서는 2026-04-11 nestarc.dev 생태계 확장 리서치 세션에서 작성되었으며, Claude Code 또는 다른 세션에서 구현을 이어갈 때 컨텍스트로 활용한다.*