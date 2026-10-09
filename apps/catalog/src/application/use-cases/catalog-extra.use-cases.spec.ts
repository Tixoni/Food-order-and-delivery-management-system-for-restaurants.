import { DomainRuleError, NotFoundError, ValidationError } from "@food-delivery/shared";
import type { RestaurantScheduleRepository } from "../ports/restaurant-schedule.repository";
import { InMemoryRestaurantRepository, restaurant } from "./in-memory.doubles";
import { ManageRestaurantScheduleUseCase } from "./manage-restaurant-schedule.use-case";
import { SearchMenuUseCase } from "./search-menu.use-case";

describe("расписание и поиск", () => {
  it("менеджер сохраняет расписание; открытость рассчитывается по времени ресторана", async () => {
    let intervals = [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "18:00" }];
    const store: RestaurantScheduleRepository = {
      findByRestaurant: async () => intervals,
      replace: async (_id, value) => {
        intervals = [...value];
      },
    };
    const useCase = new ManageRestaurantScheduleUseCase(
      new InMemoryRestaurantRepository([restaurant()]),
      store,
    );
    expect((await useCase.orderability("r-1", new Date("2026-09-21T07:00:00Z"))).isOpen).toBe(true);
    await useCase.replace("r-1", [{ dayOfWeek: 1, opensAt: "11:00", closesAt: "18:00" }]);
    expect((await useCase.orderability("r-1", new Date("2026-09-21T07:00:00Z"))).isOpen).toBe(
      false,
    );
    await expect(
      useCase.replace("r-1", [{ dayOfWeek: 1, opensAt: "12", closesAt: "18:00" }]),
    ).rejects.toThrow(DomainRuleError);
    await expect(useCase.get("missing")).rejects.toThrow(NotFoundError);
  });

  it("поиск проверяет параметры до передачи в хранилище", async () => {
    const search = jest.fn().mockResolvedValue([]);
    const useCase = new SearchMenuUseCase({ search });
    await useCase.execute({ query: "  борщ  ", limit: 5 });
    expect(search).toHaveBeenCalledWith("борщ", undefined, 5);
    await expect(useCase.execute({ query: "а" })).rejects.toThrow(ValidationError);
    await expect(useCase.execute({ query: "борщ", limit: 0 })).rejects.toThrow(ValidationError);
    await expect(useCase.execute({ query: "борщ", restaurantId: "bad" })).rejects.toThrow(
      ValidationError,
    );
    expect(search).toHaveBeenCalledTimes(1);
  });
});
