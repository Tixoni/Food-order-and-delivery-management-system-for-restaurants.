import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConflictError, DomainRuleError, NotFoundError } from "@food-delivery/shared";
import { MenuItem, MenuItemError } from "../../domain/menu-item";
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
        price: input.price,
        weightGrams: input.weightGrams ?? null,
        calories: input.calories ?? null,
        isAvailable: true,
        sortOrder: input.sortOrder ?? 0,
      }),
    );

    await this.menu.saveItem(item);
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
        ...(input.weightGrams !== undefined ? { weightGrams: input.weightGrams } : {}),
        ...(input.calories !== undefined ? { calories: input.calories } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      }),
    );

    await this.menu.saveItem(updated);
    return updated;
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
