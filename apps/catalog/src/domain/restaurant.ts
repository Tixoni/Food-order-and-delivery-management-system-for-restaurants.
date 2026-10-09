/**
 * Доменный слой.
 *
 * Здесь живут правила предметной области и больше ничего.
 *
 * Смысл ограничения: правила ресторана можно проверить тестом за миллисекунды,
 * не поднимая базу. Это и делает выполнимым требование MNT-1 о покрытии тестами.
 */

import { Coordinates, type CoordinatesProps } from "./coordinates";

export class RestaurantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestaurantValidationError";
  }
}

export interface RestaurantProps {
  id: string;
  name: string;
  description?: string | null;
  /** Телефон для связи. Хранится как есть: форматы у операторов разные. */
  phone?: string | null;
  addressText?: string | null;
  /** Где находится ресторан. Нужно для подбора курьера (DLV-3). */
  location?: CoordinatesProps | null;
  /** Минимальная сумма заказа в копейках. Деньги — целые числа, не дробные. */
  minOrderAmount: number;
  /** Базовая стоимость доставки в копейках. */
  deliveryFeeBase: number;
  /** Среднее время приготовления, минуты. */
  avgCookingTimeMin: number;
  isActive: boolean;
  timeZone?: string;
}

export class Restaurant {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly description: string | null,
    readonly phone: string | null,
    readonly addressText: string | null,
    readonly location: Coordinates | null,
    readonly minOrderAmount: number,
    readonly deliveryFeeBase: number,
    readonly avgCookingTimeMin: number,
    readonly isActive: boolean,
    readonly timeZone: string,
  ) {}

  /**
   * Единственный способ создать ресторан. Объект не может существовать
   * в некорректном состоянии: проверки выполняются здесь и обойти их нельзя.
   */
  static create(props: RestaurantProps): Restaurant {
    if (props.id.trim().length === 0) {
      throw new RestaurantValidationError("id ресторана не может быть пустым");
    }

    if (props.name.trim().length === 0) {
      throw new RestaurantValidationError("название ресторана не может быть пустым");
    }
    if (props.name.length > 200) {
      throw new RestaurantValidationError("название ресторана длиннее 200 символов");
    }
    if (!Number.isInteger(props.minOrderAmount) || props.minOrderAmount < 0) {
      throw new RestaurantValidationError(
        "минимальная сумма заказа должна быть целым неотрицательным числом копеек",
      );
    }
    if (!Number.isInteger(props.deliveryFeeBase) || props.deliveryFeeBase < 0) {
      throw new RestaurantValidationError(
        "стоимость доставки должна быть целым неотрицательным числом копеек",
      );
    }
    if (!Number.isInteger(props.avgCookingTimeMin) || props.avgCookingTimeMin <= 0) {
      throw new RestaurantValidationError("среднее время приготовления должно быть больше нуля");
    }
    const timeZone = props.timeZone ?? "Europe/Moscow";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
      throw new RestaurantValidationError("неизвестный часовой пояс ресторана");
    }

    const phone = props.phone?.trim() || null;
    if (phone && !/^[+\d][\d\s()-]{4,31}$/.test(phone)) {
      throw new RestaurantValidationError(`телефон записан неразборчиво: ${phone}`);
    }

    // Неверные координаты ресторана обнаружатся не здесь, а при подборе
    // курьера — когда ближайшего не окажется вовсе. Проверяем сразу.
    let location: Coordinates | null = null;
    if (props.location) {
      try {
        location = Coordinates.create(props.location);
      } catch (error) {
        throw new RestaurantValidationError(
          error instanceof Error ? error.message : "неверные координаты ресторана",
        );
      }
    }

    return new Restaurant(
      props.id,
      props.name.trim(),
      props.description?.trim() || null,
      phone,
      props.addressText?.trim() || null,
      location,
      props.minOrderAmount,
      props.deliveryFeeBase,
      props.avgCookingTimeMin,
      props.isActive,
      timeZone,
    );
  }

  /**
   * Требование CART-3: заказ на сумму ниже минимальной ресторан не принимает.
   * Правило живёт в домене, а не в обработчике запроса, — иначе его пришлось бы
   * повторять в каждом месте, откуда оформляется заказ.
   */
  canAcceptOrderTotal(itemsAmount: number): boolean {
    return this.isActive && itemsAmount >= this.minOrderAmount;
  }

  /** Сколько не хватает до минимальной суммы. Ноль — значит хватает. */
  amountMissingToMinimum(itemsAmount: number): number {
    return Math.max(0, this.minOrderAmount - itemsAmount);
  }

  /** Закрытие ресторана: он перестаёт показываться клиентам, но не удаляется. */
  deactivate(): Restaurant {
    return Restaurant.create({ ...this.toProps(), isActive: false });
  }

  toProps(): RestaurantProps {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      phone: this.phone,
      addressText: this.addressText,
      location: this.location
        ? { latitude: this.location.latitude, longitude: this.location.longitude }
        : null,
      minOrderAmount: this.minOrderAmount,
      deliveryFeeBase: this.deliveryFeeBase,
      avgCookingTimeMin: this.avgCookingTimeMin,
      isActive: this.isActive,
      timeZone: this.timeZone,
    };
  }
}
