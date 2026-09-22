import { ConflictError, DomainRuleError, NotFoundError } from "@food-delivery/shared";
import { MenuCategory } from "../../domain/menu-category";
import { MenuItem } from "../../domain/menu-item";
import { ItemOption, OptionGroup } from "../../domain/option-group";
import { Restaurant } from "../../domain/restaurant";
import type { MenuRepository } from "../ports/menu.repository";
import type { RestaurantRepository } from "../ports/restaurant.repository";
import { GetRestaurantMenuUseCase } from "./get-restaurant-menu.use-case";
import { ManageMenuItemUseCase } from "./manage-menu-item.use-case";
import { PriceMenuItemUseCase } from "./price-menu-item.use-case";

/**
 * Хранилища в памяти вместо PostgreSQL. Ровно то, ради чего вводились порты:
 * сценарии проверяются без базы, контейнеров и сети — за миллисекунды.
 */
class InMemoryMenuRepository implements MenuRepository {
  constructor(
    public categories: MenuCategory[] = [],
    public items: MenuItem[] = [],
  ) {}

  async findCategories(restaurantId: string) {
    return this.categories.filter((c) => c.restaurantId === restaurantId);
  }

  async findItems(restaurantId: string, options?: { includeUnavailable?: boolean }) {
    return this.items.filter(
      (i) => i.restaurantId === restaurantId && (options?.includeUnavailable || i.isAvailable),
    );
  }

  async findItemById(itemId: string) {
    return this.items.find((i) => i.id === itemId) ?? null;
  }

  async saveItem(item: MenuItem) {
    const index = this.items.findIndex((i) => i.id === item.id);
    if (index >= 0) this.items[index] = item;
    else this.items.push(item);
  }

  async saveCategory(category: MenuCategory) {
    const index = this.categories.findIndex((c) => c.id === category.id);
    if (index >= 0) this.categories[index] = category;
    else this.categories.push(category);
  }

  async categoryExists(categoryId: string, restaurantId: string) {
    return this.categories.some((c) => c.id === categoryId && c.restaurantId === restaurantId);
  }
}

class InMemoryRestaurantRepository implements RestaurantRepository {
  constructor(private readonly items: Restaurant[] = []) {}
  async findActive(limit: number, offset: number) {
    return this.items.filter((r) => r.isActive).slice(offset, offset + limit);
  }
  async findById(id: string) {
    return this.items.find((r) => r.id === id) ?? null;
  }
  async countActive() {
    return this.items.filter((r) => r.isActive).length;
  }
}

const restaurant = (id = "r-1") =>
  Restaurant.create({
    id,
    name: `Ресторан ${id}`,
    minOrderAmount: 50000,
    deliveryFeeBase: 14900,
    avgCookingTimeMin: 25,
    isActive: true,
  });

const category = (id: string, name: string, sortOrder = 0, restaurantId = "r-1") =>
  MenuCategory.create({ id, restaurantId, name, sortOrder, isActive: true });

const sizeGroup = () =>
  OptionGroup.create({
    id: "g-size",
    name: "Размер",
    selectionType: "single",
    isRequired: true,
    minSelect: 1,
    maxSelect: 1,
    options: [
      ItemOption.create({ id: "o-medium", name: "Средний", priceDelta: 0, isAvailable: true }),
      ItemOption.create({ id: "o-large", name: "Большой", priceDelta: 9000, isAvailable: true }),
    ],
  });

const item = (
  id: string,
  categoryId: string,
  name: string,
  overrides: Partial<Parameters<typeof MenuItem.create>[0]> = {},
) =>
  MenuItem.create({
    id,
    restaurantId: "r-1",
    categoryId,
    name,
    price: 39000,
    isAvailable: true,
    sortOrder: 0,
    ...overrides,
  });

describe("сценарий «меню ресторана»", () => {
  const build = () => {
    const menu = new InMemoryMenuRepository(
      [category("c-1", "Пицца", 0), category("c-2", "Напитки", 1)],
      [
        item("i-1", "c-1", "Маргарита"),
        item("i-2", "c-1", "Пепперони", { isAvailable: false }),
        item("i-3", "c-2", "Морс", { price: 15000 }),
      ],
    );
    const restaurants = new InMemoryRestaurantRepository([restaurant()]);
    return { menu, useCase: new GetRestaurantMenuUseCase(menu, restaurants) };
  };

  it("группирует блюда по категориям и соблюдает порядок", async () => {
    const sections = await build().useCase.execute({ restaurantId: "r-1" });

    expect(sections.map((s) => s.category.name)).toEqual(["Пицца", "Напитки"]);
    expect(sections[0].items.map((i) => i.name)).toEqual(["Маргарита"]);
  });

  it("клиенту не показывает блюда из стоп-листа", async () => {
    const sections = await build().useCase.execute({ restaurantId: "r-1" });

    expect(sections[0].items.map((i) => i.name)).not.toContain("Пепперони");
  });

  it("менеджеру показывает и блюда из стоп-листа", async () => {
    const sections = await build().useCase.execute({
      restaurantId: "r-1",
      includeUnavailable: true,
    });

    expect(sections[0].items.map((i) => i.name)).toEqual(["Маргарита", "Пепперони"]);
  });

  it("сообщает, что ресторан не найден", async () => {
    await expect(build().useCase.execute({ restaurantId: "r-404" })).rejects.toThrow(NotFoundError);
  });

  it("у ресторана без меню возвращает пустой список, а не ошибку", async () => {
    const menu = new InMemoryMenuRepository([], []);
    const useCase = new GetRestaurantMenuUseCase(
      menu,
      new InMemoryRestaurantRepository([restaurant()]),
    );

    await expect(useCase.execute({ restaurantId: "r-1" })).resolves.toEqual([]);
  });
});

