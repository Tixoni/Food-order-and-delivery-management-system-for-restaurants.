import { Field, Float, ID, InputType, Int, ObjectType } from "@nestjs/graphql";
import { Restaurant } from "./catalog.models";

/**
 * Типы схемы для заказов клиента: оформление, история, отслеживание.
 *
 * Статус отдаётся кодом (`AWAITING_RESTAURANT`), а не текстом: подпись
 * на экране — дело клиентского приложения, и у разных приложений она
 * разная (клиенту «ждём ресторан», кухне «новый заказ»).
 */

@ObjectType({ description: "Суммы заказа, копейки" })
export class OrderAmounts {
  @Field(() => Int)
  items!: number;

  @Field(() => Int)
  delivery!: number;

  @Field(() => Int)
  service!: number;

  @Field(() => Int)
  discount!: number;

  @Field(() => Int)
  total!: number;
}

@ObjectType({ description: "Выбранный вариант модификатора — снимок на момент оформления" })
export class OrderLineOption {
  @Field(() => ID)
  optionId!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  priceDelta!: number;
}

@ObjectType({ description: "Позиция заказа: снимок названия и цены на момент оформления" })
export class OrderLine {
  @Field(() => ID)
  menuItemId!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Int)
  unitPrice!: number;

  @Field(() => Int)
  lineTotal!: number;

  @Field(() => [OrderLineOption])
  options!: OrderLineOption[];
}

@ObjectType({ description: "Заказ (ORD-1, ORD-7, TRK-1)" })
export class Order {
  @Field(() => ID)
  id!: string;

  @Field(() => Int, { description: "Номер заказа для людей: его называют по телефону" })
  orderNumber!: number;

  @Field({ description: "Код статуса: CREATED, PENDING_PAYMENT, … DELIVERED, CANCELLED" })
  status!: string;

  @Field(() => ID)
  restaurantId!: string;

  @Field(() => Restaurant, {
    nullable: true,
    description: "Ресторан — из каталога; шлюз склеивает ответы двух сервисов",
  })
  restaurant?: Restaurant | null;

  @Field()
  addressText!: string;

  @Field(() => String, { nullable: true })
  comment?: string | null;

  @Field(() => OrderAmounts)
  amounts!: OrderAmounts;

  @Field(() => [OrderLine])
  lines!: OrderLine[];

  @Field(() => Int, { nullable: true, description: "Время готовки, названное кухней, минуты" })
  expectedCookingMin?: number | null;

  @Field()
  placedAt!: string;

  @Field(() => String, { nullable: true })
  confirmedAt?: string | null;

  @Field(() => String, { nullable: true })
  readyAt?: string | null;

  @Field(() => String, { nullable: true })
  pickedUpAt?: string | null;

  @Field(() => String, { nullable: true })
  deliveredAt?: string | null;

  @Field(() => String, { nullable: true })
  cancelledAt?: string | null;

  @Field(() => String, { nullable: true })
  cancelReason?: string | null;

  @Field(() => String, { nullable: true })
  cancelComment?: string | null;

  @Field({ description: "Может ли клиент отменить заказ сам (ORD-5) — решает сервис заказов" })
  canCancel!: boolean;

  @Field(() => String, {
    nullable: true,
    description: "KIT-5: до какого времени ресторан должен принять заказ — в очереди кухни",
  })
  respondBy?: string | null;
}

@ObjectType({ description: "Переход статуса заказа" })
export class OrderTransition {
  @Field(() => String, { nullable: true })
  from?: string | null;

  @Field()
  to!: string;

  @Field({ description: "Кто перевёл: CUSTOMER, RESTAURANT, COURIER, OPERATOR, SYSTEM" })
  actorType!: string;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field()
  at!: string;
}

@ObjectType({ description: "Результат оформления" })
export class PlaceOrderResult {
  @Field({ description: "Истина — заказ с этим ключом уже был, возвращён прежний (ORD-4)" })
  replayed!: boolean;

  @Field(() => Order)
  order!: Order;
}

@InputType({ description: "Адрес доставки" })
export class OrderAddressInput {
  @Field()
  text!: string;

  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;
}

@InputType({ description: "Выбор в группе модификаторов" })
export class OrderSelectionInput {
  @Field(() => ID)
  groupId!: string;

  @Field(() => [ID])
  optionIds!: string[];
}

@InputType({ description: "Позиция оформляемого заказа. Цену назначает сервер (ORD-2)" })
export class OrderItemInput {
  @Field(() => ID)
  itemId!: string;

  @Field(() => Int)
  quantity!: number;

  @Field(() => [OrderSelectionInput], { nullable: true })
  selections?: OrderSelectionInput[];
}

@InputType({ description: "Оформление заказа (ORD-1)" })
export class PlaceOrderInput {
  @Field(() => ID)
  restaurantId!: string;

  @Field({
    description:
      "Ключ идемпотентности: создаётся один раз на попытку оформления, повтор формы — тот же заказ",
  })
  idempotencyKey!: string;

  @Field(() => OrderAddressInput)
  address!: OrderAddressInput;

  @Field(() => String, { nullable: true })
  contactPhone?: string | null;

  @Field(() => String, { nullable: true })
  comment?: string | null;

  @Field(() => [OrderItemInput])
  items!: OrderItemInput[];
}
