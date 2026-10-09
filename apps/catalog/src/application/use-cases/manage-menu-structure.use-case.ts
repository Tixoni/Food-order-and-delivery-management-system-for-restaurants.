import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ConflictError,
  DomainRuleError,
  NotFoundError,
  createEvent,
  getCorrelationId,
} from "@food-delivery/shared";
import { CATALOG_EVENT_TYPES, type MenuStructureChangedPayload } from "@food-delivery/contracts";
import { MenuCategory } from "../../domain/menu-category";
import { ItemOption, OptionGroup, type SelectionType } from "../../domain/option-group";
import type { MenuItem } from "../../domain/menu-item";
import { MENU_CACHE, type MenuCache } from "../ports/menu-cache";
import { MENU_REPOSITORY, type MenuRepository } from "../ports/menu.repository";
import {
  MENU_STRUCTURE_REPOSITORY,
  type MenuStructureRepository,
} from "../ports/menu-structure.repository";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";

export interface CategoryInput {
  restaurantId: string;
  name: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface GroupInput {
  name: string;
  selectionType: SelectionType;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  options: Array<{ name: string; priceDelta: number; isAvailable?: boolean }>;
}

@Injectable()
export class ManageMenuStructureUseCase {
  constructor(
    @Inject(MENU_STRUCTURE_REPOSITORY) private readonly structure: MenuStructureRepository,
    @Inject(MENU_REPOSITORY) private readonly menu: MenuRepository,
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
    @Inject(MENU_CACHE) private readonly cache: MenuCache,
  ) {}

  async listCategories(restaurantId: string): Promise<MenuCategory[]> {
    await this.ensureRestaurant(restaurantId);
    return this.menu.findCategories(restaurantId);
  }

  async createCategory(input: CategoryInput): Promise<MenuCategory> {
    await this.ensureRestaurant(input.restaurantId);
    const category = this.build(() =>
      MenuCategory.create({
        id: randomUUID(),
        restaurantId: input.restaurantId,
        name: input.name,
        sortOrder: input.sortOrder ?? 0,
        isActive: true,
      }),
    );
    await this.structure.saveCategory(category, [
      this.changed(input.restaurantId, "category", category.id),
    ]);
    await this.cache.invalidate(input.restaurantId);
    return category;
  }

  async updateCategory(
    categoryId: string,
    input: Partial<CategoryInput> & { restaurantId: string },
  ): Promise<MenuCategory> {
    const existing = await this.categoryForRestaurant(categoryId, input.restaurantId);
    const category = this.build(() =>
      MenuCategory.create({
        id: existing.id,
        restaurantId: existing.restaurantId,
        name: input.name ?? existing.name,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        isActive: input.isActive ?? existing.isActive,
      }),
    );
    await this.structure.saveCategory(category, [
      this.changed(input.restaurantId, "category", category.id),
    ]);
    await this.cache.invalidate(input.restaurantId);
    return category;
  }

  async deactivateCategory(categoryId: string, restaurantId: string): Promise<MenuCategory> {
    return this.updateCategory(categoryId, { restaurantId, isActive: false });
  }

  async replaceGroups(
    itemId: string,
    restaurantId: string,
    input: GroupInput[],
  ): Promise<MenuItem> {
    const item = await this.menu.findItemById(itemId);
    if (!item) throw new NotFoundError("блюдо не найдено", { itemId });
    if (item.restaurantId !== restaurantId) {
      throw new ConflictError("блюдо принадлежит другому ресторану", { itemId });
    }
    if (!Array.isArray(input))
      throw new DomainRuleError("группы модификаторов должны быть массивом");
    if (input.some((group) => !group || !Array.isArray(group.options))) {
      throw new DomainRuleError("варианты каждой группы должны быть массивом");
    }
    const groups = this.build(() =>
      input.map((group) =>
        OptionGroup.create({
          id: randomUUID(),
          name: group.name,
          selectionType: group.selectionType,
          isRequired: group.isRequired,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
          options: group.options.map((option) =>
            ItemOption.create({
              id: randomUUID(),
              name: option.name,
              priceDelta: option.priceDelta,
              isAvailable: option.isAvailable ?? true,
            }),
          ),
        }),
      ),
    );
    await this.structure.replaceGroups(itemId, groups, [
      this.changed(restaurantId, "modifiers", itemId),
    ]);
    await this.cache.invalidate(restaurantId);
    return item.withGroups(groups);
  }

  private async categoryForRestaurant(
    categoryId: string,
    restaurantId: string,
  ): Promise<MenuCategory> {
    const category = await this.structure.findCategoryById(categoryId);
    if (!category) throw new NotFoundError("категория не найдена", { categoryId });
    if (category.restaurantId !== restaurantId) {
      throw new ConflictError("категория принадлежит другому ресторану", { categoryId });
    }
    return category;
  }

  private async ensureRestaurant(restaurantId: string): Promise<void> {
    if (!(await this.restaurants.findById(restaurantId))) {
      throw new NotFoundError("ресторан не найден", { restaurantId });
    }
  }

  private changed(
    restaurantId: string,
    resource: MenuStructureChangedPayload["resource"],
    resourceId: string,
  ) {
    const payload: MenuStructureChangedPayload = { restaurantId, resource, resourceId };
    return createEvent({
      eventType: CATALOG_EVENT_TYPES.menuStructureChanged,
      aggregateType: "MenuStructure",
      aggregateId: resourceId,
      correlationId: getCorrelationId(),
      payload,
    });
  }

  private build<T>(factory: () => T): T {
    try {
      return factory();
    } catch (error) {
      throw new DomainRuleError(error instanceof Error ? error.message : String(error));
    }
  }
}
