export abstract class WebhookEvent {
  static readonly eventType: string;

  get eventType(): string {
    return (this.constructor as typeof WebhookEvent).eventType;
  }

  toPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const key of Object.keys(this)) {
      payload[key] = (this as Record<string, unknown>)[key];
    }
    return payload;
  }
}
