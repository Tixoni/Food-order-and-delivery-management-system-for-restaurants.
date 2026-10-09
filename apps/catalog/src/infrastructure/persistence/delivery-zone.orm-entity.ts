import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Зона доставки в базе.
 *
 * Колонка area объявлена как geography(MultiPolygon): тип geography
 * считает расстояния и вхождения на сфере, а не на плоскости, — для
 * города разница невелика, но ошибки на границах областей он снимает.
 *
 * Множественный полигон, а не одиночный, — потому что зона ресторана
 * может состоять из нескольких несвязанных кусков: например, центр
 * и отдельный район за рекой.
 *
 * Запросы вхождения идут через ST_Contains по выражению area::geometry —
 * именно под него построен индекс (см. миграцию 002 и спайк 1).
 */
@Entity("delivery_zones")
export class DeliveryZoneOrmEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index("ix_delivery_zones_restaurant")
  @Column("uuid", { name: "restaurant_id" })
  restaurantId!: string;

  @Column("varchar", { length: 200, default: "Основная зона" })
  name!: string;

  /**
   * Область зоны. Работа с ней идёт запросами с географическими функциями,
   * поэтому в коде она нужна только как непрозрачное значение: разбор
   * контура выполняет преобразователь по отдельному запросу ST_AsGeoJSON.
   */
  @Column({ type: "geography", spatialFeatureType: "MultiPolygon", srid: 4326 })
  area!: unknown;

  /** Деньги — целые копейки. */
  @Column("integer", { name: "delivery_fee", default: 0 })
  deliveryFee!: number;

  @Column("integer", { name: "min_order_amount", default: 0 })
  minOrderAmount!: number;

  @Column("boolean", { name: "is_active", default: true })
  isActive!: boolean;

  @Column("timestamptz", { name: "created_at", default: () => "now()" })
  createdAt!: Date;
}
