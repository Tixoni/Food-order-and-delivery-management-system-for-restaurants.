import { ValidationError } from "@food-delivery/shared";
import { Restaurant } from "../../domain/restaurant";
import type { RestaurantRepository } from "../ports/restaurant.repository";
import { ListRestaurantsUseCase } from "./list-restaurants.use-case";

/**
 * Заглушка вместо базы данных. Ровно то, ради чего вводился порт:
 * сценарий проверяется без PostgreSQL, контейнеров и сети.
 */
class InMemoryRestaurantRepository implements RestaurantRepository {
  constructor(private readonly items: Restaurant[] = []) {}

  async findActive(limit: number, offset: number): Promise<Restaurant[]> {
    return this.items.filter((r) => r.isActive).slice(offset, offset + limit);
  }

  async findById(id: string): Promise<Restaurant | null> {
    return this.items.find((r) => r.id === id) ?? null;
  }

  async countActive(): Promise<number> {
    return this.items.filter((r) => r.isActive).length;
  }
}

const restaurant = (id: string, isActive = true) =>
  Restaurant.create({
    id,
    name: `Ресторан ${id}`,
    minOrderAmount: 50000,
    deliveryFeeBase: 14900,
    avgCookingTimeMin: 25,
    isActive,
  });

describe("сценарий «список ресторанов»", () => {
  it("возвращает только действующие рестораны", async () => {
    const useCase = new ListRestaurantsUseCase(
      new InMemoryRestaurantRepository([restaurant("a"), restaurant("b", false), restaurant("c")]),
    );

    const result = await useCase.execute();

    expect(result.items.map((r) => r.id)).toEqual(["a", "c"]);
    expect(result.total).toBe(2);
  });

  it("разбивает выдачу на страницы", async () => {
    const useCase = new ListRestaurantsUseCase(
      new InMemoryRestaurantRepository(["a", "b", "c", "d", "e"].map((id) => restaurant(id))),
    );

    const page2 = await useCase.execute({ page: 2, pageSize: 2 });

    expect(page2.items.map((r) => r.id)).toEqual(["c", "d"]);
    expect(page2.total).toBe(5);
    expect(page2.page).toBe(2);
  });

  it("по умолчанию отдаёт первую страницу по 20 записей", async () => {
    const useCase = new ListRestaurantsUseCase(new InMemoryRestaurantRepository([restaurant("a")]));

    const result = await useCase.execute();

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it.each([
    ["нулевая страница", { page: 0 }],
    ["дробная страница", { page: 1.5 }],
    ["нулевой размер страницы", { pageSize: 0 }],
    ["размер страницы больше предела", { pageSize: 51 }],
  ])("отклоняет некорректный запрос: %s", async (_name, query) => {
    const useCase = new ListRestaurantsUseCase(new InMemoryRestaurantRepository());

    await expect(useCase.execute(query)).rejects.toThrow(ValidationError);
  });

  it("на пустом хранилище возвращает пустой список, а не ошибку", async () => {
    const useCase = new ListRestaurantsUseCase(new InMemoryRestaurantRepository());

    const result = await useCase.execute();

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});
