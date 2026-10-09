import type { DomainEvent } from "@food-delivery/shared";
import type { MenuCategory } from "../../domain/menu-category";
import type { OptionGroup } from "../../domain/option-group";

export interface MenuStructureRepository {
  findCategoryById(id: string): Promise<MenuCategory | null>;
  saveCategory(category: MenuCategory, events: DomainEvent[]): Promise<void>;
  replaceGroups(
    itemId: string,
    groups: readonly OptionGroup[],
    events: DomainEvent[],
  ): Promise<void>;
}

export const MENU_STRUCTURE_REPOSITORY = Symbol("MenuStructureRepository");
