import { ConflictError, DomainRuleError } from "@food-delivery/shared";
import type { DomainEvent } from "@food-delivery/shared";
import type { MenuCategory } from "../../domain/menu-category";
import type { OptionGroup } from "../../domain/option-group";
import type { MenuStructureRepository } from "../ports/menu-structure.repository";
import { ManageMenuStructureUseCase } from "./manage-menu-structure.use-case";
import {
  InMemoryMenuCache,
  InMemoryMenuRepository,
  InMemoryRestaurantRepository,
  category,
  item,
  restaurant,
} from "./in-memory.doubles";

class StructureStore implements MenuStructureRepository {
  readonly events: DomainEvent[] = [];
  constructor(private readonly menu: InMemoryMenuRepository) {}
  async findCategoryById(id: string) {
    return this.menu.categories.find((c) => c.id === id) ?? null;
  }
  async saveCategory(value: MenuCategory, events: DomainEvent[]) {
    await this.menu.saveCategory(value);
    this.events.push(...events);
  }
  async replaceGroups(itemId: string, groups: readonly OptionGroup[], events: DomainEvent[]) {
    const previous = await this.menu.findItemById(itemId);
    if (!previous) throw new Error("missing item");
    await this.menu.saveItem(previous.withGroups([...groups]));
    this.events.push(...events);
  }
}

describe("управление структурой меню", () => {
  const build = () => {
    const menu = new InMemoryMenuRepository(
      [category("c-1", "Пицца")],
      [item("i-1", "c-1", "Сырная")],
    );
    const store = new StructureStore(menu);
    const cache = new InMemoryMenuCache();
    const useCase = new ManageMenuStructureUseCase(
      store,
      menu,
      new InMemoryRestaurantRepository([restaurant("r-1"), restaurant("r-2")]),
      cache,
    );
    return { menu, store, cache, useCase };
  };

  it("создаёт и отключает категорию с событием и сбросом кэша", async () => {
    const { useCase, store, cache } = build();
    const created = await useCase.createCategory({ restaurantId: "r-1", name: "Напитки" });
    const disabled = await useCase.deactivateCategory(created.id, "r-1");
    expect(disabled.isActive).toBe(false);
    expect(store.events).toHaveLength(2);
    expect(cache.invalidations).toBe(2);
  });

  it("не позволяет менять категорию другого ресторана", async () => {
    await expect(build().useCase.deactivateCategory("c-1", "r-2")).rejects.toThrow(ConflictError);
  });

  it("заменяет группы и рассчитывает новую цену", async () => {
    const { useCase, menu, store } = build();
    await useCase.replaceGroups("i-1", "r-1", [
      {
        name: "Размер",
        selectionType: "single",
        isRequired: true,
        minSelect: 1,
        maxSelect: 1,
        options: [{ name: "Большой", priceDelta: 5000 }],
      },
    ]);
    const updated = await menu.findItemById("i-1");
    const group = updated!.optionGroups[0];
    expect(
      updated!.calculatePrice([{ groupId: group.id, optionIds: [group.options[0].id] }]).unitPrice,
    ).toBe(44000);
    expect(store.events[0].eventType).toBe("MenuStructureChanged");
  });

  it("отклоняет недопустимую группу до сохранения", async () => {
    const { useCase, store } = build();
    await expect(
      useCase.replaceGroups("i-1", "r-1", [
        {
          name: "",
          selectionType: "single",
          isRequired: false,
          minSelect: 0,
          maxSelect: 1,
          options: [{ name: "Тест", priceDelta: 0 }],
        },
      ]),
    ).rejects.toThrow(DomainRuleError);
    expect(store.events).toHaveLength(0);
  });
});
