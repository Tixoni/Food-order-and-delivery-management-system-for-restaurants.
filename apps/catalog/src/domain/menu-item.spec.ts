import { MenuItem, MenuItemError } from "./menu-item";
import { ItemOption, OptionGroup, OptionSelectionError } from "./option-group";

/**
 * Расчёт цены позиции — самое ответственное место сервиса.
 * Ошибка здесь означает неверную сумму заказа и неверное списание денег,
 * поэтому проверок много и они подробные.
 *
 * Ни один тест не поднимает базу, брокер или сервер: весь файл
 * выполняется за миллисекунды. Ради этого домен и отделён от инфраструктуры.
 */

const option = (id: string, name: string, priceDelta: number, isAvailable = true) =>
  ItemOption.create({ id, name, priceDelta, isAvailable });

/** Обязательный выбор ровно одного варианта. */
const sizeGroup = () =>
  OptionGroup.create({
    id: "g-size",
    name: "Размер",
    selectionType: "single",
    isRequired: true,
    minSelect: 1,
    maxSelect: 1,
    options: [
      option("o-small", "Маленький", -5000),
      option("o-medium", "Средний", 0),
      option("o-large", "Большой", 9000),
    ],
  });

/** Необязательный выбор до трёх вариантов. */
const extrasGroup = () =>
  OptionGroup.create({
    id: "g-extras",
    name: "Добавки",
    selectionType: "multiple",
    isRequired: false,
    minSelect: 0,
    maxSelect: 3,
    options: [
      option("o-cheese", "Дополнительный сыр", 6000),
      option("o-bacon", "Бекон", 8000),
      option("o-sauce", "Острый соус", 3000),
      option("o-truffle", "Трюфель", 25000, false), // закончился
    ],
  });

const pizza = (overrides: Partial<Parameters<typeof MenuItem.create>[0]> = {}) =>
  MenuItem.create({
    id: "i-1",
    restaurantId: "r-1",
    categoryId: "c-1",
    name: "Пицца Маргарита",
    price: 39000, // 390 рублей
    isAvailable: true,
    sortOrder: 0,
    optionGroups: [sizeGroup(), extrasGroup()],
    ...overrides,
  });

