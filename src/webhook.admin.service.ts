import { Injectable } from '@nestjs/common';
import { WebhookEndpointAdminService } from './webhook.endpoint-admin.service';
import { WebhookDeliveryAdminService } from './webhook.delivery-admin.service';
import {
  CreateEndpointDto,
  EndpointRecord,
  EndpointRecordWithSecret,
  RotateEndpointSecretDto,
  UpdateEndpointDto,
} from './interfaces/webhook-endpoint.interface';
import {
  DeliveryAttemptRecord,
  DeliveryLogFilters,
  DeliveryRecord,
} from './interfaces/webhook-delivery.interface';

/**
 * @deprecated since v0.2.0. Will be removed in v1.0.0.
 * Use WebhookEndpointAdminService and WebhookDeliveryAdminService directly.
 */
@Injectable()
export class WebhookAdminService {
  constructor(
    private readonly endpoints: WebhookEndpointAdminService,
    private readonly deliveries: WebhookDeliveryAdminService,
  ) {}

  async createEndpoint(dto: CreateEndpointDto): Promise<EndpointRecordWithSecret> {
    return this.endpoints.createEndpoint(dto);
  }

  async listEndpoints(tenantId?: string): Promise<EndpointRecord[]> {
    return this.endpoints.listEndpoints(tenantId);
  }

  async getEndpoint(endpointId: string): Promise<EndpointRecord | null> {
    return this.endpoints.getEndpoint(endpointId);
  }

  async updateEndpoint(
    endpointId: string,
    dto: UpdateEndpointDto,
  ): Promise<EndpointRecord | null> {
    return this.endpoints.updateEndpoint(endpointId, dto);
  }

  async rotateSecret(
    endpointId: string,
    dto: RotateEndpointSecretDto,
  ): Promise<EndpointRecordWithSecret | null> {
    return this.endpoints.rotateSecret(endpointId, dto);
  }

  async deleteEndpoint(endpointId: string): Promise<boolean> {
    return this.endpoints.deleteEndpoint(endpointId);
  }

  async getDeliveryLogs(
    endpointId: string,
    filters?: DeliveryLogFilters,
  ): Promise<DeliveryRecord[]> {
    return this.deliveries.getDeliveryLogs(endpointId, filters);
  }

  async getDeliveryAttempts(deliveryId: string): Promise<DeliveryAttemptRecord[]> {
    return this.deliveries.getDeliveryAttempts(deliveryId);
  }

  async retryDelivery(deliveryId: string): Promise<boolean> {
    return this.deliveries.retryDelivery(deliveryId);
  }

  async sendTestEvent(endpointId: string): Promise<string | null> {
    return this.endpoints.sendTestEvent(endpointId);
  }
}
