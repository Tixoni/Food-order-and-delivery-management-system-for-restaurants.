import { Restaurant, RestaurantValidationError } from "./restaurant";

/**
 * Тесты доменного слоя не поднимают базу, брокер и сервер.
 * Весь файл выполняется за миллисекунды — именно ради этого
 * домен отделён от инфраструктуры.
 */

const valid = {
  id: "r-1",
  name: "Тестовый ресторан",
  minOrderAmount: 50000, // 500 рублей
  deliveryFeeBase: 14900, // 149 рублей
  avgCookingTimeMin: 25,
  isActive: true,
};

describe("ресторан", () => {
  describe("создание", () => {
    it("создаётся с корректными данными", () => {
      const restaurant = Restaurant.create(valid);

      expect(restaurant.id).toBe("r-1");
      expect(restaurant.name).toBe("Тестовый ресторан");
      expect(restaurant.minOrderAmount).toBe(50000);
    });

    it("убирает лишние пробелы в названии", () => {
      expect(Restaurant.create({ ...valid, name: "  Пицца  " }).name).toBe("Пицца");
    });

    it.each([
      ["пустое название", { name: "" }],
      ["название из пробелов", { name: "   " }],
      ["слишком длинное название", { name: "a".repeat(201) }],
      ["отрицательная минимальная сумма", { minOrderAmount: -1 }],
      ["дробная минимальная сумма", { minOrderAmount: 100.5 }],
      ["отрицательная стоимость доставки", { deliveryFeeBase: -100 }],
      ["нулевое время приготовления", { avgCookingTimeMin: 0 }],
    ])("не создаётся: %s", (_name, patch) => {
      expect(() => Restaurant.create({ ...valid, ...patch })).toThrow(RestaurantValidationError);
    });

    it("допускает нулевую минимальную сумму и бесплатную доставку", () => {
      expect(() =>
        Restaurant.create({ ...valid, minOrderAmount: 0, deliveryFeeBase: 0 }),
      ).not.toThrow();
    });
  });

  /** Требование CART-3. */
  describe("минимальная сумма заказа", () => {
    const restaurant = Restaurant.create(valid);

    it("принимает заказ ровно на минимальную сумму", () => {
      expect(restaurant.canAcceptOrderTotal(50000)).toBe(true);
    });

    it("принимает заказ выше минимальной суммы", () => {
      expect(restaurant.canAcceptOrderTotal(50001)).toBe(true);
    });

    it("не принимает заказ ниже минимальной суммы", () => {
      expect(restaurant.canAcceptOrderTotal(49999)).toBe(false);
    });

    it("не принимает заказ, если ресторан отключён", () => {
      const inactive = Restaurant.create({ ...valid, isActive: false });
      expect(inactive.canAcceptOrderTotal(100000)).toBe(false);
    });

    it("сообщает, сколько не хватает до минимума", () => {
      expect(restaurant.amountMissingToMinimum(30000)).toBe(20000);
      expect(restaurant.amountMissingToMinimum(50000)).toBe(0);
      expect(restaurant.amountMissingToMinimum(70000)).toBe(0);
    });
  });
});
