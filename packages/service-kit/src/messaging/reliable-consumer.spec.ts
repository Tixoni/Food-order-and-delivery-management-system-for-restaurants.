import {
  ConflictError,
  DomainRuleError,
  ExternalServiceError,
  createEvent,
  createLogger,
  getContext,
} from "@food-delivery/shared";
import { ReliableConsumer } from "./reliable-consumer";

const send = jest.fn();
jest.mock("kafkajs", () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: () => ({ connect: jest.fn(), disconnect: jest.fn(), send }),
  })),
}));

describe("ReliableConsumer", () => {
  const meta = { topic: "payment.events", partition: 1, offset: "42" };
  const event = createEvent({
    eventType: "PaymentAuthorized",
    aggregateType: "payment",
    aggregateId: "8b0b2c1e-0000-4000-8000-000000000001",
    payload: { orderId: "o-1" },
    correlationId: "corr-7",
  });
  const raw = JSON.stringify(event);

  const consumer = (handle: jest.Mock) =>
    new ReliableConsumer({
      kafka: { brokers: ["localhost:1"], clientId: "test" },
      groupId: "order",
      topics: ["payment.events"],
      deadLetterTopic: (topic) => `${topic}.dlq`,
      handle,
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      logger: createLogger({ service: "test", level: "error", sink: () => undefined }),
      sleep: () => Promise.resolve(),
    });

  beforeEach(() => send.mockReset().mockResolvedValue(undefined));

  it("обрабатывает событие в контексте отправителя", async () => {
    let seen: ReturnType<typeof getContext>;
    const handle = jest.fn(async () => {
      seen = getContext();
    });

    await expect(consumer(handle).process(raw, meta)).resolves.toBe("handled");
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: event.messageId }),
      meta,
    );
    expect(seen!).toMatchObject({ correlationId: "corr-7", causationId: event.messageId });
    expect(send).not.toHaveBeenCalled();
  });

  it("повторяет временный сбой и конфликт версий, не теряя событие", async () => {
    const handle = jest
      .fn()
      .mockRejectedValueOnce(new ExternalServiceError("база перезапускается"))
      .mockRejectedValueOnce(new ConflictError("версия изменилась"))
      .mockResolvedValue(undefined);

    await expect(consumer(handle).process(raw, meta)).resolves.toBe("handled");
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it("после исчерпания повторов переносит сообщение в DLQ с причиной", async () => {
    const handle = jest.fn().mockRejectedValue(new ExternalServiceError("всё ещё лежит"));

    await expect(consumer(handle).process(raw, meta)).resolves.toBe("dead-lettered");
    expect(handle).toHaveBeenCalledTimes(3);
    const sent = send.mock.calls[0][0];
    expect(sent.topic).toBe("payment.events.dlq");
    expect(sent.messages[0]).toMatchObject({
      key: event.aggregateId,
      value: raw,
      headers: expect.objectContaining({
        "x-original-topic": "payment.events",
        "x-original-offset": "42",
        "x-attempts": "3",
        "x-error": "всё ещё лежит",
      }),
    });
  });

  it("ошибку, повтор которой бессмыслен, сразу переносит в DLQ", async () => {
    const handle = jest.fn().mockRejectedValue(new DomainRuleError("недопустимый переход"));
    await expect(consumer(handle).process(raw, meta)).resolves.toBe("dead-lettered");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("неразборчивое сообщение уходит в DLQ, не останавливая партицию", async () => {
    const handle = jest.fn();
    await expect(consumer(handle).process("{не json", meta)).resolves.toBe("dead-lettered");
    expect(handle).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].messages[0].headers["x-error"]).toMatch(/не разобрано/);
  });

  it("если DLQ недоступна, ошибка уходит брокеру — сообщение будет прочитано снова", async () => {
    send.mockRejectedValue(new Error("брокер недоступен"));
    const handle = jest.fn().mockRejectedValue(new DomainRuleError("плохое событие"));
    await expect(consumer(handle).process(raw, meta)).rejects.toThrow("брокер недоступен");
  });
});
