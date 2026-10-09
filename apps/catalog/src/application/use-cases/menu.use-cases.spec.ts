import { ConflictError, DomainRuleError, NotFoundError } from "@food-delivery/shared";
import { GetRestaurantMenuUseCase } from "./get-restaurant-menu.use-case";
import { ManageMenuItemUseCase } from "./manage-menu-item.use-case";
import { PriceMenuItemUseCase } from "./price-menu-item.use-case";
import {
  InMemoryMenuCache,
  InMemoryMenuRepository,
  InMemoryRestaurantRepository,
  category,
  item,
  restaurant,
  sizeGroup,
} from "./in-memory.doubles";

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
    const cache = new InMemoryMenuCache();
    return { menu, cache, useCase: new GetRestaurantMenuUseCase(menu, restaurants, cache) };
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

  it("повторное чтение берёт меню из кэша, не обращаясь к базе", async () => {
    const { menu, cache, useCase } = build();

    await useCase.execute({ restaurantId: "r-1" });
    menu.items = [];
    const second = await useCase.execute({ restaurantId: "r-1" });

    expect(cache.writes).toBe(1);
    expect(second[0].items.map((i) => i.name)).toEqual(["Маргарита"]);
  });

  it("клиентское меню и меню менеджера кэшируются раздельно", async () => {
    const { cache, useCase } = build();

    await useCase.execute({ restaurantId: "r-1" });
    const forManager = await useCase.execute({ restaurantId: "r-1", includeUnavailable: true });

    expect(cache.writes).toBe(2);
    expect(forManager[0].items.map((i) => i.name)).toEqual(["Маргарита", "Пепперони"]);
  });

  it("несуществующий ресторан остаётся ошибкой и при заполненном кэше", async () => {
    const { useCase } = build();

    await useCase.execute({ restaurantId: "r-1" });

    await expect(useCase.execute({ restaurantId: "r-404" })).rejects.toThrow(NotFoundError);
  });

  it("у ресторана без меню возвращает пустой список, а не ошибку", async () => {
    const menu = new InMemoryMenuRepository([], []);
    const useCase = new GetRestaurantMenuUseCase(
      menu,
      new InMemoryRestaurantRepository([restaurant()]),
      new InMemoryMenuCache(),
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
    const cache = new InMemoryMenuCache();
    return { menu, cache, useCase: new ManageMenuItemUseCase(menu, restaurants, cache) };
  };

  describe("создание", () => {
    it("сохраняет адрес изображения в блюде", async () => {
      const { useCase } = build();
      const created = await useCase.create({
        restaurantId: "r-1",
        categoryId: "c-1",
        name: "Сырная",
        price: 30000,
        imageUrl: "https://example.org/pizza.jpg",
      });
      expect(created.imageUrl).toBe("https://example.org/pizza.jpg");
    });
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

    it("сообщает об изменении меню событием и сбрасывает кэш", async () => {
      const { menu, cache, useCase } = build();

      await useCase.create({
        restaurantId: "r-1",
        categoryId: "c-1",
        name: "Четыре сыра",
        price: 52000,
      });

      expect(menu.published.map((e) => e.eventType)).toEqual(["MenuUpdated"]);
      expect(cache.invalidations).toBe(1);
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

    it("сообщает об изменении меню событием и сбрасывает кэш", async () => {
      const { menu, cache, useCase } = build();

      await useCase.update({ itemId: "i-1", restaurantId: "r-1", price: 45000 });

      expect(menu.published.map((e) => e.eventType)).toEqual(["MenuUpdated"]);
      expect(cache.invalidations).toBe(1);
    });

    it("отклонённое изменение не порождает события и не трогает кэш", async () => {
      const { menu, cache, useCase } = build();

      await expect(
        useCase.update({ itemId: "i-1", restaurantId: "r-2", price: 1000 }),
      ).rejects.toThrow(ConflictError);

      expect(menu.published).toHaveLength(0);
      expect(cache.invalidations).toBe(0);
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

  it("архивирует блюдо, скрывает его из меню и публикует событие", async () => {
    const { menu, cache, useCase } = build();
    await useCase.remove("i-1", "r-1");
    expect(await menu.findItemById("i-1")).toBeNull();
    expect(await menu.findItems("r-1", { includeUnavailable: true })).toHaveLength(0);
    expect(menu.published[0].payload).toMatchObject({ change: "deleted" });
    expect(cache.invalidations).toBe(1);
  });

  it("не позволяет удалить блюдо чужого ресторана", async () => {
    await expect(build().useCase.remove("i-1", "r-2")).rejects.toThrow(ConflictError);
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
