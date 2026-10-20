import { createEvent, InvalidEventError, parseEvent } from "./envelope";

describe("конверт доменного события", () => {
  const base = {
    eventType: "OrderPlaced",
    aggregateType: "Order",
    aggregateId: "order-1",
    correlationId: "corr-1",
    payload: { total: 1290 },
  };

  it("заполняет обязательные поля и проставляет версию по умолчанию", () => {
    const event = createEvent(base);

    expect(event.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.eventType).toBe("OrderPlaced");
    expect(event.eventVersion).toBe(1);
    expect(event.correlationId).toBe("corr-1");
    expect(event.payload).toEqual({ total: 1290 });
    expect(new Date(event.occurredAt).toString()).not.toBe("Invalid Date");
  });

  it("выдаёт разные идентификаторы сообщений при одинаковых данных", () => {
    expect(createEvent(base).messageId).not.toBe(createEvent(base).messageId);
  });

  it("не создаёт событие без идентификатора действия — иначе теряется трассировка", () => {
    expect(() => createEvent({ ...base, correlationId: "  " })).toThrow(InvalidEventError);
  });

  it.each(["eventType", "aggregateType", "aggregateId"] as const)(
    "не создаёт событие без поля %s",
    (field) => {
      expect(() => createEvent({ ...base, [field]: "" })).toThrow(InvalidEventError);
    },
  );

  it("не добавляет causationId, если причины нет", () => {
    expect(createEvent(base)).not.toHaveProperty("causationId");
  });

  describe("разбор пришедшего события", () => {
    it("принимает корректный конверт", () => {
      const event = createEvent(base);
      const parsed = parseEvent(JSON.parse(JSON.stringify(event)));
      expect(parsed.messageId).toBe(event.messageId);
    });

    it("сохраняет неизвестные поля: потребитель терпим к расширению схемы", () => {
      const raw = { ...createEvent(base), newFieldFromFutureVersion: 42 };
      const parsed = parseEvent(raw) as unknown as Record<string, unknown>;
      expect(parsed.newFieldFromFutureVersion).toBe(42);
    });

    it.each([
      ["не объект", "строка"],
      ["без messageId", { ...{ ...{} }, eventType: "X" }],
    ])("отклоняет некорректный конверт (%s)", (_name, raw) => {
      expect(() => parseEvent(raw)).toThrow(InvalidEventError);
    });

    it("отклоняет конверт с нечисловой версией", () => {
      const raw = { ...createEvent(base), eventVersion: "1" };
      expect(() => parseEvent(raw)).toThrow(/eventVersion/);
    });
  });
});
