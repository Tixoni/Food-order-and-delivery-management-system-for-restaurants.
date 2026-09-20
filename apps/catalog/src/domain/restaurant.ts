/**
 * Доменный слой.
 *
 * Здесь живут правила предметной области и больше ничего. Этот файл не знает,
 * что данные хранятся в PostgreSQL, приходят по HTTP и уезжают в Kafka.
 * Ни одного импорта из библиотек — проверяется автоматически при проверке кода.
 *
 * Смысл ограничения: правила ресторана можно проверить тестом за миллисекунды,
 * не поднимая базу. Это и делает выполнимым требование MNT-1 о покрытии тестами.
 */

export class RestaurantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestaurantValidationError";
  }
}

export interface RestaurantProps {
  id: string;
  name: string;
  /** Минимальная сумма заказа в копейках. Деньги — целые числа, не дробные. */
  minOrderAmount: number;
  /** Базовая стоимость доставки в копейках. */
  deliveryFeeBase: number;
  /** Среднее время приготовления, минуты. */
  avgCookingTimeMin: number;
  isActive: boolean;
}

export class Restaurant {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly minOrderAmount: number,
    readonly deliveryFeeBase: number,
    readonly avgCookingTimeMin: number,
    readonly isActive: boolean,
  ) {}

  /**
   * Единственный способ создать ресторан. Объект не может существовать
   * в некорректном состоянии: проверки выполняются здесь и обойти их нельзя.
   */
  static create(props: RestaurantProps): Restaurant {
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

    return new Restaurant(
      props.id,
      props.name.trim(),
      props.minOrderAmount,
      props.deliveryFeeBase,
      props.avgCookingTimeMin,
      props.isActive,
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
}
