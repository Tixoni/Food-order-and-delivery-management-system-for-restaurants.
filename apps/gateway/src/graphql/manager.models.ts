import { Field, Float, ID, InputType, Int, ObjectType } from "@nestjs/graphql";
import { SelectionType } from "./catalog.models";

/**
 * Типы схемы для панели менеджера и администратора.
 *
 * Вынесены отдельно от клиентских: их читают разные люди, они меняются
 * по разным причинам, и держать их в одном файле — значит заставлять
 * искать нужное среди ненужного.
 */

@ObjectType({ description: "Точка контура зоны доставки" })
export class ZonePoint {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;
}

@InputType({ description: "Точка контура, пришедшая из редактора карты" })
export class ZonePointInput {
  @Field(() => Float)
  latitude!: number;

  @Field(() => Float)
  longitude!: number;
}

@ObjectType({ description: "Зона доставки ресторана (ADM-1)" })
export class DeliveryZone {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  restaurantId!: string;

  @Field()
  name!: string;

  @Field(() => [ZonePoint], { description: "Замкнутый контур области" })
  ring!: ZonePoint[];

  @Field(() => Int, { description: "Стоимость доставки по этой зоне, копейки" })
  deliveryFee!: number;

  @Field(() => Int, { description: "Минимальная сумма заказа по этой зоне, копейки" })
  minOrderAmount!: number;

  @Field()
  isActive!: boolean;
}

@InputType({ description: "Сохранение зоны доставки: без id создаётся новая" })
export class SaveDeliveryZoneInput {
  @Field(() => ID, { nullable: true })
  id?: string;

  @Field(() => ID)
  restaurantId!: string;

  @Field({ nullable: true })
  name?: string;

  @Field(() => [ZonePointInput], { nullable: true })
  ring?: ZonePointInput[];

  @Field(() => Int, { nullable: true })
  deliveryFee?: number;

  @Field(() => Int, { nullable: true })
  minOrderAmount?: number;

  @Field({ nullable: true })
  isActive?: boolean;
}

@InputType({ description: "Сохранение блюда: без id создаётся новое (CAT-5)" })
export class SaveMenuItemInput {
  @Field(() => ID, { nullable: true })
  id?: string;

  @Field(() => ID)
  restaurantId!: string;

  @Field(() => ID, { nullable: true })
  categoryId?: string;

  @Field({ nullable: true })
  name?: string;

  @Field(() => Int, { nullable: true, description: "Цена в копейках" })
  price?: number;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  composition?: string;

  @Field({ nullable: true })
  imageUrl?: string;

  @Field(() => Int, { nullable: true })
  weightGrams?: number;

  @Field(() => Int, { nullable: true })
  calories?: number;
}

@ObjectType({ description: "Полные сведения о ресторане — для администратора" })
export class RestaurantDetails {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  phone!: string | null;

  @Field(() => String, { nullable: true })
  addressText!: string | null;

  @Field(() => ZonePoint, { nullable: true, description: "Где находится ресторан" })
  location!: ZonePoint | null;

  @Field(() => Int)
  minOrderAmount!: number;

  @Field(() => Int)
  deliveryFee!: number;

  @Field(() => Int)
  avgCookingTimeMin!: number;

  @Field()
  isActive!: boolean;

  @Field()
  timeZone!: string;
}

@InputType({ description: "Регистрация ресторана администратором (ADM-2)" })
export class RegisterRestaurantInput {
  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  phone?: string;

  @Field({ nullable: true })
  addressText?: string;

  @Field(() => ZonePointInput, { nullable: true })
  location?: ZonePointInput;

  @Field(() => Int, { nullable: true })
  minOrderAmount?: number;

  @Field(() => Int, { nullable: true })
  deliveryFeeBase?: number;

  @Field(() => Int, { nullable: true })
  avgCookingTimeMin?: number;

  @Field({ nullable: true })
  timeZone?: string;
}

@ObjectType({ description: "Категория меню — для панели менеджера, включая скрытые" })
export class MenuCategory {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  restaurantId!: string;

  @Field()
  name!: string;

  @Field(() => Int)
  sortOrder!: number;

  @Field({ description: "Ложь — категория скрыта из меню клиента" })
  isActive!: boolean;
}

@InputType({ description: "Сохранение категории: без id создаётся новая" })
export class SaveMenuCategoryInput {
  @Field(() => ID, { nullable: true })
  id?: string;

  @Field(() => ID)
  restaurantId!: string;

  @Field({ nullable: true })
  name?: string;

  @Field(() => Int, { nullable: true })
  sortOrder?: number;

  @Field({ nullable: true })
  isActive?: boolean;
}

@InputType({ description: "Вариант модификатора в редакторе" })
export class ModifierOptionInput {
  @Field()
  name!: string;

  @Field(() => Int, { description: "Надбавка, копейки; может быть отрицательной" })
  priceDelta!: number;

  @Field({ nullable: true })
  isAvailable?: boolean;
}

@InputType({ description: "Группа модификаторов в редакторе (CAT-3)" })
export class ModifierGroupInput {
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

  @Field(() => [ModifierOptionInput])
  options!: ModifierOptionInput[];
}
