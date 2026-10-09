import { MenuCategory } from "../../domain/menu-category";
import { MenuItem } from "../../domain/menu-item";
import { ItemOption, OptionGroup } from "../../domain/option-group";
import type {
  ItemOptionGroupOrmEntity,
  ItemOptionOrmEntity,
  MenuCategoryOrmEntity,
  MenuItemOrmEntity,
} from "./menu.orm-entities";

/**
 * Единственное место, где представление в базе встречается с доменом.
 * Благодаря ему переименование колонки не приводит к правкам в доменном слое.
 */
export class MenuMapper {
  static categoryToDomain(row: MenuCategoryOrmEntity): MenuCategory {
    return MenuCategory.create({
      id: row.id,
      restaurantId: row.restaurantId,
      name: row.name,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
    });
  }

  static categoryToPersistence(category: MenuCategory): Partial<MenuCategoryOrmEntity> {
    return {
      id: category.id,
      restaurantId: category.restaurantId,
      name: category.name,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    };
  }

  static optionToDomain(row: ItemOptionOrmEntity): ItemOption {
    return ItemOption.create({
      id: row.id,
      name: row.name,
      priceDelta: row.priceDelta,
      isAvailable: row.isAvailable,
    });
  }

  static groupToDomain(row: ItemOptionGroupOrmEntity): OptionGroup {
    const options = [...(row.options ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(MenuMapper.optionToDomain);

    return OptionGroup.create({
      id: row.id,
      name: row.name,
      selectionType: row.selectionType,
      isRequired: row.isRequired,
      minSelect: row.minSelect,
      maxSelect: row.maxSelect,
      options,
    });
  }

  static itemToDomain(row: MenuItemOrmEntity): MenuItem {
    const groups = [...(row.optionGroups ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      // Группа без вариантов бессмысленна и отвергается доменом; в базе
      // такое возможно, если варианты удалили. Пропускаем, а не падаем:
      // из-за одной испорченной группы не должно перестать открываться меню.
      .filter((group) => (group.options ?? []).length > 0)
      .map(MenuMapper.groupToDomain);

    return MenuItem.create({
      id: row.id,
      restaurantId: row.restaurantId,
      categoryId: row.categoryId,
      name: row.name,
      description: row.description,
      composition: row.composition,
      imageUrl: row.imageUrl,
      price: row.price,
      weightGrams: row.weightGrams,
      calories: row.calories,
      isAvailable: row.isAvailable,
      isDeleted: row.isDeleted,
      sortOrder: row.sortOrder,
      optionGroups: groups,
    });
  }

  static itemToPersistence(item: MenuItem): Partial<MenuItemOrmEntity> {
    return {
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
      updatedAt: new Date(),
    };
  }
}
