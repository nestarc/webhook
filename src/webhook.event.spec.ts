import { WebhookEvent } from './webhook.event';

class OrderCreatedEvent extends WebhookEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}

class OrderPaidEvent extends WebhookEvent {
  static readonly eventType = 'order.paid';

  constructor(
    public readonly orderId: string,
    public readonly paymentId: string,
  ) {
    super();
  }
}

// Subclass that does NOT define static eventType — should fail the LSP guard
class BadEvent extends WebhookEvent {
  constructor(public readonly data: string) {
    super();
  }
}

describe('WebhookEvent', () => {
  it('should expose eventType from static property', () => {
    const event = new OrderCreatedEvent('ord_1', 100);
    expect(event.eventType).toBe('order.created');
  });

  it('should have different eventTypes for different event classes', () => {
    const e1 = new OrderCreatedEvent('ord_1', 100);
    const e2 = new OrderPaidEvent('ord_1', 'pay_1');

    expect(e1.eventType).not.toBe(e2.eventType);
  });

  it('should convert to payload with all properties', () => {
    const event = new OrderCreatedEvent('ord_1', 99.99);
    const payload = event.toPayload();

    expect(payload).toEqual({
      orderId: 'ord_1',
      total: 99.99,
    });
  });

  it('should produce a plain object without prototype methods', () => {
    const event = new OrderPaidEvent('ord_1', 'pay_1');
    const payload = event.toPayload();

    expect(payload).toEqual({
      orderId: 'ord_1',
      paymentId: 'pay_1',
    });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('should throw when a subclass does not define static eventType', () => {
    const event = new BadEvent('test');

    expect(() => event.eventType).toThrow(
      'BadEvent must define static readonly eventType',
    );
  });

  it('should throw with correct class name in the error message', () => {
    class AnotherBadEvent extends WebhookEvent {
      constructor() {
        super();
      }
    }

    const event = new AnotherBadEvent();

    expect(() => event.eventType).toThrow('AnotherBadEvent must define');
  });
});
