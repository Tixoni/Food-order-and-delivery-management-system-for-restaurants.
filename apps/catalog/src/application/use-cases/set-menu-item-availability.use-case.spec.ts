import { ConflictError, NotFoundError, runWithContext } from "@food-delivery/shared";
import { SetMenuItemAvailabilityUseCase } from "./set-menu-item-availability.use-case";
import {
  InMemoryMenuCache,
  InMemoryMenuRepository,
  InMemoryStopListRepository,
  category,
  item,
} from "./in-memory.doubles";

/**
 * Требование CAT-4. Проверяется три вещи, и все три — без базы и брокера:
 * блюдо перестаёт быть доступным, изменение попадает в журнал,
 * событие уходит потребителям кэша.
 */
const build = () => {
  const menu = new InMemoryMenuRepository(
    [category("c-1", "Пицца")],
    [
      item("i-1", "c-1", "Маргарита"),
      item("i-2", "c-1", "Пепперони", { isAvailable: false }),
      item("i-9", "c-1", "Чужая", { restaurantId: "r-2" }),
    ],
  );
  const stopList = new InMemoryStopListRepository(menu);
  const cache = new InMemoryMenuCache();

  return {
    menu,
    stopList,
    cache,
    useCase: new SetMenuItemAvailabilityUseCase(menu, stopList, cache),
  };
};

describe("сценарий «стоп-лист»", () => {
  describe("перевод в стоп-лист", () => {
    it("блюдо перестаёт быть доступным", async () => {
      const { menu, useCase } = build();

      const result = await useCase.execute({
        itemId: "i-1",
        restaurantId: "r-1",
        isAvailable: false,
        reason: "закончился сыр",
      });

      expect(result.changed).toBe(true);
      expect(result.item.isAvailable).toBe(false);
      expect((await menu.findItemById("i-1"))?.isAvailable).toBe(false);
    });

    it("причина и автор попадают в журнал", async () => {
      const { stopList, useCase } = build();

      await useCase.execute({
        itemId: "i-1",
        restaurantId: "r-1",
        isAvailable: false,
        reason: "закончился сыр",
        actorId: "u-7",
      });

      const entry = await stopList.findActiveEntry("i-1");
      expect(entry?.reason).toBe("закончился сыр");
      expect(entry?.stoppedBy).toBe("u-7");
      expect(entry?.isActive).toBe(true);
    });

    it("событие уходит потребителям кэша", async () => {
      const { stopList, useCase } = build();

      await useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: false });

      expect(stopList.published).toHaveLength(1);
      const [event] = stopList.published;
      expect(event.eventType).toBe("MenuItemStopped");
      expect(event.aggregateId).toBe("i-1");
      // Ресторан в полезной нагрузке — ключ партиции и адрес сбрасываемого кэша
      expect(event.payload).toMatchObject({ restaurantId: "r-1", menuItemId: "i-1" });
    });

    it("кэш сбрасывается, иначе блюдо осталось бы в выдаче", async () => {
      const { cache, useCase } = build();

      await useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: false });

      expect(cache.invalidations).toBe(1);
    });

    it("признак, журнал и событие сохраняются одной транзакцией", async () => {
      const { stopList, useCase } = build();

      await useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: false });

      expect(stopList.commits).toBe(1);
    });

    it("сквозной идентификатор запроса переходит в событие", async () => {
      const { stopList, useCase } = build();

      await runWithContext({ correlationId: "corr-42" }, () =>
        useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: false }),
      );

      expect(stopList.published[0].correlationId).toBe("corr-42");
    });
  });

  describe("возврат в продажу", () => {
    it("блюдо снова доступно, а запись журнала закрывается", async () => {
      const { stopList, useCase } = build();

      await useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: false });
      const result = await useCase.execute({
        itemId: "i-1",
        restaurantId: "r-1",
        isAvailable: true,
      });

      expect(result.item.isAvailable).toBe(true);
      expect(result.entry.isActive).toBe(false);
      expect(await stopList.findActiveEntry("i-1")).toBeNull();
    });

    it("сообщает о возврате событием и длительностью простоя", async () => {
      const { stopList, useCase } = build();

      await useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: false });
      await useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: true });

      const [, restored] = stopList.published;
      expect(restored.eventType).toBe("MenuItemRestored");
      expect(restored.payload).toMatchObject({ menuItemId: "i-1", outageMinutes: 0 });
    });

    it("возвращает блюдо и тогда, когда записи о переводе не сохранилось", async () => {
      const { useCase } = build();

      const result = await useCase.execute({
        itemId: "i-2",
        restaurantId: "r-1",
        isAvailable: true,
      });

      expect(result.changed).toBe(true);
      expect(result.item.isAvailable).toBe(true);
      expect(result.entry.isActive).toBe(false);
    });
  });

  describe("защита от лишних действий", () => {
    it("повторное нажатие ничего не меняет и не рассылает событий", async () => {
      const { stopList, cache, useCase } = build();

      await useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: false });
      const repeat = await useCase.execute({
        itemId: "i-1",
        restaurantId: "r-1",
        isAvailable: false,
      });

      expect(repeat.changed).toBe(false);
      expect(stopList.published).toHaveLength(1);
      expect(cache.invalidations).toBe(1);
    });

    it("сообщает, что блюдо не найдено", async () => {
      await expect(
        build().useCase.execute({ itemId: "i-404", restaurantId: "r-1", isAvailable: false }),
      ).rejects.toThrow(NotFoundError);
    });

    it("не даёт убрать блюдо чужого ресторана", async () => {
      await expect(
        build().useCase.execute({ itemId: "i-9", restaurantId: "r-1", isAvailable: false }),
      ).rejects.toThrow(ConflictError);
    });

    it("отклонённое действие не порождает ни записи, ни события", async () => {
      const { stopList, cache, useCase } = build();

      await expect(
        useCase.execute({ itemId: "i-9", restaurantId: "r-1", isAvailable: false }),
      ).rejects.toThrow(ConflictError);

      expect(stopList.commits).toBe(0);
      expect(stopList.published).toHaveLength(0);
      expect(cache.invalidations).toBe(0);
    });
  });

  describe("история стоп-листа", () => {
    it("отдаёт записи ресторана, свежие первыми", async () => {
      const { stopList, useCase } = build();

      await useCase.execute({ itemId: "i-1", restaurantId: "r-1", isAvailable: false });
      await useCase.execute({ itemId: "i-2", restaurantId: "r-1", isAvailable: true });

      const history = await stopList.findHistory("r-1", 10);
      expect(history).toHaveLength(2);
      expect(history[0].stoppedAt.getTime()).toBeGreaterThanOrEqual(history[1].stoppedAt.getTime());
    });
  });
});
