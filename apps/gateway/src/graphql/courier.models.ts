import { Field, Float, ID, Int, ObjectType } from "@nestjs/graphql";
import { Restaurant } from "./catalog.models";

/** Типы схемы для приложения курьера, отслеживания и событий реального времени. */

@ObjectType({ description: "Точка на карте" })
export class GeoPoint {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;
}

@ObjectType({ description: "Позиция курьера с временем получения" })
export class CourierLocation extends GeoPoint {
  @Field()
  at!: string;
}

@ObjectType({ description: "Курьер" })
export class CourierProfile {
  @Field(() => ID)
  id!: string;

  @Field()
  fullName!: string;

  @Field({ description: "foot, bike, car" })
  vehicleType!: string;

  @Field({
    description:
      "offline — не на смене, available — свободен, assigned — предложен заказ, busy — везёт",
  })
  status!: string;
}

@ObjectType({ description: "Маршрут от ресторана до клиента по дорогам (DLV-6)" })
export class DeliveryRoute {
  @Field(() => Int, { description: "Длина пути по дорогам, метры" })
  distanceMeters!: number;

  @Field(() => [GeoPoint], { description: "Упрощённая линия для карты" })
  path!: GeoPoint[];
}

@ObjectType({ description: "Доставка глазами курьера: откуда, куда, кому" })
export class DeliveryTask {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  orderId!: string;

  @Field(() => Int, { nullable: true })
  orderNumber?: number | null;

  @Field(() => ID, { nullable: true })
  restaurantId?: string | null;

  @Field(() => Restaurant, {
    nullable: true,
    description: "Ресторан — из каталога: шлюз склеивает ответы сервисов",
  })
  restaurant?: Restaurant | null;

  @Field(() => String, { nullable: true })
  dropoffAddress?: string | null;

  @Field(() => String, {
    nullable: true,
    description: "Телефон клиента — только после того, как курьер принял заказ",
  })
  contactPhone?: string | null;

  @Field({ description: "PENDING, ASSIGNED, PICKED_UP, DELIVERED, CANCELLED" })
  status!: string;

  @Field(() => GeoPoint)
  pickup!: GeoPoint;

  @Field(() => GeoPoint)
  dropoff!: GeoPoint;

  @Field(() => String, { nullable: true, description: "Когда заказ будет готов" })
  readyAt?: string | null;

  @Field(() => String, { nullable: true })
  pickedUpAt?: string | null;

  @Field(() => DeliveryRoute, {
    nullable: true,
    description: "Нет — маршрутизатор недоступен: карта рисует прямую",
  })
  route?: DeliveryRoute | null;
}

@ObjectType({ description: "Предложение заказа курьеру (DLV-4)" })
export class CourierOffer {
  @Field(() => ID)
  id!: string;

  @Field(() => Int, { description: "Номер попытки: 2 — заказ уже предлагали другому" })
  sequence!: number;

  @Field({ description: "До какого времени нужно ответить" })
  expiresAt!: string;

  @Field(() => DeliveryTask)
  delivery!: DeliveryTask;
}

@ObjectType({ description: "Экран курьера: он сам, предложение и текущая доставка" })
export class CourierDashboard {
  @Field(() => CourierProfile)
  courier!: CourierProfile;

  @Field(() => CourierLocation, { nullable: true })
  position?: CourierLocation | null;

  @Field(() => CourierOffer, { nullable: true })
  offer?: CourierOffer | null;

  @Field(() => DeliveryTask, { nullable: true })
  delivery?: DeliveryTask | null;
}

@ObjectType({ description: "Где курьер заказа (TRK-2)" })
export class OrderCourierPosition {
  @Field(() => ID)
  orderId!: string;

  @Field({ description: "Статус доставки" })
  status!: string;

  @Field(() => CourierLocation, {
    nullable: true,
    description: "Нет — курьер ещё не назначен или его позиция устарела",
  })
  position?: CourierLocation | null;

  @Field(() => GeoPoint)
  pickup!: GeoPoint;

  @Field(() => GeoPoint)
  dropoff!: GeoPoint;

  @Field(() => DeliveryRoute, {
    nullable: true,
    description: "Нет — маршрутизатор недоступен: карта рисует прямую",
  })
  route?: DeliveryRoute | null;
}

@ObjectType({ description: "Статус заказа изменился (NTF-1)" })
export class OrderUpdate {
  @Field(() => ID)
  orderId!: string;

  @Field(() => ID)
  restaurantId!: string;

  @Field()
  status!: string;

  @Field(() => String, { nullable: true })
  previousStatus?: string | null;

  @Field()
  at!: string;
}

@ObjectType({ description: "Новая позиция курьера заказа" })
export class CourierPositionUpdate {
  @Field(() => ID)
  orderId!: string;

  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;

  @Field()
  at!: string;
}

@ObjectType({ description: "Курьеру что-то предложили или доставка изменилась — перечитать экран" })
export class CourierSignal {
  @Field()
  kind!: string;

  @Field(() => ID)
  orderId!: string;

  @Field()
  at!: string;
}
