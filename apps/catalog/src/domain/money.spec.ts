import { assertMoney, formatKopecks, MoneyError } from "./money";

describe("деньги", () => {
  describe("проверка суммы", () => {
    it.each([0, 1, 39000, 1_000_000])("принимает целое неотрицательное: %s", (value) => {
      expect(() => assertMoney(value, "цена")).not.toThrow();
    });

    it.each([-1, -39000])("отклоняет отрицательное по умолчанию: %s", (value) => {
      expect(() => assertMoney(value, "цена")).toThrow(MoneyError);
    });

    it("принимает отрицательное, когда это разрешено явно", () => {
      expect(() => assertMoney(-5000, "надбавка", { allowNegative: true })).not.toThrow();
    });

    it.each([0.5, 390.01, 1 / 3])("отклоняет дробное: %s", (value) => {
      expect(() => assertMoney(value, "цена")).toThrow(/целым числом копеек/);
    });

    it("отклоняет значение за пределами точного представления", () => {
      expect(() => assertMoney(Number.MAX_SAFE_INTEGER + 2, "цена")).toThrow();
    });

    it("называет поле в сообщении об ошибке", () => {
      expect(() => assertMoney(-1, "блюдо «Пицца»")).toThrow(/блюдо «Пицца»/);
    });
  });

  describe("отображение суммы", () => {
    it.each([
      [39000, "390,00 ₽"],
      [39050, "390,50 ₽"],
      [5, "0,05 ₽"],
      [0, "0,00 ₽"],
      [-5000, "−50,00 ₽"],
    ])("%s копеек → %s", (value, expected) => {
      expect(formatKopecks(value)).toBe(expected);
    });
  });
});
