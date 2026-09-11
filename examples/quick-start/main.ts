import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, IncomingHttpHeaders, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  WebhookDeliveryAdminService,
  WebhookEndpointAdminService,
  WebhookEvent,
  WebhookModule,
  WebhookService,
  WebhookSigner,
} from '@nestarc/webhook';
import { PrismaClient } from './generated/prisma/client';

class OrderCreatedEvent extends WebhookEvent {
  static readonly eventType = 'order.created';

  constructor(public readonly orderId: string) {
    super();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Set DATABASE_URL to a local test PostgreSQL database');

  // Each run owns one temporary schema; no existing webhook tables are changed.
  const schema = `webhook_example_${randomUUID().replaceAll('-', '')}`;
  const scopedUrl = new URL(connectionString);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const database = new PrismaClient({
    adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5000 }),
  });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: scopedUrl.toString(),
      connectionTimeoutMillis: 5000,
    }),
  });
  const signer = new WebhookSigner();
  // This Set demonstrates the check for a single process. Production receivers
  // must persist a unique event ID with their business change in one transaction.
  const processed = new Set<string>();
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  let secret = '';
  let app: INestApplicationContext | undefined;
  let schemaCreated = false;

  function respond(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end(body);
  }

  const receiver = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/webhooks') {
      respond(response, 404, 'Not found');
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) chunks.push(chunk);
    });
    request.on('error', () => {
      if (!response.headersSent) respond(response, 400, 'Invalid request');
    });
    request.on('end', () => {
      if (bytes > 1024 * 1024) return respond(response, 413, 'Body too large');
      // Verify the exact request body before JSON parsing or any business changes.
      const body = Buffer.concat(chunks).toString('utf8');
      const eventId = request.headers['webhook-id'];
      const timestamp = request.headers['webhook-timestamp'];
      const signature = request.headers['webhook-signature'];
      if (
        !secret ||
        typeof eventId !== 'string' ||
        !eventId ||
        typeof timestamp !== 'string' ||
        !/^\d+$/.test(timestamp) ||
        typeof signature !== 'string' ||
        !signer.verifyWithTolerance(eventId, Number(timestamp), body, secret, signature, {
          toleranceSeconds: 300,
        })
      ) {
        return respond(response, 401, 'Invalid or expired signature');
      }
      if (processed.has(eventId)) return respond(response, 200, 'Already processed');

      let event: { type?: string; data?: { orderId?: string } };
      try {
        event = JSON.parse(body);
      } catch {
        return respond(response, 400, 'Invalid JSON');
      }
      if (event?.type !== 'order.created' || event.data?.orderId !== 'order_123') {
        return respond(response, 400, 'Unexpected event');
      }
      // The example's business action is recording this verified request.
      received.push({ headers: request.headers, body });
      processed.add(eventId);
      respond(response, 200, 'Processed');
    });
  });

  try {
    await database.$connect();
    // schema is generated locally from UUID characters, never from user input.
    await database.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await prisma.$connect();
    const sql = readFileSync(
      require.resolve('@nestarc/webhook/src/sql/create-webhook-tables.sql'),
      'utf8',
    );
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      // PostgreSQL 14+ supplies gen_random_uuid(); avoid creating a global extension.
      if (/^CREATE EXTENSION\b/i.test(statement)) continue;
      await prisma.$executeRawUnsafe(statement);
    }

    await new Promise<void>((resolve, reject) => {
      receiver.once('error', reject);
      receiver.listen(0, '127.0.0.1', () => {
        receiver.removeListener('error', reject);
        resolve();
      });
    });
    const address = receiver.address();
    assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/webhooks`;

    @Module({
      imports: [
        WebhookModule.forRoot({
          prisma,
          polling: { interval: 100 },
          delivery: { timeout: 5000, maxRetries: 1 },
          allowPrivateUrls: true, // Only for this loopback example; omit in production.
        }),
      ],
    })
    class AppModule {}

    app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn'],
      abortOnError: false,
    });
    const endpoints = app.get(WebhookEndpointAdminService);
    const deliveries = app.get(WebhookDeliveryAdminService);
    const webhooks = app.get(WebhookService);

    // Register the destination and securely provision its secret before publishing.
    const endpoint = await endpoints.createEndpoint({
      url,
      events: ['order.created'],
      tenantId: 'tenant_example',
    });
    secret = endpoint.secret;
    const eventId = await webhooks.sendToTenant(
      'tenant_example',
      new OrderCreatedEvent('order_123'),
      { idempotencyKey: 'order_123:created', correlationId: 'example_request' },
    );

    let logs = await deliveries.getDeliveryLogs(endpoint.id);
    const deadline = Date.now() + 15_000;
    while (logs[0]?.status !== 'SENT') {
      assert.notEqual(logs[0]?.status, 'FAILED', 'Delivery failed');
      assert(Date.now() < deadline, 'Timed out waiting for scheduled delivery');
      await delay(50);
      logs = await deliveries.getDeliveryLogs(endpoint.id);
    }
    assert.equal(logs.length, 1);
    assert.equal(logs[0].eventId, eventId);
    assert.equal(logs[0].tenantId, 'tenant_example');
    assert.equal(logs[0].attempts, 1);
    const attempts = await deliveries.getDeliveryAttempts(logs[0].id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'SENT');
    assert.equal(attempts[0].responseStatus, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['webhook-id'], eventId);

    // A timestamp check alone permits a duplicate within its tolerance window.
    const original = received[0];
    const headers = {
      'content-type': 'application/json',
      'webhook-id': eventId,
      'webhook-timestamp': String(original.headers['webhook-timestamp']),
      'webhook-signature': String(original.headers['webhook-signature']),
    };
    const tampered = await fetch(url, {
      method: 'POST', headers, body: `${original.body} `, signal: AbortSignal.timeout(5000),
    });
    assert.equal(tampered.status, 401);
    await tampered.text();
    const duplicate = await fetch(url, {
      method: 'POST', headers, body: original.body, signal: AbortSignal.timeout(5000),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(await duplicate.text(), 'Already processed');
    assert.equal(received.length, 1);
    assert.equal(processed.size, 1);

    console.log('Verified webhook: type=order.created tenant=tenant_example delivery=SENT attempts=1');
    console.log('Verified receiver: tampered=401 duplicate=200 processed=1');
  } finally {
    // Stop polling and await in-flight work before closing its resources.
    try {
      await app?.close();
    } finally {
      try {
        if (receiver.listening) {
          await new Promise<void>((resolve, reject) =>
            receiver.close((error) => error ? reject(error) : resolve()),
          );
        }
      } finally {
        try {
          await prisma.$disconnect();
          if (schemaCreated) await database.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await database.$disconnect();
        }
      }
    }
  }
  console.log('Quick start passed; temporary schema removed and connections closed.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
