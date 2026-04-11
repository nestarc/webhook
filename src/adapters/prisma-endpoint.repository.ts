import { Injectable } from '@nestjs/common';
import { WebhookEndpointRepository } from '../ports/webhook-endpoint.repository';
import {
  EndpointRecord,
  UpdateEndpointDto,
} from '../interfaces/webhook-endpoint.interface';

@Injectable()
export class PrismaEndpointRepository implements WebhookEndpointRepository {
  constructor(private readonly prisma: any) {}

  async findMatchingEndpoints(
    eventType: string,
    tenantId: string | undefined,
  ): Promise<EndpointRecord[]> {
    if (tenantId !== undefined) {
      return this.prisma.$queryRaw<EndpointRecord[]>`
        SELECT * FROM webhook_endpoints
        WHERE active = true
          AND tenant_id = ${tenantId}
          AND (${eventType} = ANY(events) OR '*' = ANY(events))`;
    }
    return this.prisma.$queryRaw<EndpointRecord[]>`
      SELECT * FROM webhook_endpoints
      WHERE active = true
        AND (${eventType} = ANY(events) OR '*' = ANY(events))`;
  }

  async findMatchingEndpointsInTransaction(
    tx: any,
    eventType: string,
    tenantId: string | undefined,
  ): Promise<EndpointRecord[]> {
    if (tenantId !== undefined) {
      return tx.$queryRaw<EndpointRecord[]>`
        SELECT * FROM webhook_endpoints
        WHERE active = true
          AND tenant_id = ${tenantId}
          AND (${eventType} = ANY(events) OR '*' = ANY(events))`;
    }
    return tx.$queryRaw<EndpointRecord[]>`
      SELECT * FROM webhook_endpoints
      WHERE active = true
        AND (${eventType} = ANY(events) OR '*' = ANY(events))`;
  }

  async createEndpoint(
    url: string,
    secret: string,
    events: string[],
    description: string | null,
    metadata: Record<string, unknown> | null,
    tenantId: string | null,
  ): Promise<EndpointRecord> {
    const [endpoint] = await this.prisma.$queryRaw<EndpointRecord[]>`
      INSERT INTO webhook_endpoints (url, secret, events, description, metadata, tenant_id)
      VALUES (
        ${url},
        ${secret},
        ${events}::varchar[],
        ${description},
        ${metadata ? JSON.stringify(metadata) : null}::jsonb,
        ${tenantId}
      )
      RETURNING *`;
    return endpoint;
  }

  async getEndpoint(id: string): Promise<EndpointRecord | null> {
    const results = await this.prisma.$queryRaw<EndpointRecord[]>`
      SELECT * FROM webhook_endpoints WHERE id = ${id}::uuid`;
    return results[0] ?? null;
  }

  async listEndpoints(tenantId?: string): Promise<EndpointRecord[]> {
    if (tenantId) {
      return this.prisma.$queryRaw<EndpointRecord[]>`
        SELECT * FROM webhook_endpoints
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC`;
    }
    return this.prisma.$queryRaw<EndpointRecord[]>`
      SELECT * FROM webhook_endpoints ORDER BY created_at DESC`;
  }

  async updateEndpoint(
    id: string,
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

    values.push(id);
    const query = `
      UPDATE webhook_endpoints
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}::uuid
      RETURNING *`;

    const results: EndpointRecord[] = await this.prisma.$queryRawUnsafe(query, ...values);
    return results[0] ?? null;
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      DELETE FROM webhook_endpoints WHERE id = ${id}::uuid`;
    return result > 0;
  }

  async resetFailures(endpointId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_endpoints
      SET consecutive_failures = 0, active = true,
          disabled_at = NULL, disabled_reason = NULL, updated_at = NOW()
      WHERE id = ${endpointId}::uuid`;
  }

  async incrementFailures(endpointId: string): Promise<number> {
    const [updated] = await this.prisma.$queryRaw<{ consecutive_failures: number }[]>`
      UPDATE webhook_endpoints
      SET consecutive_failures = consecutive_failures + 1, updated_at = NOW()
      WHERE id = ${endpointId}::uuid
      RETURNING consecutive_failures`;
    return updated.consecutive_failures;
  }

  async disableEndpoint(endpointId: string, reason: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_endpoints
      SET active = false, disabled_at = NOW(), disabled_reason = ${reason}, updated_at = NOW()
      WHERE id = ${endpointId}::uuid AND active = true`;
  }

  async recoverEligibleEndpoints(cooldownMinutes: number): Promise<number> {
    const cooldownInterval = `${cooldownMinutes} minutes`;
    const recovered = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE webhook_endpoints
      SET active = true, consecutive_failures = 0,
          disabled_at = NULL, disabled_reason = NULL, updated_at = NOW()
      WHERE active = false
        AND disabled_at IS NOT NULL
        AND disabled_at + ${cooldownInterval}::interval <= NOW()
      RETURNING id`;
    return recovered.length;
  }
}
