import { assertMoney, type Kopecks } from "./money";
import { OrderRuleError } from "./order-errors";

export interface OrderLineOption {
  readonly optionId: string;
  readonly name: string;
  readonly priceDelta: Kopecks;
}

export interface OrderLineProps {
  menuItemId: string;
  name: string;
  /** Базовая цена блюда за штуку на момент оформления. */
  basePrice: Kopecks;
  quantity: number;
  options: OrderLineOption[];
}

const MAX_QUANTITY = 99;

/**
 * Позиция заказа — снимок, а не ссылка на меню.
 *
 * Название и цена копируются на момент оформления: если ресторан потом
 * поднимет цену, история заказов и чеки не должны измениться задним числом.
 * Ссылка на актуальное меню вместо снимка — самая частая ошибка в схемах
 * такого рода.
 */
export class OrderLine {
  private constructor(
    readonly menuItemId: string,
    readonly name: string,
    readonly basePrice: Kopecks,
    readonly quantity: number,
    readonly options: readonly OrderLineOption[],
  ) {}

  static create(props: OrderLineProps): OrderLine {
    if (!props.menuItemId) throw new OrderRuleError("у позиции нет идентификатора блюда");
    const name = props.name?.trim();
    if (!name) throw new OrderRuleError("у позиции нет названия");
    if (!Number.isInteger(props.quantity) || props.quantity < 1 || props.quantity > MAX_QUANTITY) {
      throw new OrderRuleError(`количество должно быть целым числом от 1 до ${MAX_QUANTITY}`);
    }
    assertMoney(props.basePrice, "basePrice");
    for (const option of props.options) assertMoney(option.priceDelta, "priceDelta", true);

    const line = new OrderLine(props.menuItemId, name, props.basePrice, props.quantity, [
      ...props.options.map((option) => ({ ...option })),
    ]);
    if (line.unitPrice < 0) {
      throw new OrderRuleError(`позиция «${name}»: цена с модификаторами отрицательна`);
    }
    return line;
  }

  /** Цена за штуку с модификаторами. */
  get unitPrice(): Kopecks {
    return this.basePrice + this.options.reduce((sum, option) => sum + option.priceDelta, 0);
  }

  get lineTotal(): Kopecks {
    return this.unitPrice * this.quantity;
  }
}