describe("сценарий «управление блюдом»", () => {
  const build = () => {
    const menu = new InMemoryMenuRepository(
      [category("c-1", "Пицца"), category("c-9", "Чужая", 0, "r-2")],
      [item("i-1", "c-1", "Маргарита")],
    );
    const restaurants = new InMemoryRestaurantRepository([restaurant("r-1"), restaurant("r-2")]);
    return { menu, useCase: new ManageMenuItemUseCase(menu, restaurants) };
  };

  describe("создание", () => {
    it("создаёт блюдо и сохраняет его", async () => {
      const { menu, useCase } = build();

      const created = await useCase.create({
        restaurantId: "r-1",
        categoryId: "c-1",
        name: "Четыре сыра",
        price: 52000,
      });

      expect(created.name).toBe("Четыре сыра");
      expect(created.isAvailable).toBe(true);
      expect(await menu.findItemById(created.id)).not.toBeNull();
    });

    it("выдаёт новому блюду собственный идентификатор", async () => {
      const { useCase } = build();

      const first = await useCase.create({
        restaurantId: "r-1",
        categoryId: "c-1",
        name: "Первая",
        price: 30000,
      });
      const second = await useCase.create({
        restaurantId: "r-1",
        categoryId: "c-1",
        name: "Вторая",
        price: 30000,
      });

      expect(first.id).not.toBe(second.id);
    });

    it("не создаёт блюдо в несуществующем ресторане", async () => {
      await expect(
        build().useCase.create({
          restaurantId: "r-404",
          categoryId: "c-1",
          name: "Пицца",
          price: 30000,
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it("не создаёт блюдо в категории чужого ресторана", async () => {
      await expect(
        build().useCase.create({
          restaurantId: "r-1",
          categoryId: "c-9",
          name: "Пицца",
          price: 30000,
        }),
      ).rejects.toThrow(/категория не найдена/);
    });

    it("переводит нарушение правила домена в ошибку для пользователя", async () => {
      await expect(
        build().useCase.create({
          restaurantId: "r-1",
          categoryId: "c-1",
          name: "Пицца",
          price: -100,
        }),
      ).rejects.toThrow(DomainRuleError);
    });
  });

  describe("изменение", () => {
    it("меняет только переданные поля", async () => {
      const { useCase } = build();

      const updated = await useCase.update({
        itemId: "i-1",
        restaurantId: "r-1",
        price: 45000,
      });

      expect(updated.price).toBe(45000);
      expect(updated.name).toBe("Маргарита");
    });

    it("сохраняет изменение в хранилище", async () => {
      const { menu, useCase } = build();

      await useCase.update({ itemId: "i-1", restaurantId: "r-1", name: "Маргарита особая" });

      expect((await menu.findItemById("i-1"))?.name).toBe("Маргарита особая");
    });

    it("сообщает, что блюдо не найдено", async () => {
      await expect(
        build().useCase.update({ itemId: "i-404", restaurantId: "r-1", price: 1000 }),
      ).rejects.toThrow(NotFoundError);
    });

    it("не даёт править блюдо чужого ресторана", async () => {
      await expect(
        build().useCase.update({ itemId: "i-1", restaurantId: "r-2", price: 1000 }),
      ).rejects.toThrow(ConflictError);
    });

    it("не переносит блюдо в категорию чужого ресторана", async () => {
      await expect(
        build().useCase.update({ itemId: "i-1", restaurantId: "r-1", categoryId: "c-9" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("отклоняет изменение, нарушающее правило домена", async () => {
      await expect(
        build().useCase.update({ itemId: "i-1", restaurantId: "r-1", name: "   " }),
      ).rejects.toThrow(DomainRuleError);
    });
  });
});

describe("сценарий «расчёт стоимости позиции»", () => {
  const build = () => {
    const menu = new InMemoryMenuRepository(
      [category("c-1", "Пицца")],
      [
        item("i-1", "c-1", "Маргарита", { optionGroups: [sizeGroup()] }),
        item("i-2", "c-1", "Пепперони", { isAvailable: false }),
        item("i-3", "c-1", "Морс", { price: 15000 }),
      ],
    );
    return new PriceMenuItemUseCase(menu);
  };

  it("считает стоимость с модификаторами", async () => {
    const price = await build().execute({
      itemId: "i-1",
      selections: [{ groupId: "g-size", optionIds: ["o-large"] }],
      quantity: 2,
    });

    expect(price.unitPrice).toBe(48000);
    expect(price.lineTotal).toBe(96000);
  });

  it("считает блюдо без модификаторов", async () => {
    const price = await build().execute({ itemId: "i-3", quantity: 3 });

    expect(price.lineTotal).toBe(45000);
  });

  it("сообщает, что блюдо не найдено", async () => {
    await expect(build().execute({ itemId: "i-404" })).rejects.toThrow(NotFoundError);
  });

  it("не считает блюдо из стоп-листа", async () => {
    await expect(build().execute({ itemId: "i-2" })).rejects.toThrow(/временно недоступно/);
  });

  it("сообщает пользователю понятную причину при неверном выборе", async () => {
    await expect(build().execute({ itemId: "i-1" })).rejects.toThrow(
      /нужно выбрать вариант в группе «Размер»/,
    );
  });

  it("нарушение правила выбора — ошибка пользователя, а не сбой системы", async () => {
    await expect(build().execute({ itemId: "i-1" })).rejects.toBeInstanceOf(DomainRuleError);
  });
});
