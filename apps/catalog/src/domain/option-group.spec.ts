import { ItemOption, OptionGroup, OptionSelectionError } from "./option-group";
import { MoneyError } from "./money";

const option = (id: string, name: string, delta = 0, available = true) =>
  ItemOption.create({ id, name, priceDelta: delta, isAvailable: available });

describe("вариант модификатора", () => {
  it("создаётся с положительной, нулевой и отрицательной надбавкой", () => {
    expect(option("o-1", "Бекон", 8000).priceDelta).toBe(8000);
    expect(option("o-2", "Средний", 0).priceDelta).toBe(0);
    expect(option("o-3", "Маленький", -5000).priceDelta).toBe(-5000);
  });

  it("не создаётся с пустым названием", () => {
    expect(() => option("o-1", "  ")).toThrow(OptionSelectionError);
  });

  it("не создаётся с дробной надбавкой", () => {
    expect(() => option("o-1", "Сыр", 60.5)).toThrow(MoneyError);
  });
});

describe("группа модификаторов", () => {
  const group = (patch: Partial<Parameters<typeof OptionGroup.create>[0]> = {}) =>
    OptionGroup.create({
      id: "g-1",
      name: "Добавки",
      selectionType: "multiple",
      isRequired: false,
      minSelect: 0,
      maxSelect: 2,
      options: [option("o-1", "Сыр", 6000), option("o-2", "Бекон", 8000)],
      ...patch,
    });

  describe("настройка", () => {
    it("создаётся корректная группа", () => {
      expect(group().options).toHaveLength(2);
    });

    it.each([
      ["пустое название", { name: " " }],
      ["отрицательный минимум", { minSelect: -1 }],
      ["нулевой максимум", { maxSelect: 0 }],
      ["максимум меньше минимума", { minSelect: 2, maxSelect: 1 }],
      ["группа без вариантов", { options: [] }],
      ["требуется больше вариантов, чем есть", { minSelect: 5, maxSelect: 5 }],
    ])("отклоняет: %s", (_name, patch) => {
      expect(() => group(patch)).toThrow(OptionSelectionError);
    });

    it("отклоняет одиночный выбор с максимумом больше единицы", () => {
      expect(() => group({ selectionType: "single", maxSelect: 3 })).toThrow(
        /при одиночном выборе максимум/,
      );
    });

    it("отклоняет обязательную группу с нулевым минимумом", () => {
      expect(() => group({ isRequired: true, minSelect: 0 })).toThrow(
        /должна требовать хотя бы один/,
      );
    });

    it("отклоняет варианты с одинаковыми идентификаторами", () => {
      expect(() => group({ options: [option("o-1", "Сыр"), option("o-1", "Бекон")] })).toThrow(
        /одинаковыми идентификаторами/,
      );
    });
  });

  describe("проверка выбора", () => {
    it("принимает пустой выбор в необязательной группе", () => {
      expect(group().resolveSelection([])).toEqual([]);
    });

    it("возвращает выбранные варианты в порядке выбора", () => {
      const chosen = group().resolveSelection(["o-2", "o-1"]);

      expect(chosen.map((o) => o.name)).toEqual(["Бекон", "Сыр"]);
    });

    it("сообщает понятную причину для обязательной группы", () => {
      const required = group({
        name: "Размер",
        selectionType: "single",
        isRequired: true,
        minSelect: 1,
        maxSelect: 1,
      });

      expect(() => required.resolveSelection([])).toThrow(
        "нужно выбрать вариант в группе «Размер»",
      );
    });

    it("сообщает про минимум, когда он больше единицы", () => {
      const twoOfThem = group({ minSelect: 2, maxSelect: 2 });

      expect(() => twoOfThem.resolveSelection(["o-1"])).toThrow(/не менее 2/);
    });

    it("отклоняет недоступный вариант", () => {
      const withStopped = group({
        options: [option("o-1", "Сыр", 6000), option("o-2", "Трюфель", 25000, false)],
      });

      expect(() => withStopped.resolveSelection(["o-2"])).toThrow(/«Трюфель» временно недоступен/);
    });
  });

  describe("поиск варианта", () => {
    it("находит существующий", () => {
      expect(group().findOption("o-1")?.name).toBe("Сыр");
    });

    it("не находит отсутствующий", () => {
      expect(group().findOption("o-404")).toBeUndefined();
    });
  });
});
