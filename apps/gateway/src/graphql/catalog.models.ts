import { Field, Float, ID, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import { SelectionType } from "../catalog/catalog.views";

/**
 * Типы схемы GraphQL.
 *
 * Схема описана классами, а сам текст схемы (SDL) создаётся из них при
 * сборке. Так описание контракта не может разойтись с кодом: рассогласование
 * становится ошибкой компиляции, а не обнаруживается клиентом в работе
 * (требование MNT-3 — описания генерируются автоматически).
 *
 * Деньги всюду целые копейки, как и во всей системе: дробный тип для денег
 * недопустим, а Int вмещает суммы до двадцати миллионов рублей.
 */

export { SelectionType };

registerEnumType(SelectionType, {
  name: "SelectionType",
  description: "single — выбрать ровно один вариант, multiple — несколько",
});

@ObjectType({ description: "Ресторан в списке" })
export class Restaurant {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => Int, { description: "Минимальная сумма заказа, копейки" })
  minOrderAmount!: number;

  @Field(() => Int, { description: "Стоимость доставки, копейки" })
  deliveryFee!: number;

  @Field(() => Int, { description: "Среднее время приготовления, минуты" })
  avgCookingTimeMin!: number;
}

@ObjectType({ description: "Зона доставки, в которую попал адрес клиента" })
export class DeliveryZoneRef {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;
}

@ObjectType({ description: "Ресторан, доставляющий по указанному адресу (CAT-1)" })
export class RestaurantOffer extends Restaurant {
  @Field(() => DeliveryZoneRef)
  zone!: DeliveryZoneRef;
}

@ObjectType({ description: "Вариант модификатора: размер, добавка" })
export class ItemOption {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => Int, { description: "Надбавка к цене блюда, копейки; может быть отрицательной" })
  priceDelta!: number;

  @Field()
  isAvailable!: boolean;
}

@ObjectType({ description: "Группа модификаторов блюда (CAT-3)" })
export class OptionGroup {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => SelectionType)
  selectionType!: SelectionType;

  @Field()
  isRequired!: boolean;

  @Field(() => Int)
  minSelect!: number;

  @Field(() => Int)
  maxSelect!: number;

  @Field(() => [ItemOption])
  options!: ItemOption[];
}

@ObjectType({ description: "Блюдо меню" })
export class MenuItem {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  categoryId!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  composition!: string | null;

  @Field(() => String, { nullable: true })
  imageUrl!: string | null;

  @Field(() => Int, { description: "Цена без модификаторов, копейки" })
  price!: number;

  @Field(() => Int, { nullable: true })
  weightGrams!: number | null;

  @Field(() => Int, { nullable: true })
  calories!: number | null;

  @Field({ description: "Ложь означает стоп-лист (CAT-4)" })
  isAvailable!: boolean;

  @Field(() => [OptionGroup])
  optionGroups!: OptionGroup[];
}

@ObjectType({ description: "Раздел меню: категория и её блюда" })
export class MenuSection {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => [MenuItem])
  items!: MenuItem[];
}

@ObjectType({ description: "Меню ресторана, сгруппированное по категориям (CAT-2)" })
export class Menu {
  @Field(() => ID)
  restaurantId!: string;

  @Field(() => [MenuSection])
  categories!: MenuSection[];
}

@ObjectType({ description: "Страница списка ресторанов" })
export class RestaurantPage {
  @Field(() => [Restaurant])
  items!: Restaurant[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  pageSize!: number;
}

@ObjectType({ description: "Запись журнала стоп-листа" })
export class StopListEntry {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  menuItemId!: string;

  @Field(() => String, { nullable: true })
  reason!: string | null;

  @Field({ description: "Когда блюдо убрали из продажи" })
  stoppedAt!: string;

  @Field(() => String, { nullable: true })
  restoredAt!: string | null;

  @Field({ description: "Истина — блюдо всё ещё в стоп-листе" })
  isActive!: boolean;

  @Field(() => Int, { description: "Сколько минут блюдо отсутствовало в продаже" })
  outageMinutes!: number;
}

@ObjectType({ description: "Результат перевода блюда в стоп-лист или обратно" })
export class AvailabilityResult {
  @Field(() => ID)
  itemId!: string;

  @Field()
  isAvailable!: boolean;

  @Field({ description: "Ложь означает, что блюдо уже было в этом состоянии" })
  changed!: boolean;
}

@ObjectType({ description: "Кто вошёл в систему" })
export class CurrentUserView {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  email?: string;

  @Field(() => String, { nullable: true })
  name?: string;

  @Field(() => [String], {
    description: "Роли: client, manager, kitchen, courier, operator, admin",
  })
  roles!: string[];

  @Field(() => String, { nullable: true, description: "Ресторан сотрудника" })
  restaurantId?: string;
}

/** Точка на карте в аргументах запроса. Порядок задан именами полей. */
@ObjectType()
export class Point {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;
}