describe("блюдо", () => {
  describe("создание", () => {
    it("создаётся с корректными данными", () => {
      const item = pizza();

      expect(item.name).toBe("Пицца Маргарита");
      expect(item.price).toBe(39000);
      expect(item.optionGroups).toHaveLength(2);
    });

    it("убирает лишние пробелы в названии и описании", () => {
      const item = pizza({ name: "  Пицца  ", description: "  вкусная  " });

      expect(item.name).toBe("Пицца");
      expect(item.description).toBe("вкусная");
    });

    it("пустое описание превращается в отсутствующее", () => {
      expect(pizza({ description: "   " }).description).toBeNull();
    });

    it.each([
      ["пустое название", { name: "  " }],
      ["слишком длинное название", { name: "a".repeat(201) }],
      ["отрицательная цена", { price: -1 }],
      ["дробная цена", { price: 390.5 }],
      ["нулевой вес", { weightGrams: 0 }],
      ["дробный вес", { weightGrams: 10.5 }],
      ["отрицательная калорийность", { calories: -1 }],
    ])("не создаётся: %s", (_name, patch) => {
      expect(() => pizza(patch)).toThrow();
    });

    it("допускает бесплатное блюдо", () => {
      expect(() => pizza({ price: 0 })).not.toThrow();
    });

    it("не допускает две группы модификаторов с одним идентификатором", () => {
      expect(() => pizza({ optionGroups: [sizeGroup(), sizeGroup()] })).toThrow(MenuItemError);
    });
  });

  describe("расчёт цены", () => {
    it("считает цену с обязательным и необязательными модификаторами", () => {
      const price = pizza().calculatePrice(
        [
          { groupId: "g-size", optionIds: ["o-large"] },
          { groupId: "g-extras", optionIds: ["o-cheese", "o-bacon"] },
        ],
        2,
      );

      // 390 + 90 (большой) + 60 (сыр) + 80 (бекон) = 620 за штуку
      expect(price.basePrice).toBe(39000);
      expect(price.optionsDelta).toBe(23000);
      expect(price.unitPrice).toBe(62000);
      expect(price.quantity).toBe(2);
      expect(price.lineTotal).toBe(124000); // 1240 рублей
      expect(price.chosenOptions).toHaveLength(3);
    });

    /**
     * Порядок действий: сначала надбавки, потом умножение на количество.
     * Обратный порядок дал бы 390×2 + 90 = 870 вместо 960.
     */
    it("прибавляет модификаторы до умножения на количество", () => {
      const price = pizza().calculatePrice([{ groupId: "g-size", optionIds: ["o-large"] }], 2);

      expect(price.lineTotal).toBe((39000 + 9000) * 2);
      expect(price.lineTotal).not.toBe(39000 * 2 + 9000);
    });

    it("учитывает отрицательную надбавку как скидку", () => {
      const price = pizza().calculatePrice([{ groupId: "g-size", optionIds: ["o-small"] }]);

      expect(price.optionsDelta).toBe(-5000);
      expect(price.unitPrice).toBe(34000); // 340 рублей
    });

    it("по умолчанию считает одну штуку", () => {
      const price = pizza().calculatePrice([{ groupId: "g-size", optionIds: ["o-medium"] }]);

      expect(price.quantity).toBe(1);
      expect(price.lineTotal).toBe(price.unitPrice);
    });

    it("считает блюдо без модификаторов", () => {
      const simple = MenuItem.create({
        id: "i-2",
        restaurantId: "r-1",
        categoryId: "c-1",
        name: "Морс",
        price: 15000,
        isAvailable: true,
        sortOrder: 0,
      });

      expect(simple.calculatePrice([], 3).lineTotal).toBe(45000);
    });

    it("отклоняет цену, ушедшую в минус из-за скидочных модификаторов", () => {
      const cheap = pizza({ price: 1000 }); // 10 рублей, скидка за маленький — 50

      expect(() => cheap.calculatePrice([{ groupId: "g-size", optionIds: ["o-small"] }])).toThrow(
        /отрицательной/,
      );
    });
  });

  describe("проверка выбора модификаторов", () => {
    it("требует выбор в обязательной группе", () => {
      expect(() => pizza().calculatePrice([])).toThrow(/нужно выбрать вариант в группе «Размер»/);
    });

    it("не позволяет выбрать два варианта там, где разрешён один", () => {
      expect(() =>
        pizza().calculatePrice([{ groupId: "g-size", optionIds: ["o-small", "o-large"] }]),
      ).toThrow(/не более 1/);
    });

    it("не позволяет превысить максимум в множественной группе", () => {
      expect(() =>
        pizza().calculatePrice([
          { groupId: "g-size", optionIds: ["o-medium"] },
          { groupId: "g-extras", optionIds: ["o-cheese", "o-bacon", "o-sauce", "o-truffle"] },
        ]),
      ).toThrow(/не более 3/);
    });

    it("не позволяет выбрать один вариант дважды", () => {
      expect(() =>
        pizza().calculatePrice([
          { groupId: "g-size", optionIds: ["o-medium"] },
          { groupId: "g-extras", optionIds: ["o-cheese", "o-cheese"] },
        ]),
      ).toThrow(/дважды/);
    });

    it("не позволяет выбрать недоступный вариант", () => {
      expect(() =>
        pizza().calculatePrice([
          { groupId: "g-size", optionIds: ["o-medium"] },
          { groupId: "g-extras", optionIds: ["o-truffle"] },
        ]),
      ).toThrow(/«Трюфель» временно недоступен/);
    });

    it("не позволяет выбрать несуществующий вариант", () => {
      expect(() =>
        pizza().calculatePrice([{ groupId: "g-size", optionIds: ["o-nonexistent"] }]),
      ).toThrow(/вариант не найден/);
    });

    it("отклоняет выбор в группе, которой у блюда нет", () => {
      expect(() =>
        pizza().calculatePrice([
          { groupId: "g-size", optionIds: ["o-medium"] },
          { groupId: "g-unknown", optionIds: ["o-any"] },
        ]),
      ).toThrow(/модификатор, которого нет у этого блюда/);
    });

    it("отклоняет повторное указание одной группы", () => {
      expect(() =>
        pizza().calculatePrice([
          { groupId: "g-size", optionIds: ["o-medium"] },
          { groupId: "g-size", optionIds: ["o-large"] },
        ]),
      ).toThrow(OptionSelectionError);
    });
  });

  describe("количество", () => {
    it.each([0, -1, 1.5, 100])("отклоняет количество %s", (quantity) => {
      expect(() =>
        pizza().calculatePrice([{ groupId: "g-size", optionIds: ["o-medium"] }], quantity),
      ).toThrow(MenuItemError);
    });

    it("допускает предельное количество", () => {
      const price = pizza().calculatePrice([{ groupId: "g-size", optionIds: ["o-medium"] }], 99);
      expect(price.quantity).toBe(99);
    });
  });

  describe("стоп-лист", () => {
    it("блюдо в стоп-листе нельзя рассчитать", () => {
      const stopped = pizza().withAvailability(false);

      expect(stopped.isOrderable).toBe(false);
      expect(() =>
        stopped.calculatePrice([{ groupId: "g-size", optionIds: ["o-medium"] }]),
      ).toThrow(/временно недоступно/);
    });

    it("возврат из стоп-листа делает блюдо доступным", () => {
      const restored = pizza().withAvailability(false).withAvailability(true);

      expect(restored.isOrderable).toBe(true);
    });

    it("смена доступности не меняет прежний объект", () => {
      const item = pizza();
      item.withAvailability(false);

      expect(item.isAvailable).toBe(true);
    });
  });
});
