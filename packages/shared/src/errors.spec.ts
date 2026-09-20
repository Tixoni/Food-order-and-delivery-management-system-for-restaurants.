import {
  ConflictError,
  DomainRuleError,
  ExternalServiceError,
  isAppError,
  isRetryable,
  NotFoundError,
  TimeoutError,
  ValidationError,
} from "./errors";

describe("ошибки приложения", () => {
  it("несут код и код состояния для ответа клиенту", () => {
    const error = new NotFoundError("ресторан не найден", { restaurantId: "r-1" });

    expect(error.code).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
    expect(error.details).toEqual({ restaurantId: "r-1" });
    expect(error.name).toBe("NotFoundError");
  });

  it("распознаются проверкой типа", () => {
    expect(isAppError(new ValidationError("нет адреса"))).toBe(true);
    expect(isAppError(new Error("обычная ошибка"))).toBe(false);
    expect(isAppError("строка")).toBe(false);
  });

  it("сериализуются без внутренних подробностей", () => {
    const json = new ConflictError("недопустимый переход статуса", { from: "Создан" }).toJSON();

    expect(json).toEqual({
      code: "CONFLICT",
      message: "недопустимый переход статуса",
      details: { from: "Создан" },
    });
    expect(json).not.toHaveProperty("stack");
  });

  /**
   * Это решение определяет поведение оркестратора саги: повторять шаг
   * или сразу запускать компенсацию. Ошибка в нём приводит либо к потере
   * времени на бессмысленные повторы, либо к отмене заказа из-за помехи в сети.
   */
  describe("пригодность к повтору", () => {
    it.each([
      [new ExternalServiceError("платёжный шлюз недоступен"), true],
      [new TimeoutError("превышено время ожидания"), true],
      [new ValidationError("адрес вне зоны доставки"), false],
      [new DomainRuleError("сумма меньше минимальной"), false],
      [new ConflictError("заказ уже отменён"), false],
      [new NotFoundError("блюдо снято с продажи"), false],
    ])("$constructor.name → %s", (error, expected) => {
      expect(isRetryable(error)).toBe(expected);
    });

    it("обычная ошибка повтору не подлежит", () => {
      expect(isRetryable(new Error("неизвестно"))).toBe(false);
    });
  });
});
