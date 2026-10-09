import type { DomainEvent } from "@food-delivery/shared";
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

  /**
   * Сохраняет блюдо и, если они переданы, исходящие события — одной
   * транзакцией. События нужны потребителям кэша: без них шлюз продолжит
   * отдавать старую цену. Отдельный вызов «сохранить событие» здесь
   * не годится — между ним и сохранением блюда возможен сбой (REL-3).
   */
  saveItem(item: MenuItem, events?: DomainEvent[]): Promise<void>;

  saveCategory(category: MenuCategory): Promise<void>;

  categoryExists(categoryId: string, restaurantId: string): Promise<boolean>;
}

export const MENU_REPOSITORY = Symbol("MenuRepository");
