import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ConflictError,
  DomainRuleError,
  NotFoundError,
  createEvent,
  getCorrelationId,
} from "@food-delivery/shared";
import { CATALOG_EVENT_TYPES } from "@food-delivery/contracts";
import type { DomainEvent } from "@food-delivery/shared";
import type { MenuUpdatedPayload } from "@food-delivery/contracts";
import { MenuItem, MenuItemError } from "../../domain/menu-item";
import { MENU_CACHE, type MenuCache } from "../ports/menu-cache";
import { MENU_REPOSITORY, type MenuRepository } from "../ports/menu.repository";
import { RESTAURANT_REPOSITORY, type RestaurantRepository } from "../ports/restaurant.repository";

/**
 * Управление меню — требование CAT-5.
 *
 * Правила блюда проверяет домен; здесь проверяется то, что домену
 * недоступно: существует ли ресторан, принадлежит ли ему категория,
 * не пытается ли менеджер править чужое блюдо.
 */

export interface CreateMenuItemInput {
  restaurantId: string;
  categoryId: string;
  name: string;
  price: number;
  description?: string | null;
  composition?: string | null;
  imageUrl?: string | null;
  weightGrams?: number | null;
  calories?: number | null;
  sortOrder?: number;
}

export interface UpdateMenuItemInput {
  itemId: string;
  restaurantId: string;
  name?: string;
  price?: number;
  description?: string | null;
  composition?: string | null;
  imageUrl?: string | null;
  weightGrams?: number | null;
  calories?: number | null;
  sortOrder?: number;
  categoryId?: string;
}

@Injectable()
export class ManageMenuItemUseCase {
  constructor(
    @Inject(MENU_REPOSITORY) private readonly menu: MenuRepository,
    @Inject(RESTAURANT_REPOSITORY) private readonly restaurants: RestaurantRepository,
    @Inject(MENU_CACHE) private readonly cache: MenuCache,
  ) {}

  async create(input: CreateMenuItemInput): Promise<MenuItem> {
    await this.ensureRestaurantExists(input.restaurantId);
    await this.ensureCategoryBelongsToRestaurant(input.categoryId, input.restaurantId);

    const item = this.buildItem(() =>
      MenuItem.create({
        id: randomUUID(),
        restaurantId: input.restaurantId,
        categoryId: input.categoryId,
        name: input.name,
        description: input.description ?? null,
        composition: input.composition ?? null,
        imageUrl: input.imageUrl ?? null,
        price: input.price,
        weightGrams: input.weightGrams ?? null,
        calories: input.calories ?? null,
        isAvailable: true,
        sortOrder: input.sortOrder ?? 0,
      }),
    );

    await this.menu.saveItem(item, [this.menuUpdated(item, "created")]);
    await this.cache.invalidate(item.restaurantId);
    return item;
  }

  async update(input: UpdateMenuItemInput): Promise<MenuItem> {
    const existing = await this.menu.findItemById(input.itemId);
    if (!existing) {
      throw new NotFoundError("блюдо не найдено", { itemId: input.itemId });
    }

    // Менеджер одного ресторана не должен править меню другого.
    // Полноценная проверка прав появится вместе с ролями (шаг 1.4),
    // но принадлежность блюда ресторану — правило предметной области,
    // и проверять его нужно независимо от способа входа.
    if (existing.restaurantId !== input.restaurantId) {
      throw new ConflictError("блюдо принадлежит другому ресторану", {
        itemId: input.itemId,
      });
    }

    if (input.categoryId && input.categoryId !== existing.categoryId) {
      await this.ensureCategoryBelongsToRestaurant(input.categoryId, input.restaurantId);
    }

    const current = existing.toProps();
    const updated = this.buildItem(() =>
      MenuItem.create({
        ...current,
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.composition !== undefined ? { composition: input.composition } : {}),
        ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
        ...(input.weightGrams !== undefined ? { weightGrams: input.weightGrams } : {}),
        ...(input.calories !== undefined ? { calories: input.calories } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      }),
    );

    await this.menu.saveItem(updated, [this.menuUpdated(updated, "updated")]);
    await this.cache.invalidate(updated.restaurantId);
    return updated;
  }

  async remove(itemId: string, restaurantId: string): Promise<void> {
    const existing = await this.menu.findItemById(itemId);
    if (!existing) {
      throw new NotFoundError("блюдо не найдено", { itemId });
    }
    if (existing.restaurantId !== restaurantId) {
      throw new ConflictError("блюдо принадлежит другому ресторану", { itemId });
    }

    const archived = existing.archive();
    await this.menu.saveItem(archived, [this.menuUpdated(archived, "deleted")]);
    await this.cache.invalidate(restaurantId);
  }

  /**
   * Изменение меню касается не только каталога: шлюз держит кэш выдачи,
   * и без события клиент продолжит видеть старую цену. Событие пишется
   * той же транзакцией, что и само блюдо (REL-3).
   */
  private menuUpdated(item: MenuItem, change: MenuUpdatedPayload["change"]): DomainEvent {
    const payload: MenuUpdatedPayload = {
      restaurantId: item.restaurantId,
      menuItemId: item.id,
      name: item.name,
      change,
    };

    return createEvent({
      eventType: CATALOG_EVENT_TYPES.menuUpdated,
      aggregateType: "MenuItem",
      aggregateId: item.id,
      correlationId: getCorrelationId(),
      payload,
    });
  }

  private async ensureRestaurantExists(restaurantId: string): Promise<void> {
    if (!(await this.restaurants.findById(restaurantId))) {
      throw new NotFoundError("ресторан не найден", { restaurantId });
    }
  }

  private async ensureCategoryBelongsToRestaurant(
    categoryId: string,
    restaurantId: string,
  ): Promise<void> {
    if (!(await this.menu.categoryExists(categoryId, restaurantId))) {
      throw new NotFoundError("категория не найдена у этого ресторана", {
        categoryId,
        restaurantId,
      });
    }
  }

  /**
   * Нарушение правила предметной области — не внутренняя ошибка, а сообщение
   * пользователю. Переводим исключение домена в ошибку приложения, которую
   * шлюз превратит в понятный ответ с кодом 422.
   */
  private buildItem(build: () => MenuItem): MenuItem {
    try {
      return build();
    } catch (error) {
      if (error instanceof MenuItemError || error instanceof Error) {
        throw new DomainRuleError(error.message);
      }
      throw error;
    }
  }
}
