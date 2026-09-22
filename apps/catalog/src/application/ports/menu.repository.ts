import type { MenuCategory } from "../../domain/menu-category";
import type { MenuItem } from "../../domain/menu-item";

/**
 * Что сервису нужно от хранилища меню — без единого слова о том,
 * какое это хранилище. Реализация живёт в infrastructure и подставляется
 * при запуске; в тестах вместо неё подставляется хранилище в памяти.
 */
export interface MenuRepository {
  /** Категории ресторана, включая отключённые: менеджеру нужны все. */
  findCategories(restaurantId: string): Promise<MenuCategory[]>;

  /**
   * Блюда ресторана вместе с модификаторами.
   * Клиенту отдаются только доступные, менеджеру — все.
   */
  findItems(restaurantId: string, options?: { includeUnavailable?: boolean }): Promise<MenuItem[]>;

  findItemById(itemId: string): Promise<MenuItem | null>;

  saveItem(item: MenuItem): Promise<void>;

  saveCategory(category: MenuCategory): Promise<void>;

  categoryExists(categoryId: string, restaurantId: string): Promise<boolean>;
}

export const MENU_REPOSITORY = Symbol("MenuRepository");
