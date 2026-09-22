import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * Представление меню для базы данных.
 *
 * Отдельные классы от доменных — как и у ресторана. Здесь названия колонок
 * и типы SQL; в домене — правила предметной области. Связывает их
 * преобразователь.
 *
 * Связи между таблицами средствами ORM намеренно не описаны. Причины две:
 * во-первых, взаимные ссылки классов приводят к обращению к классу
 * до его определения; во-вторых, автоматическая подгрузка связей даёт
 * отдельный запрос на каждое блюдо — меню из 30 блюд обошлось бы
 * в 61 обращение к базе. Модификаторы подгружаются двумя запросами
 * на весь список, см. хранилище.
 */

@Entity("menu_categories")
export class MenuCategoryOrmEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Index("ix_menu_categories_restaurant")
  @Column("uuid", { name: "restaurant_id" })
  restaurantId!: string;

  @Column("varchar", { length: 200 })
  name!: string;

  @Column("integer", { name: "sort_order", default: 0 })
  sortOrder!: number;

  @Column("boolean", { name: "is_active", default: true })
  isActive!: boolean;
}

@Entity("item_options")
export class ItemOptionOrmEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column("uuid", { name: "group_id" })
  groupId!: string;

  @Column("varchar", { length: 200 })
  name!: string;

  /** Надбавка к цене блюда в копейках; может быть отрицательной. */
  @Column("integer", { name: "price_delta", default: 0 })
  priceDelta!: number;

  @Column("boolean", { name: "is_available", default: true })
  isAvailable!: boolean;

  @Column("integer", { name: "sort_order", default: 0 })
  sortOrder!: number;
}

@Entity("item_option_groups")
export class ItemOptionGroupOrmEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column("uuid", { name: "menu_item_id" })
  menuItemId!: string;

  @Column("varchar", { length: 200 })
  name!: string;

  @Column("varchar", { name: "selection_type", length: 16, default: "single" })
  selectionType!: "single" | "multiple";

  @Column("boolean", { name: "is_required", default: false })
  isRequired!: boolean;

  @Column("integer", { name: "min_select", default: 0 })
  minSelect!: number;

  @Column("integer", { name: "max_select", default: 1 })
  maxSelect!: number;

  @Column("integer", { name: "sort_order", default: 0 })
  sortOrder!: number;

  /** Заполняется хранилищем отдельным запросом, колонкой в базе не является. */
  options?: ItemOptionOrmEntity[];
}

@Entity("menu_items")
export class MenuItemOrmEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Index("ix_menu_items_restaurant")
  @Column("uuid", { name: "restaurant_id" })
  restaurantId!: string;

  @Column("uuid", { name: "category_id" })
  categoryId!: string;

  @Column("varchar", { length: 200 })
  name!: string;

  @Column("varchar", { length: 1000, nullable: true })
  description!: string | null;

  @Column("varchar", { length: 1000, nullable: true })
  composition!: string | null;

  /** Цена в копейках. Дробный тип для денег недопустим. */
  @Column("integer")
  price!: number;

  @Column("varchar", { name: "image_url", length: 500, nullable: true })
  imageUrl!: string | null;

  @Column("integer", { name: "weight_grams", nullable: true })
  weightGrams!: number | null;

  @Column("integer", { nullable: true })
  calories!: number | null;

  /** Ложь означает стоп-лист. */
  @Column("boolean", { name: "is_available", default: true })
  isAvailable!: boolean;

  @Column("integer", { name: "sort_order", default: 0 })
  sortOrder!: number;

  @Column("timestamptz", { name: "created_at", default: () => "now()" })
  createdAt!: Date;

  @Column("timestamptz", { name: "updated_at", default: () => "now()" })
  updatedAt!: Date;

  /** Заполняется хранилищем отдельным запросом, колонкой в базе не является. */
  optionGroups?: ItemOptionGroupOrmEntity[];
}
