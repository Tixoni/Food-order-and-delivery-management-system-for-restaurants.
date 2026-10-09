import { DomainRuleError, ExternalServiceError } from "@food-delivery/shared";
import { DeliveryStub, PaymentStub } from "./participant.stubs";

const stub = (options: Partial<ConstructorParameters<typeof PaymentStub>[0]> = {}) =>
  new PaymentStub({ failOperation: null, declineAbove: null, delayMs: 0, ...options });

const authorize = (payment: PaymentStub, key = "o-1:authorize", amount = 100000) =>
  payment.authorize({
    orderId: "o-1",
    customerId: "c-1",
    amount,
    currency: "RUB",
    idempotencyKey: key,
  });

describe("заглушка платежей ведёт себя по контракту платёжного сервиса", () => {
  it("холд → списание → частичный и полный возврат", async () => {
    const payment = stub();
    await expect(authorize(payment)).resolves.toMatchObject({ status: "AUTHORIZED" });
    await expect(
      payment.capture({ orderId: "o-1", idempotencyKey: "o-1:capture" }),
    ).resolves.toMatchObject({ status: "CAPTURED", amount: 100000 });
    await expect(
      payment.refund({ orderId: "o-1", idempotencyKey: "r1", amount: 30000 }),
    ).resolves.toMatchObject({ status: "PARTIALLY_REFUNDED", refundedTotal: 30000 });
    await expect(
      payment.refund({ orderId: "o-1", idempotencyKey: "r2", amount: 70000 }),
    ).resolves.toMatchObject({ status: "REFUNDED", refundedTotal: 100000 });
  });

  it("повтор операции с тем же ключом возвращает прежний ответ, а не выполняет её снова (PAY-4)", async () => {
    const payment = stub();
    const first = await authorize(payment);
    const second = await authorize(payment);
    expect(second).toEqual(first);
    await payment.capture({ orderId: "o-1", idempotencyKey: "k" });
    await expect(payment.capture({ orderId: "o-1", idempotencyKey: "k" })).resolves.toMatchObject({
      status: "CAPTURED",
    });
  });

  it("снять холд без холда безопасно; снять со списанного нельзя", async () => {
    const payment = stub();
    await expect(payment.void({ orderId: "o-1", idempotencyKey: "v1" })).resolves.toEqual({
      paymentId: null,
      voided: false,
    });
    await authorize(payment);
    await expect(payment.void({ orderId: "o-1", idempotencyKey: "v2" })).resolves.toMatchObject({
      voided: true,
    });
    const other = stub();
    await authorize(other);
    await other.capture({ orderId: "o-1", idempotencyKey: "c" });
    await expect(other.void({ orderId: "o-1", idempotencyKey: "v" })).rejects.toBeInstanceOf(
      DomainRuleError,
    );
  });

  it("списать без холда и вернуть несписанное нельзя", async () => {
    const payment = stub();
    await expect(payment.capture({ orderId: "o-1", idempotencyKey: "c" })).rejects.toBeInstanceOf(
      DomainRuleError,
    );
    await expect(
      payment.refund({ orderId: "o-1", idempotencyKey: "r", amount: 1 }),
    ).rejects.toBeInstanceOf(DomainRuleError);
  });

  it("управляемые отказы для проверки компенсаций (REL-5)", async () => {
    await expect(authorize(stub({ declineAbove: 50000 }))).resolves.toMatchObject({
      status: "DECLINED",
    });
    const failing = stub({ failOperation: "capture" });
    await authorize(failing);
    await expect(failing.capture({ orderId: "o-1", idempotencyKey: "c" })).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });
});

describe("заглушка доставки", () => {
  it("один заказ — одна доставка; освобождение безопасно и без доставки", async () => {
    const delivery = new DeliveryStub();
    const request = {
      orderId: "o-1",
      restaurantId: "r-1",
      idempotencyKey: "k",
      pickup: { latitude: 55.7, longitude: 37.6 },
      dropoff: { latitude: 55.8, longitude: 37.6 },
      readyAt: new Date().toISOString(),
    };
    const first = await delivery.requestCourier(request);
    expect((await delivery.requestCourier(request)).deliveryId).toBe(first.deliveryId);
    await expect(delivery.releaseCourier({ orderId: "o-1", idempotencyKey: "r" })).resolves.toEqual(
      {
        released: true,
      },
    );
    await expect(delivery.releaseCourier({ orderId: "o-1", idempotencyKey: "r" })).resolves.toEqual(
      {
        released: false,
      },
    );
  });
});
