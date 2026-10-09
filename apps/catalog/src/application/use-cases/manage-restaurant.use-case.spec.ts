import { DomainRuleError, NotFoundError } from "@food-delivery/shared";
import { ManageRestaurantUseCase } from "./manage-restaurant.use-case";
import { InMemoryRestaurantRepository, restaurant } from "./in-memory.doubles";

const build = () => {
  const restaurants = new InMemoryRestaurantRepository([restaurant("r-1")]);
  return { restaurants, useCase: new ManageRestaurantUseCase(restaurants) };
};

describe("сценарий «регистрация ресторана»", () => {
  it("заводит ресторан и сохраняет его", async () => {
    const { restaurants, useCase } = build();

    const created = await useCase.register({
      name: "Пироговая на Тверской",
      phone: "+7 495 123-45-67",
      addressText: "ул. Тверская, д. 7",
      location: { latitude: 55.7615, longitude: 37.6094 },
    });

    expect(created.name).toBe("Пироговая на Тверской");
    expect(created.isActive).toBe(true);
    expect(await restaurants.findById(created.id)).not.toBeNull();
    expect(restaurants.published).toMatchObject([
      { eventType: "RestaurantChanged", payload: { restaurantId: created.id, change: "created" } },
    ]);
  });

  it("подставляет условия по умолчанию, если их не задали", async () => {
    const created = await build().useCase.register({ name: "Без условий" });

    expect(created.minOrderAmount).toBe(50000);
    expect(created.deliveryFeeBase).toBe(14900);
    expect(created.avgCookingTimeMin).toBe(30);
  });

  it("выдаёт каждому ресторану собственный идентификатор", async () => {
    const { useCase } = build();

    const first = await useCase.register({ name: "Первый" });
    const second = await useCase.register({ name: "Второй" });

    expect(first.id).not.toBe(second.id);
  });

  it("сохраняет координаты, не путая широту с долготой", async () => {
    const created = await build().useCase.register({
      name: "На карте",
      location: { latitude: 55.7615, longitude: 37.6094 },
    });

    expect(created.location?.latitude).toBe(55.7615);
    expect(created.location?.longitude).toBe(37.6094);
  });

  it("отклоняет неразборчивый телефон", async () => {
    await expect(build().useCase.register({ name: "Ресторан", phone: "звоните!" })).rejects.toThrow(
      DomainRuleError,
    );
  });

  it("отклоняет координаты вне допустимого диапазона", async () => {
    await expect(
      build().useCase.register({ name: "Ресторан", location: { latitude: 200, longitude: 37 } }),
    ).rejects.toThrow(/широта вне допустимого диапазона/);
  });

  it("отклоняет пустое название", async () => {
    await expect(build().useCase.register({ name: "   " })).rejects.toThrow(DomainRuleError);
  });

  describe("изменение", () => {
    it("меняет только переданные поля", async () => {
      const updated = await build().useCase.update({
        restaurantId: "r-1",
        minOrderAmount: 70000,
      });

      expect(updated.minOrderAmount).toBe(70000);
      expect(updated.name).toBe("Ресторан r-1");
    });

    it("закрывает ресторан, не удаляя его", async () => {
      const { restaurants, useCase } = build();

      const closed = await useCase.update({ restaurantId: "r-1", isActive: false });

      expect(closed.isActive).toBe(false);
      expect(await restaurants.findById("r-1")).not.toBeNull();
      expect(restaurants.published).toMatchObject([
        { eventType: "RestaurantChanged", payload: { restaurantId: "r-1", change: "updated" } },
      ]);
    });

    it("сообщает, что ресторан не найден", async () => {
      await expect(
        build().useCase.update({ restaurantId: "r-404", name: "Новое имя" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("отклоняет изменение, нарушающее правило домена", async () => {
      await expect(
        build().useCase.update({ restaurantId: "r-1", avgCookingTimeMin: 0 }),
      ).rejects.toThrow(DomainRuleError);
    });
  });
});
