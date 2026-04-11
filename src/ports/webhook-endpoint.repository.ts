import {
  EndpointRecord,
  UpdateEndpointDto,
} from '../interfaces/webhook-endpoint.interface';

export interface WebhookEndpointRepository {
  findMatchingEndpoints(
    eventType: string,
    tenantId: string | undefined,
  ): Promise<EndpointRecord[]>;

  findMatchingEndpointsInTransaction(
    tx: unknown,
    eventType: string,
    tenantId: string | undefined,
  ): Promise<EndpointRecord[]>;

  createEndpoint(
    url: string,
    secret: string,
    events: string[],
    description: string | null,
    metadata: Record<string, unknown> | null,
    tenantId: string | null,
  ): Promise<EndpointRecord>;

  getEndpoint(id: string): Promise<EndpointRecord | null>;
  listEndpoints(tenantId?: string): Promise<EndpointRecord[]>;
  updateEndpoint(id: string, dto: UpdateEndpointDto): Promise<EndpointRecord | null>;
  deleteEndpoint(id: string): Promise<boolean>;

  resetFailures(endpointId: string): Promise<void>;
  incrementFailures(endpointId: string): Promise<number>;
  disableEndpoint(endpointId: string, reason: string): Promise<void>;
  recoverEligibleEndpoints(cooldownMinutes: number): Promise<number>;
}
