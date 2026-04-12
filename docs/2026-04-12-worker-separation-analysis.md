# Worker Separation Analysis

비동기 배달 워커를 API 프로세스에서 분리하기 위한 분석 및 구현 방안.

---

## 현재 구조: DB 폴링 (in-process)

`@nestarc/webhook` 엔진이 API 프로세스 안에서 워커를 실행한다. 별도 프로세스가 아니다.

```
┌─────────────── API 프로세스 (NestJS) ──────────────┐
│                                                      │
│  [REST 핸들러]  ← HTTP 요청 처리                     │
│       │                                              │
│       ▼                                              │
│  [WebhookService.sendToTenant()]                     │
│       │  INSERT webhook_events + webhook_deliveries  │
│       ▼         (status = PENDING)                   │
│                                                      │
│  [WebhookDeliveryWorker.poll()]  ← setInterval 5초   │
│       │                                              │
│       ├── circuitBreaker.recoverEligibleEndpoints()  │
│       ├── deliveryRepo.recoverStaleSending()         │
│       ├── deliveryRepo.claimPendingDeliveries(50)    │
│       │        ↑ FOR UPDATE SKIP LOCKED              │
│       └── Promise.all(deliveries.map(processDelivery))│
│                  │                                   │
│            ┌─────┴─────┐                             │
│            │Dispatcher  │─→ HTTP POST → 고객 서버     │
│            │  + Signer  │                             │
│            └─────┬─────┘                             │
│                  │                                   │
│            성공 → markSent()                          │
│            실패 → markRetry() 또는 markFailed()       │
│                  + circuitBreaker.afterDelivery()     │
└──────────────────────────────────────────────────────┘
```

### 핵심 메커니즘

**폴링 루프** — `WebhookModule.onModuleInit()`에서 `setInterval`로 자동 시작.

```typescript
onModuleInit() {
  const interval = options.polling?.interval ?? 5000;
  setInterval(() => this.deliveryWorker.poll(), interval);
}
```

**Claim** — `FOR UPDATE SKIP LOCKED`로 멀티 인스턴스 안전.

```sql
UPDATE webhook_deliveries
SET status = 'SENDING', claimed_at = NOW()
WHERE id IN (
  SELECT id FROM webhook_deliveries
  WHERE status = 'PENDING' AND next_attempt_at <= NOW()
  FOR UPDATE SKIP LOCKED
  LIMIT 50
)
```

**재시도 스케줄** — exponential backoff, ±10% jitter.

| 시도 | 대기 |
|------|------|
| 1 | 즉시 |
| 2 | +30초 |
| 3 | +5분 |
| 4 | +30분 |
| 5 | +2시간 |
| 6 | +24시간 |

**Stale Recovery** — `SENDING` 상태에서 5분 이상 경과 시 자동으로 `PENDING` 복구.

**Graceful Shutdown** — 진행 중인 배달 완료까지 최대 30초 대기.

---

## 문제 분석: 왜 분리가 필요한가

API 프로세스와 배달 워커가 **같은 Node.js 이벤트 루프를 공유**한다.

| 시나리오 | 현재 구조로 충분? |
|---------|-----------------|
| 일 5,000건 이하 (free 플랜) | 충분 |
| 일 50,000건 (starter 플랜) | 모니터링 필요 |
| 일 500,000건 (pro 플랜) | 분리 권장 — API 지연 발생 가능 |
| 배달 timeout이 긴 엔드포인트 다수 | 분리 필수 |

대량 배달 시 HTTP dispatch가 이벤트 루프를 점유하면 API 응답 지연이 발생한다.

---

## 분리 방안: 엔진 변경 vs 래퍼 변경

### 엔진에 필요한 변경: `polling.enabled` 옵션 (2줄)

현재 `WebhookModule.onModuleInit()`가 폴링을 **무조건** 시작한다. 끌 수 있는 옵션이 없다.

