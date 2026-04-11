export abstract class WebhookEvent {
  static readonly eventType: string;

  get eventType(): string {
    const type = (this.constructor as typeof WebhookEvent).eventType;
    if (!type) {
      throw new Error(
        `${this.constructor.name} must define static readonly eventType`,
      );
    }
    return type;
  }

  toPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const key of Object.keys(this)) {
      payload[key] = (this as Record<string, unknown>)[key];
    }
    return payload;
  }
}
