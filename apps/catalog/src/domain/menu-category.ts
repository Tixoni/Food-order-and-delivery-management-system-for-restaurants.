import type { MenuItem } from "./menu-item";

/**
 * Категория меню: «Пицца», «Напитки», «Десерты».
 * Нужна для группировки при показе и для порядка вывода.
 */

export class MenuCategoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MenuCategoryError";
  }
}

export interface MenuCategoryProps {
  id: string;
  restaurantId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export class MenuCategory {
  private constructor(
    readonly id: string,
    readonly restaurantId: string,
    readonly name: string,
    readonly sortOrder: number,
    readonly isActive: boolean,
  ) {}

  static create(props: MenuCategoryProps): MenuCategory {
    const name = props.name.trim();

    if (name.length === 0) {
      throw new MenuCategoryError("название категории не может быть пустым");
    }
    if (name.length > 200) {
      throw new MenuCategoryError("название категории длиннее 200 символов");
    }
    if (!Number.isInteger(props.sortOrder)) {
      throw new MenuCategoryError("порядок вывода должен быть целым числом");
    }

    return new MenuCategory(props.id, props.restaurantId, name, props.sortOrder, props.isActive);
  }
}

/**
 * Меню, собранное для показа: категории по порядку, внутри — блюда.
 *
 * Это не хранимая сущность, а представление для чтения. Требование
 * CAT-2: клиент видит меню сгруппированным.
 */
export interface MenuSection {
  category: MenuCategory;
  items: MenuItem[];
}

export function assembleMenu(categories: MenuCategory[], items: MenuItem[]): MenuSection[] {
  const byCategory = new Map<string, MenuItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.categoryId);
    if (list) {
      list.push(item);
    } else {
      byCategory.set(item.categoryId, [item]);
    }
  }

  return (
    categories
      .filter((category) => category.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"))
      .map((category) => ({
        category,
        items: (byCategory.get(category.id) ?? []).sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ru"),
        ),
      }))
      // Пустые категории клиенту не показываются: раздел без блюд
      // выглядит как неисправность.
      .filter((section) => section.items.length > 0)
  );
}
