/**
 * Что шлюз получает от сервиса каталога.
 *
 * Отдельные типы, а не переиспользование доменных классов каталога:
 * шлюз не должен зависеть от внутреннего устройства чужого сервиса —
 * он работает с его внешним контрактом. Ровно поэтому контракт можно
 * менять, не трогая домен, и наоборот.
 */

export interface RestaurantView {
  id: string;
  name: string;
  minOrderAmount: number;
  deliveryFee: number;
  avgCookingTimeMin: number;
}

/** Ресторан в выдаче по адресу: с условиями доставки подошедшей зоны. */
export interface RestaurantOfferView extends RestaurantView {
  zone: { id: string; name: string };
}

export interface OptionView {
  id: string;
  name: string;
  priceDelta: number;
  isAvailable: boolean;
}

/**
 * Способ выбора в группе модификаторов. Перечисление объявлено здесь,
 * вместе с остальным контрактом каталога, а схема GraphQL берёт его
 * отсюда же: два одинаковых перечисления в разных файлах рано или поздно
 * разойдутся значениями.
 */
export enum SelectionType {
  single = "single",
  multiple = "multiple",
}

export interface OptionGroupView {
  id: string;
  name: string;
  selectionType: SelectionType;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  options: OptionView[];
}

export interface MenuItemView {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  composition: string | null;
  imageUrl: string | null;
  price: number;
  weightGrams: number | null;
  calories: number | null;
  isAvailable: boolean;
  optionGroups: OptionGroupView[];
}

export interface MenuSectionView {
  id: string;
  name: string;
  items: MenuItemView[];
}

export interface ZonePointView {
  latitude: number;
  longitude: number;
}

export interface DeliveryZoneView {
  id: string;
  restaurantId: string;
  name: string;
  ring: ZonePointView[];
  deliveryFee: number;
  minOrderAmount: number;
  isActive: boolean;
}

/** Полные сведения о ресторане: их видит администратор, а не клиент. */
export interface RestaurantDetailsView extends RestaurantView {
  description: string | null;
  phone: string | null;
  addressText: string | null;
  location: ZonePointView | null;
  isActive: boolean;
  timeZone: string;
}

export interface StopListEntryView {
  id: string;
  menuItemId: string;
  reason: string | null;
  stoppedAt: string;
  restoredAt: string | null;
  isActive: boolean;
  outageMinutes: number;
}

/** Категория меню в панели менеджера. */
export interface MenuCategoryView {
  id: string;
  restaurantId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}