```typescript
// 현재 PollingOptions — enabled 플래그 없음
interface PollingOptions {
  interval?: number;
  batchSize?: number;
  staleSendingMinutes?: number;
}
```

필요한 변경:

```typescript
// 1. PollingOptions에 enabled 추가
interface PollingOptions {
  enabled?: boolean;          // ← 추가 (default: true)
  interval?: number;
  batchSize?: number;
  staleSendingMinutes?: number;
}

// 2. onModuleInit에서 체크
onModuleInit() {
  if (this.options.polling?.enabled === false) return;  // ← 추가
  const interval = this.options.polling?.interval ?? 5000;
  setInterval(() => this.deliveryWorker.poll(), interval);
}
```

### 엔진 변경 없이 우회하는 방법 (비권장)

API 쪽에서 `SchedulerRegistry`를 주입받아 엔진이 등록한 interval을 강제 삭제:

```typescript
@Injectable()
class DisablePolling implements OnModuleInit {
  constructor(private registry: SchedulerRegistry) {}
  onModuleInit() {
    this.registry.deleteInterval('webhook-delivery-poll');
  }
}
```

엔진 내부의 interval 이름(`'webhook-delivery-poll'`)에 의존하므로 깨지기 쉽다. 비권장.

---

## 엔진 vs 래퍼 역할 분담

| 작업 | 위치 | 설명 |
|------|------|------|
| `polling.enabled` 옵션 추가 | **엔진** | `PollingOptions` 인터페이스 + `onModuleInit` 분기 |
| `apps/worker/` NestJS 프로세스 생성 | 래퍼 | `WebhookModule` import, 폴링 활성화 |
| API에서 `polling: { enabled: false }` 설정 | 래퍼 | `app.module.ts`에서 옵션 변경 |
| docker-compose에 worker 서비스 추가 | 래퍼 | 별도 컨테이너로 분리 |
| 배포 구성 (Railway/Fly 등) | 래퍼 | Worker 프로세스 분리 배포 |

---

## 분리 후 목표 구조

```
┌─── API 프로세스 ───┐    ┌─── Worker 프로세스 ───┐
│                     │    │                        │
│  REST 핸들러        │    │  DeliveryWorker.poll() │
│  WebhookService     │    │  Dispatcher            │
│    .sendToTenant()  │    │  CircuitBreaker        │
│    .sendToEndpoints()    │  RetryPolicy           │
│                     │    │                        │
│  polling: false     │    │  polling: true          │
│                     │    │  interval: 5000         │
└────────┬────────────┘    └────────┬───────────────┘
         │                          │
         └──── PostgreSQL ──────────┘
              (공유 DB)

Worker 수평 확장 가능: FOR UPDATE SKIP LOCKED
```

### 플랫폼 `app.module.ts` 변경 (API)

```typescript
WebhookModule.forRootAsync({
  imports: [PrismaModule],
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => ({
    prisma,
    delivery: { timeout: 30_000, maxRetries: 6 },
    circuitBreaker: { failureThreshold: 5, cooldownMinutes: 60 },
    polling: { enabled: false },  // ← Worker에서만 폴링
  }),
}),
```

### `apps/worker/main.ts` (신규)

```typescript
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  console.log('Webhook delivery worker started (polling)');
}
bootstrap();
```

`NestFactory.createApplicationContext`로 HTTP 서버 없이 NestJS 모듈만 구동한다.

---

## 요약

- 엔진에 `polling.enabled` 옵션 **2줄 추가**가 유일한 엔진 변경사항
- 나머지(Worker 프로세스 생성, Docker 구성, 배포)는 전부 래퍼(webhook-platform)에서 처리
- `FOR UPDATE SKIP LOCKED` 덕분에 Redis/BullMQ 없이도 Worker 수평 확장 가능
- 현재 free 티어 규모에서는 분리 불필요. 유료 고객 유입 시 실행
