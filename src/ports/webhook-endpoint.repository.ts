import {
  EndpointRecord,
  EndpointRecordWithSecret,
  RotateEndpointSecretDto,
  UpdateEndpointDto,
} from '../interfaces/webhook-endpoint.interface';
import { WebhookTransaction } from './webhook-delivery.repository';

export interface ResolvedCreateEndpointInput {
  url: string;
  secret: string;
  events: string[];
  description: string | null;
  metadata: Record<string, unknown> | null;
  tenantId: string | null;
}

export interface ResolvedRotateEndpointSecretInput
  extends Required<RotateEndpointSecretDto> {}

export interface WebhookEndpointRepository {
  findMatchingEndpoints(
    eventType: string,
    tenantId: string | undefined,
  ): Promise<EndpointRecord[]>;

  /** Use only with a transaction object received from WebhookDeliveryRepository.runInTransaction(). */
  findMatchingEndpointsInTransaction(
    tx: WebhookTransaction,
    eventType: string,
    tenantId: string | undefined,
  ): Promise<EndpointRecord[]>;

  createEndpoint(input: ResolvedCreateEndpointInput): Promise<EndpointRecordWithSecret>;

  getEndpoint(id: string): Promise<EndpointRecord | null>;
  listEndpoints(tenantId?: string): Promise<EndpointRecord[]>;
  updateEndpoint(id: string, dto: UpdateEndpointDto): Promise<EndpointRecord | null>;
  rotateSecret(
    id: string,
    input: ResolvedRotateEndpointSecretInput,
  ): Promise<EndpointRecord | null>;
  /**
   * @returns true if a row was deleted, false if the endpoint did not exist.
   * May reject when existing delivery rows still reference the endpoint.
   */
  deleteEndpoint(id: string): Promise<boolean>;

  resetFailures(endpointId: string): Promise<void>;
  /** Atomically increments consecutive failures and returns the new value. */
  incrementFailures(endpointId: string): Promise<number>;
  /** @returns true when the endpoint transitioned from active to inactive. */
  disableEndpoint(endpointId: string, reason: string): Promise<boolean>;
  /** @returns number of endpoints recovered after cooldown. */
  recoverEligibleEndpoints(cooldownMinutes: number): Promise<number>;
}
