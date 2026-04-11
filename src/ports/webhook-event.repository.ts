export interface WebhookEventRepository {
  saveEvent(
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
  ): Promise<string>;

  saveEventInTransaction(
    tx: unknown,
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
  ): Promise<string>;
}
