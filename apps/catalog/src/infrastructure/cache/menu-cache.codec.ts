import { MenuCategory, type MenuSection } from "../../domain/menu-category";
import { MenuItem } from "../../domain/menu-item";
import { ItemOption, OptionGroup } from "../../domain/option-group";

/**
 * Перевод меню в строку для кэша и обратно.
 *
 * Доменные объекты нельзя просто разобрать из JSON: у них закрытый
 * конструктор и проверки в фабрике. Поэтому при чтении меню собирается
 * теми же фабриками, что и при чтении из базы, — правила домена
 * действуют независимо от источника данных. Испорченная запись кэша
 * не превратится в блюдо с отрицательной ценой.
 *
 * Формат хранения намеренно отделён от доменных классов: переименование
 * поля в домене не сделает нечитаемыми записи, уже лежащие в кэше, —
 * версия формата позволяет их отбросить.
 */

const FORMAT_VERSION = 2;

interface StoredOption {
  id: string;
  name: string;
  priceDelta: number;
  isAvailable: boolean;
}

interface StoredGroup {
  id: string;
  name: string;
  selectionType: "single" | "multiple";
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  options: StoredOption[];
}

interface StoredItem {
  id: string;
  restaurantId: string;
  categoryId: string;
  name: string;
  description: string | null;
  composition: string | null;
  imageUrl: string | null;
  price: number;
  weightGrams: number | null;
  calories: number | null;
  isAvailable: boolean;
  isDeleted: boolean;
  sortOrder: number;
  optionGroups: StoredGroup[];
}

interface StoredSection {
  category: {
    id: string;
    restaurantId: string;
    name: string;
    sortOrder: number;
    isActive: boolean;
  };
  items: StoredItem[];
}

interface StoredMenu {
  v: number;
  sections: StoredSection[];
}

export class MenuCacheCodec {
  static encode(sections: MenuSection[]): string {
    const stored: StoredMenu = {
      v: FORMAT_VERSION,
      sections: sections.map((section) => ({
        category: {
          id: section.category.id,
          restaurantId: section.category.restaurantId,
          name: section.category.name,
          sortOrder: section.category.sortOrder,
          isActive: section.category.isActive,
        },
        items: section.items.map((item) => ({
          id: item.id,
          restaurantId: item.restaurantId,
          categoryId: item.categoryId,
          name: item.name,
          description: item.description,
          composition: item.composition,
          imageUrl: item.imageUrl,
          price: item.price,
          weightGrams: item.weightGrams,
          calories: item.calories,
          isAvailable: item.isAvailable,
          isDeleted: item.isDeleted,
          sortOrder: item.sortOrder,
          optionGroups: item.optionGroups.map((group) => ({
            id: group.id,
            name: group.name,
            selectionType: group.selectionType,
            isRequired: group.isRequired,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect,
            options: group.options.map((option) => ({
              id: option.id,
              name: option.name,
              priceDelta: option.priceDelta,
              isAvailable: option.isAvailable,
            })),
          })),
        })),
      })),
    };

    return JSON.stringify(stored);
  }

  /**
   * Возвращает null, если запись не читается: записи прошлой версии
   * формата, обрезанная строка, нарушенное правило домена. Для вызывающего
   * это то же самое, что отсутствие записи, — он сходит в базу.
   */
  static decode(raw: string): MenuSection[] | null {
    try {
      const stored = JSON.parse(raw) as StoredMenu;
      if (stored?.v !== FORMAT_VERSION || !Array.isArray(stored.sections)) return null;

      return stored.sections.map((section) => ({
        category: MenuCategory.create(section.category),
        items: section.items.map((item) =>
          MenuItem.create({
            ...item,
            optionGroups: item.optionGroups.map((group) =>
              OptionGroup.create({
                ...group,
                options: group.options.map((option) => ItemOption.create(option)),
              }),
            ),
          }),
        ),
      }));
    } catch {
      return null;
    }
  }
}
