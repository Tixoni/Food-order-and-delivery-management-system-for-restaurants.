import { loadConfig } from "./configuration";

describe("настройки сервиса заказов", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("по умолчанию: заглушки участников и сроки статусов из требований", () => {
    delete process.env.PAYMENT_MODE;
    delete process.env.DELIVERY_MODE;
    const config = loadConfig();
    expect(config.services.payment.mode).toBe("stub");
    expect(config.services.delivery.mode).toBe("stub");
    expect(config.saga.timeouts.awaitingRestaurantMinutes).toBe(3);
    expect(config.saga.serviceFee).toBe(0);
  });

  it("принимает переопределения для демонстрации и проверки отказов", () => {
    process.env.ORDER_TIMEOUT_RESTAURANT_MIN = "1";
    process.env.PAYMENT_STUB_FAIL_OPERATION = "capture";
    process.env.PAYMENT_STUB_DECLINE_ABOVE = "500000";
    process.env.PAYMENT_MODE = "http";
    process.env.KAFKA_BROKERS = "a:1, b:2";
    const config = loadConfig();
    expect(config.saga.timeouts.awaitingRestaurantMinutes).toBe(1);
    expect(config.paymentStub).toMatchObject({ failOperation: "capture", declineAbove: 500000 });
    expect(config.services.payment.mode).toBe("http");
    expect(config.kafka.brokers).toEqual(["a:1", "b:2"]);
  });

  it("не запускается с неверными настройками", () => {
    process.env.PAYMENT_MODE = "maybe";
    expect(() => loadConfig()).toThrow(/PAYMENT_MODE/);
    process.env = { ...saved, PAYMENT_STUB_FAIL_OPERATION: "steal" };
    expect(() => loadConfig()).toThrow(/неизвестная операция/);
    process.env = { ...saved, SAGA_RETRY_BASE_MS: "-5" };
    expect(() => loadConfig()).toThrow(/SAGA_RETRY_BASE_MS/);
    process.env = { ...saved, NODE_ENV: "production", AUTH_DISABLED: "true" };
    expect(() => loadConfig()).toThrow(/AUTH_DISABLED/);
    process.env = { ...saved, LOG_LEVEL: "loud" };
    expect(() => loadConfig()).toThrow(/LOG_LEVEL/);
  });
});
