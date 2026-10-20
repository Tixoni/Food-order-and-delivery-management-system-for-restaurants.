import { loadConfig } from "./configuration";

describe("настройки сервиса заказов", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("по умолчанию: сроки статусов из требований, без сервисного сбора", () => {
    const config = loadConfig();
    expect(config.saga.timeouts.awaitingRestaurantMinutes).toBe(3);
    expect(config.saga.serviceFee).toBe(0);
  });

  it("принимает переопределения для демонстрации", () => {
    process.env.ORDER_TIMEOUT_RESTAURANT_MIN = "1";
    process.env.KAFKA_BROKERS = "a:1, b:2";
    const config = loadConfig();
    expect(config.saga.timeouts.awaitingRestaurantMinutes).toBe(1);
    expect(config.kafka.brokers).toEqual(["a:1", "b:2"]);
  });

  it("не запускается с неверными настройками", () => {
    process.env.SAGA_RETRY_BASE_MS = "-5";
    expect(() => loadConfig()).toThrow(/SAGA_RETRY_BASE_MS/);
    process.env = { ...saved, NODE_ENV: "production", AUTH_DISABLED: "true" };
    expect(() => loadConfig()).toThrow(/AUTH_DISABLED/);
    process.env = { ...saved, LOG_LEVEL: "loud" };
    expect(() => loadConfig()).toThrow(/LOG_LEVEL/);
  });
});
