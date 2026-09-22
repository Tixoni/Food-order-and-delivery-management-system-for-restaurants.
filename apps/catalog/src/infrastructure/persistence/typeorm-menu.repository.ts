import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import type { MenuCategory } from "../../domain/menu-category";
import type { MenuItem } from "../../domain/menu-item";
import type { MenuRepository } from "../../application/ports/menu.repository";
import {
  ItemOptionGroupOrmEntity,
  ItemOptionOrmEntity,
  MenuCategoryOrmEntity,
  MenuItemOrmEntity,
} from "./menu.orm-entities";
import { MenuMapper } from "./menu.mapper";

/**
 * Реализация порта поверх PostgreSQL. Инфраструктурный слой —
 * единственное место, где сервис знает про SQL и TypeORM.
 */
@Injectable()
export class TypeOrmMenuRepository implements MenuRepository {
  constructor(
    @InjectRepository(MenuCategoryOrmEntity)
    private readonly categories: Repository<MenuCategoryOrmEntity>,
    @InjectRepository(MenuItemOrmEntity)
    private readonly items: Repository<MenuItemOrmEntity>,
    @InjectRepository(ItemOptionGroupOrmEntity)
    private readonly groups: Repository<ItemOptionGroupOrmEntity>,
    @InjectRepository(ItemOptionOrmEntity)
    private readonly options: Repository<ItemOptionOrmEntity>,
  ) {}

  async findCategories(restaurantId: string): Promise<MenuCategory[]> {
    const rows = await this.categories.find({
      where: { restaurantId },
      order: { sortOrder: "ASC", name: "ASC" },
    });
    return rows.map(MenuMapper.categoryToDomain);
  }

  async findItems(
    restaurantId: string,
    options: { includeUnavailable?: boolean } = {},
  ): Promise<MenuItem[]> {
    const rows = await this.items.find({
      where: options.includeUnavailable ? { restaurantId } : { restaurantId, isAvailable: true },
      order: { sortOrder: "ASC", name: "ASC" },
    });

    return this.attachOptionGroups(rows);
  }

  async findItemById(itemId: string): Promise<MenuItem | null> {
    const row = await this.items.findOne({ where: { id: itemId } });
    if (!row) return null;

    const [withGroups] = await this.attachOptionGroups([row]);
    return withGroups ?? null;
  }

  async saveItem(item: MenuItem): Promise<void> {
    // upsert, а не save: save сначала делает выборку, чтобы решить,
    // вставка это или обновление, — лишний запрос на каждое сохранение.
    await this.items.upsert(MenuMapper.itemToPersistence(item) as MenuItemOrmEntity, ["id"]);
  }

  async saveCategory(category: MenuCategory): Promise<void> {
    await this.categories.upsert(
      MenuMapper.categoryToPersistence(category) as MenuCategoryOrmEntity,
      ["id"],
    );
  }

  async categoryExists(categoryId: string, restaurantId: string): Promise<boolean> {
    return this.categories.existsBy({ id: categoryId, restaurantId });
  }

  /**
   * Модификаторы подгружаются двумя запросами на весь список, а не
   * отдельным запросом на каждое блюдо: меню из 30 блюд иначе давало бы
   * 61 обращение к базе вместо трёх.
   */
  private async attachOptionGroups(rows: MenuItemOrmEntity[]): Promise<MenuItem[]> {
    if (rows.length === 0) return [];

    const groupRows = await this.groups.find({
      where: { menuItemId: In(rows.map((row) => row.id)) },
      order: { sortOrder: "ASC" },
    });

    if (groupRows.length > 0) {
      const optionRows = await this.options.find({
        where: { groupId: In(groupRows.map((group) => group.id)) },
        order: { sortOrder: "ASC" },
      });

      const optionsByGroup = new Map<string, ItemOptionOrmEntity[]>();
      for (const option of optionRows) {
        const list = optionsByGroup.get(option.groupId);
        if (list) list.push(option);
        else optionsByGroup.set(option.groupId, [option]);
      }
      for (const group of groupRows) {
        group.options = optionsByGroup.get(group.id) ?? [];
      }
    }

    const groupsByItem = new Map<string, ItemOptionGroupOrmEntity[]>();
    for (const group of groupRows) {
      const list = groupsByItem.get(group.menuItemId);
      if (list) list.push(group);
      else groupsByItem.set(group.menuItemId, [group]);
    }

    return rows.map((row) => {
      row.optionGroups = groupsByItem.get(row.id) ?? [];
      return MenuMapper.itemToDomain(row);
    });
  }
}
