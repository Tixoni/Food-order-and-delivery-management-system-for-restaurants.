import { assembleMenu, MenuCategory, MenuCategoryError } from "./menu-category";
import { MenuItem } from "./menu-item";

const category = (id: string, name: string, sortOrder: number, isActive = true) =>
  MenuCategory.create({ id, restaurantId: "r-1", name, sortOrder, isActive });

const item = (id: string, categoryId: string, name: string, sortOrder: number) =>
  MenuItem.create({
    id,
    restaurantId: "r-1",
    categoryId,
    name,
    price: 30000,
    isAvailable: true,
    sortOrder,
  });

describe("категория меню", () => {
  it("создаётся и обрезает пробелы", () => {
    expect(category("c-1", "  Пицца  ", 0).name).toBe("Пицца");
  });

  it.each([
    ["пустое название", ""],
    ["пробелы вместо названия", "   "],
    ["слишком длинное название", "a".repeat(201)],
  ])("не создаётся: %s", (_name, value) => {
    expect(() => category("c-1", value, 0)).toThrow(MenuCategoryError);
  });

  it("отклоняет дробный порядок вывода", () => {
    expect(() => category("c-1", "Пицца", 1.5)).toThrow(MenuCategoryError);
  });
});

describe("сборка меню для показа", () => {
  it("выстраивает категории по порядку вывода", () => {
    const menu = assembleMenu(
      [category("c-2", "Напитки", 2), category("c-1", "Пицца", 1)],
      [item("i-1", "c-1", "Маргарита", 0), item("i-2", "c-2", "Морс", 0)],
    );

    expect(menu.map((s) => s.category.name)).toEqual(["Пицца", "Напитки"]);
  });

  it("выстраивает блюда внутри категории", () => {
    const menu = assembleMenu(
      [category("c-1", "Пицца", 0)],
      [item("i-1", "c-1", "Пепперони", 2), item("i-2", "c-1", "Маргарита", 1)],
    );

    expect(menu[0].items.map((i) => i.name)).toEqual(["Маргарита", "Пепперони"]);
  });

  it("при равном порядке выстраивает по названию", () => {
    const menu = assembleMenu(
      [category("c-1", "Пицца", 0)],
      [item("i-1", "c-1", "Ялта", 0), item("i-2", "c-1", "Авиньон", 0)],
    );

    expect(menu[0].items.map((i) => i.name)).toEqual(["Авиньон", "Ялта"]);
  });

  it("не показывает отключённые категории", () => {
    const menu = assembleMenu(
      [category("c-1", "Пицца", 0), category("c-2", "Архив", 1, false)],
      [item("i-1", "c-1", "Маргарита", 0), item("i-2", "c-2", "Старое блюдо", 0)],
    );

    expect(menu.map((s) => s.category.name)).toEqual(["Пицца"]);
  });

  it("не показывает пустые категории — раздел без блюд выглядит как неисправность", () => {
    const menu = assembleMenu(
      [category("c-1", "Пицца", 0), category("c-2", "Напитки", 1)],
      [item("i-1", "c-1", "Маргарита", 0)],
    );

    expect(menu).toHaveLength(1);
  });

  it("на пустом меню возвращает пустой список, а не ошибку", () => {
    expect(assembleMenu([], [])).toEqual([]);
  });
});
