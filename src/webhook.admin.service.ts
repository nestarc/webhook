import { Inject, Injectable, Logger } from '@nestjs/common';
import { WebhookSigner } from './webhook.signer';
import { WEBHOOK_MODULE_OPTIONS } from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import {
  CreateEndpointDto,
  EndpointRecord,
  UpdateEndpointDto,
} from './interfaces/webhook-endpoint.interface';
import {
  DeliveryLogFilters,
  DeliveryRecord,
} from './interfaces/webhook-delivery.interface';

@Injectable()
export class WebhookAdminService {
  private readonly logger = new Logger(WebhookAdminService.name);
  private readonly prisma: any;

  constructor(
    @Inject(WEBHOOK_MODULE_OPTIONS)
    options: WebhookModuleOptions,
    private readonly signer: WebhookSigner,
  ) {
    this.prisma = options.prisma;
  }

  async createEndpoint(dto: CreateEndpointDto): Promise<EndpointRecord> {
    let secret: string;
    if (!dto.secret || dto.secret === 'auto') {
      secret = this.signer.generateSecret();
    } else {
      this.validateBase64Secret(dto.secret);
      secret = dto.secret;
    }

    const [endpoint] = await this.prisma.$queryRaw<EndpointRecord[]>`
      INSERT INTO webhook_endpoints (url, secret, events, description, metadata, tenant_id)
      VALUES (
        ${dto.url},
        ${secret},
        ${dto.events}::varchar[],
        ${dto.description ?? null},
        ${dto.metadata ? JSON.stringify(dto.metadata) : null}::jsonb,
        ${dto.tenantId ?? null}
      )
      RETURNING *`;

    this.logger.log(`Endpoint created: ${endpoint.id} → ${dto.url}`);
    return endpoint;
  }

  async listEndpoints(tenantId?: string): Promise<EndpointRecord[]> {
    if (tenantId) {
      return this.prisma.$queryRaw<EndpointRecord[]>`
        SELECT * FROM webhook_endpoints
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC`;
    }

    return this.prisma.$queryRaw<EndpointRecord[]>`
      SELECT * FROM webhook_endpoints
      ORDER BY created_at DESC`;
  }

  async getEndpoint(endpointId: string): Promise<EndpointRecord | null> {
    const results = await this.prisma.$queryRaw<EndpointRecord[]>`
      SELECT * FROM webhook_endpoints
      WHERE id = ${endpointId}::uuid`;
    return results[0] ?? null;
  }

  async updateEndpoint(
    endpointId: string,
    dto: UpdateEndpointDto,
  ): Promise<EndpointRecord | null> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (dto.url !== undefined) {
      setClauses.push(`url = $${paramIndex++}`);
      values.push(dto.url);
    }
    if (dto.events !== undefined) {
      setClauses.push(`events = $${paramIndex++}::varchar[]`);
      values.push(dto.events);
    }
    if (dto.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(dto.description);
    }
    if (dto.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(dto.metadata));
    }
    if (dto.active !== undefined) {
      setClauses.push(`active = $${paramIndex++}`);
      values.push(dto.active);
    }

    values.push(endpointId);

    const query = `
      UPDATE webhook_endpoints
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}::uuid
      RETURNING *`;

    const results: EndpointRecord[] = await this.prisma.$queryRawUnsafe(
      query,
      ...values,
    );
    return results[0] ?? null;
  }

  async deleteEndpoint(endpointId: string): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      DELETE FROM webhook_endpoints
      WHERE id = ${endpointId}::uuid`;
    return result > 0;
  }

  async getDeliveryLogs(
    endpointId: string,
    filters?: DeliveryLogFilters,
  ): Promise<DeliveryRecord[]> {
    const conditions = ['d.endpoint_id = $1::uuid'];
    const values: unknown[] = [endpointId];
    let paramIndex = 2;

    if (filters?.status) {
      conditions.push(`d.status = $${paramIndex++}`);
      values.push(filters.status);
    }
    if (filters?.eventType) {
      conditions.push(`ev.event_type = $${paramIndex++}`);
      values.push(filters.eventType);
    }
    if (filters?.since) {
      conditions.push(`d.last_attempt_at >= $${paramIndex++}`);
      values.push(filters.since);
    }
    if (filters?.until) {
      conditions.push(`d.last_attempt_at <= $${paramIndex++}`);
      values.push(filters.until);
    }

    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const query = `
      SELECT d.*
      FROM webhook_deliveries d
      JOIN webhook_events ev ON ev.id = d.event_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.last_attempt_at DESC NULLS LAST
      LIMIT $${paramIndex++}
      OFFSET $${paramIndex}`;

    values.push(limit, offset);

    const results: DeliveryRecord[] = await this.prisma.$queryRawUnsafe(
      query,
      ...values,
    );
    return results;
  }

  async retryDelivery(deliveryId: string): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'PENDING',
          next_attempt_at = NOW()
      WHERE id = ${deliveryId}::uuid
        AND status = 'FAILED'`;
    return result > 0;
  }

  async sendTestEvent(endpointId: string): Promise<string | null> {
    const endpoint = await this.getEndpoint(endpointId);
    if (!endpoint) return null;

    const [event] = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_events (event_type, payload, tenant_id)
      VALUES ('webhook.test', '{"test": true}'::jsonb, ${endpoint.tenantId ?? null})
      RETURNING id`;

    await this.prisma.$executeRaw`
      INSERT INTO webhook_deliveries (event_id, endpoint_id, status, max_attempts, next_attempt_at)
      VALUES (${event.id}::uuid, ${endpointId}::uuid, 'PENDING', 1, NOW())`;

    this.logger.log(`Test event sent to endpoint ${endpointId}`);
    return event.id;
  }

  private validateBase64Secret(secret: string): void {
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(secret) || secret.length === 0) {
      throw new Error(
        'Invalid secret: must be a valid base64-encoded string. ' +
          'Use "auto" to generate one automatically.',
      );
    }
    // Verify it decodes to at least 16 bytes for security
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length < 16) {
      throw new Error(
        'Invalid secret: decoded value must be at least 16 bytes. ' +
          'Use "auto" to generate a secure secret.',
      );
    }
  }
}
