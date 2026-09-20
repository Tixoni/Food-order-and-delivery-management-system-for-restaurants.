import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Представление ресторана для базы данных.
 *
 * Отдельный класс от доменного Restaurant — и это намеренно. Здесь живут
 * названия колонок, типы SQL и индексы; в домене — правила предметной области.
 * Связывает их преобразователь (mapper).
 *
 * Если объединить их в один класс, домен окажется привязан к схеме таблицы:
 * любое изменение структуры хранения начнёт менять бизнес-логику.
 */
@Entity("restaurants")
export class RestaurantOrmEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column("varchar", { length: 200 })
  name!: string;

  @Column("varchar", { length: 1000, nullable: true })
  description!: string | null;

  @Column("varchar", { length: 32, nullable: true })
  phone!: string | null;

  @Column("varchar", { name: "address_text", length: 500, nullable: true })
  addressText!: string | null;

  /** Положение ресторана на карте. Тип geography — проверено в спайке 1. */
  @Index("ix_restaurants_location", { spatial: true })
  @Column({
    type: "geography",
    spatialFeatureType: "Point",
    srid: 4326,
    nullable: true,
  })
  location!: { type: "Point"; coordinates: [number, number] } | null;

  /** Деньги — целые копейки. Дробный тип для денег недопустим. */
  @Column("integer", { name: "min_order_amount", default: 0 })
  minOrderAmount!: number;

  @Column("integer", { name: "delivery_fee_base", default: 0 })
  deliveryFeeBase!: number;

  @Column("integer", { name: "avg_cooking_time_min", default: 30 })
  avgCookingTimeMin!: number;

  @Index("ix_restaurants_active")
  @Column("boolean", { name: "is_active", default: true })
  isActive!: boolean;

  @Column("timestamptz", { name: "created_at", default: () => "now()" })
  createdAt!: Date;

  @Column("timestamptz", { name: "updated_at", default: () => "now()" })
  updatedAt!: Date;
}
