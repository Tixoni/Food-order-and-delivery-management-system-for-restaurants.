import { runWithContext } from "./context";
import { createLogger, maskSensitive } from "./logger";

/** Собирает записи журнала вместо вывода в консоль. */
function collector() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    sink: (line: string) => lines.push(JSON.parse(line)),
  };
}

describe("журнал", () => {
  it("пишет строку JSON с обязательными полями", () => {
    const { lines, sink } = collector();
    createLogger({ service: "catalog", sink }).info("меню обновлено", { restaurantId: "r-1" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      service: "catalog",
      message: "меню обновлено",
      restaurantId: "r-1",
    });
    expect(typeof lines[0].timestamp).toBe("string");
  });

  it("подставляет идентификатор действия из контекста, не требуя передавать его явно", () => {
    const { lines, sink } = collector();
    const logger = createLogger({ service: "order", sink });

    runWithContext({ correlationId: "corr-42", userId: "user-7" }, () => {
      logger.info("заказ создан");
    });

    expect(lines[0].correlationId).toBe("corr-42");
    expect(lines[0].userId).toBe("user-7");
  });

  it("не пишет записи ниже установленного уровня", () => {
    const { lines, sink } = collector();
    const logger = createLogger({ service: "order", level: "warn", sink });

    logger.debug("подробность");
    logger.info("сообщение");
    logger.warn("предупреждение");

    expect(lines.map((l) => l.level)).toEqual(["warn"]);
  });

  it("сохраняет постоянные поля дочернего журнала", () => {
    const { lines, sink } = collector();
    createLogger({ service: "order", sink }).child({ orderId: "o-9" }).info("статус изменён");

    expect(lines[0].orderId).toBe("o-9");
  });

  it("разворачивает ошибку в отдельные поля", () => {
    const { lines, sink } = collector();
    createLogger({ service: "payment", sink }).error("сбой оплаты", new Error("шлюз недоступен"));

    expect(lines[0]).toMatchObject({
      level: "error",
      errorName: "Error",
      errorMessage: "шлюз недоступен",
    });
  });
});

describe("сокрытие чувствительных данных", () => {
  it("скрывает данные карты и учётные данные — требование SEC-3", () => {
    const masked = maskSensitive({
      cardNumber: "4111111111111111",
      cvv: "123",
      password: "qwerty",
      accessToken: "eyJ...",
      amount: 1290,
    }) as Record<string, unknown>;

    expect(masked.cardNumber).toBe("***");
    expect(masked.cvv).toBe("***");
    expect(masked.password).toBe("***");
    expect(masked.accessToken).toBe("***");
    expect(masked.amount).toBe(1290);
  });

  it("скрывает персональные данные — требование SEC-4", () => {
    const masked = maskSensitive({
      customer: { name: "Иван", phone: "+79990000000", email: "a@b.ru" },
    }) as { customer: Record<string, unknown> };

    expect(masked.customer.phone).toBe("***");
    expect(masked.customer.email).toBe("***");
    expect(masked.customer.name).toBe("Иван");
  });

  it("скрывает адрес доставки в любом поле с адресом — SEC-4", () => {
    const masked = maskSensitive({
      dropoffAddress: "Тверская, 7, кв. 12",
      order: { addressText: "Арбат, 10", contactPhone: "+79990000000", status: "PAID" },
    }) as { dropoffAddress: string; order: Record<string, unknown> };

    expect(masked.dropoffAddress).toBe("***");
    expect(masked.order.addressText).toBe("***");
    expect(masked.order.contactPhone).toBe("***");
    expect(masked.order.status).toBe("PAID");
  });

  it("распознаёт поля независимо от написания", () => {
    const masked = maskSensitive({
      card_number: "4111",
      "refresh-token": "x",
      AUTHORIZATION: "Bearer y",
    }) as Record<string, unknown>;

    expect(Object.values(masked)).toEqual(["***", "***", "***"]);
  });

  it("обрабатывает вложенность и массивы", () => {
    const masked = maskSensitive({
      items: [{ price: 100, token: "secret" }],
    }) as { items: Record<string, unknown>[] };

    expect(masked.items[0].price).toBe(100);
    expect(masked.items[0].token).toBe("***");
  });

  it("не зацикливается на слишком глубокой структуре", () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i++) deep = { nested: deep };

    expect(() => maskSensitive(deep)).not.toThrow();
  });

  it("применяется к записям журнала, а не только к отдельным объектам", () => {
    const { lines, sink } = collector();
    createLogger({ service: "payment", sink }).info("платёж принят", {
      payment: { amount: 1290, cardNumber: "4111111111111111" },
    });

    const payment = lines[0].payment as Record<string, unknown>;
    expect(payment.cardNumber).toBe("***");
    expect(payment.amount).toBe(1290);
  });
});
