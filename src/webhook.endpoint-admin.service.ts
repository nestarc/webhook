import { Inject, Injectable, Logger } from '@nestjs/common';
import { WebhookSigner } from './webhook.signer';
import {
  WEBHOOK_DELIVERY_REPOSITORY,
  WEBHOOK_ENDPOINT_REPOSITORY,
  WEBHOOK_EVENT_REPOSITORY,
  WEBHOOK_MODULE_OPTIONS,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';
import { WebhookEventRepository } from './ports/webhook-event.repository';
import { WebhookDeliveryRepository } from './ports/webhook-delivery.repository';
import {
  CreateEndpointDto,
  EndpointRecord,
  EndpointRecordWithSecret,
  RotateEndpointSecretDto,
  UpdateEndpointDto,
} from './interfaces/webhook-endpoint.interface';
import { validateWebhookUrl } from './webhook.url-validator';

@Injectable()
export class WebhookEndpointAdminService {
  private readonly logger = new Logger(WebhookEndpointAdminService.name);
  private readonly allowPrivateUrls: boolean;

  constructor(
    @Inject(WEBHOOK_ENDPOINT_REPOSITORY)
    private readonly endpointRepo: WebhookEndpointRepository,
    @Inject(WEBHOOK_EVENT_REPOSITORY)
    private readonly eventRepo: WebhookEventRepository,
    @Inject(WEBHOOK_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: WebhookDeliveryRepository,
    private readonly signer: WebhookSigner,
    @Inject(WEBHOOK_MODULE_OPTIONS)
    options: WebhookModuleOptions,
  ) {
    this.allowPrivateUrls = options.allowPrivateUrls ?? false;
  }

  async createEndpoint(dto: CreateEndpointDto): Promise<EndpointRecordWithSecret> {
    if (!this.allowPrivateUrls) {
      await validateWebhookUrl(dto.url);
    }

    const secret = this.resolveSecret(dto.secret);

    const endpoint = await this.endpointRepo.createEndpoint({
      url: dto.url,
      secret,
      events: dto.events,
      description: dto.description ?? null,
      metadata: dto.metadata ?? null,
      tenantId: dto.tenantId ?? null,
    });

    this.logger.log(`Endpoint created: ${endpoint.id} → ${dto.url}`);
    return endpoint;
  }

  async listEndpoints(tenantId?: string): Promise<EndpointRecord[]> {
    return this.endpointRepo.listEndpoints(tenantId);
  }

  async getEndpoint(endpointId: string): Promise<EndpointRecord | null> {
    return this.endpointRepo.getEndpoint(endpointId);
  }

  async updateEndpoint(
    endpointId: string,
    dto: UpdateEndpointDto,
  ): Promise<EndpointRecord | null> {
    if (dto.url && !this.allowPrivateUrls) {
      await validateWebhookUrl(dto.url);
    }
    return this.endpointRepo.updateEndpoint(endpointId, dto);
  }

  async rotateSecret(
    endpointId: string,
    dto: RotateEndpointSecretDto,
  ): Promise<EndpointRecordWithSecret | null> {
    this.validateRotationExpiry(dto.previousSecretExpiresAt);
    const secret = this.resolveSecret(dto.secret);

    const endpoint = await this.endpointRepo.rotateSecret(endpointId, {
      secret,
      previousSecretExpiresAt: dto.previousSecretExpiresAt,
    });
    if (!endpoint) return null;

    this.logger.log(`Endpoint secret rotated: ${endpointId}`);
    return { ...endpoint, secret };
  }

  async deleteEndpoint(endpointId: string): Promise<boolean> {
    return this.endpointRepo.deleteEndpoint(endpointId);
  }

  async sendTestEvent(endpointId: string): Promise<string | null> {
    const endpoint = await this.endpointRepo.getEndpoint(endpointId);
    if (!endpoint) return null;

    const eventId = await this.eventRepo.saveEvent(
      'webhook.test',
      { test: true },
      endpoint.tenantId ?? null,
    );
    await this.deliveryRepo.createTestDelivery(eventId, endpointId);

    this.logger.log(`Test event sent to endpoint ${endpointId}`);
    return eventId;
  }

  private validateBase64Secret(secret: string): void {
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(secret) || secret.length === 0) {
      throw new Error(
        'Invalid secret: must be a valid base64-encoded string. ' +
          'Use "auto" to generate one automatically.',
      );
    }
    const decoded = Buffer.from(secret, 'base64');
    if (decoded.length < 16) {
      throw new Error(
        'Invalid secret: decoded value must be at least 16 bytes. ' +
          'Use "auto" to generate a secure secret.',
      );
    }
  }

  private resolveSecret(secret: string | undefined): string {
    if (!secret || secret === 'auto') {
      return this.signer.generateSecret();
    }

    this.validateBase64Secret(secret);
    return secret;
  }

  private validateRotationExpiry(expiresAt: Date): void {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new Error('Invalid rotation expiry: previousSecretExpiresAt must be a Date.');
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new Error(
        'Invalid rotation expiry: previousSecretExpiresAt must be in the future.',
      );
    }
  }
}
