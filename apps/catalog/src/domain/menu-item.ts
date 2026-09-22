import { assertMoney, type Kopecks } from "./money";
import { OptionGroup, OptionSelectionError } from "./option-group";

/**
 * Блюдо в меню ресторана.
 *
 * Здесь же — расчёт цены позиции с учётом выбранных модификаторов.
 * Это самое ответственное место сервиса: ошибка в расчёте означает
 * неверную сумму заказа и неверное списание денег.
 */

export class MenuItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MenuItemError";
  }
}

export interface MenuItemProps {
  id: string;
  restaurantId: string;
  categoryId: string;
  name: string;
  description?: string | null;
  composition?: string | null;
  /** Базовая цена в копейках, без модификаторов. */
  price: Kopecks;
  weightGrams?: number | null;
  calories?: number | null;
  /** Ложь означает стоп-лист: блюдо временно нельзя заказать. */
  isAvailable: boolean;
  sortOrder: number;
  optionGroups?: OptionGroup[];
}

/** Что выбрал клиент: в каждой группе — список идентификаторов вариантов. */
export interface OptionSelection {
  groupId: string;
  optionIds: string[];
}

/** Подробный расчёт позиции. Отдаётся клиенту и сохраняется в заказе. */
export interface LinePrice {
  /** Базовая цена блюда за штуку. */
  basePrice: Kopecks;
  /** Суммарная надбавка модификаторов за штуку. */
  optionsDelta: Kopecks;
  /** Цена за штуку с модификаторами. */
  unitPrice: Kopecks;
  quantity: number;
  /** Итог по позиции. */
  lineTotal: Kopecks;
  chosenOptions: Array<{ groupId: string; optionId: string; name: string; priceDelta: Kopecks }>;
}

const MAX_NAME = 200;
const MAX_QUANTITY = 99;

export class MenuItem {
  private constructor(
    readonly id: string,
    readonly restaurantId: string,
    readonly categoryId: string,
    readonly name: string,
    readonly description: string | null,
    readonly composition: string | null,
    readonly price: Kopecks,
    readonly weightGrams: number | null,
    readonly calories: number | null,
    readonly isAvailable: boolean,
    readonly sortOrder: number,
    readonly optionGroups: readonly OptionGroup[],
  ) {}

  static create(props: MenuItemProps): MenuItem {
    const name = props.name.trim();

    if (name.length === 0) {
      throw new MenuItemError("название блюда не может быть пустым");
    }
    if (name.length > MAX_NAME) {
      throw new MenuItemError(`название блюда длиннее ${MAX_NAME} символов`);
    }
    assertMoney(props.price, `блюдо «${name}»`);

    if (
      props.weightGrams != null &&
      (!Number.isInteger(props.weightGrams) || props.weightGrams <= 0)
    ) {
      throw new MenuItemError(`блюдо «${name}»: вес должен быть целым положительным числом`);
    }
    if (props.calories != null && (!Number.isInteger(props.calories) || props.calories < 0)) {
      throw new MenuItemError(`блюдо «${name}»: калорийность не может быть отрицательной`);
    }

    const groups = props.optionGroups ?? [];
    if (new Set(groups.map((g) => g.id)).size !== groups.length) {
      throw new MenuItemError(
        `блюдо «${name}»: группы модификаторов с одинаковыми идентификаторами`,
      );
    }

    return new MenuItem(
      props.id,
      props.restaurantId,
      props.categoryId,
      name,
      props.description?.trim() || null,
      props.composition?.trim() || null,
      props.price,
      props.weightGrams ?? null,
      props.calories ?? null,
      props.isAvailable,
      props.sortOrder,
      Object.freeze([...groups]),
    );
  }

  /** Требование CAT-4: блюдо в стоп-листе заказать нельзя. */
  get isOrderable(): boolean {
    return this.isAvailable;
  }

  /** Перевод в стоп-лист и обратно — новое состояние, а не изменение текущего. */
  withAvailability(isAvailable: boolean): MenuItem {
    return MenuItem.create({ ...this.toProps(), isAvailable });
  }

  withGroups(optionGroups: OptionGroup[]): MenuItem {
    return MenuItem.create({ ...this.toProps(), optionGroups });
  }

  /**
   * Расчёт стоимости позиции.
   *
   * Порядок действий важен: сначала к цене блюда прибавляются надбавки
   * модификаторов, и только потом результат умножается на количество.
   * Обратный порядок даёт другую сумму, если надбавок несколько.
   */
  calculatePrice(selections: readonly OptionSelection[] = [], quantity = 1): LinePrice {
    if (!this.isOrderable) {
      throw new MenuItemError(`блюдо «${this.name}» временно недоступно`);
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new MenuItemError("количество должно быть целым числом от единицы");
    }
    if (quantity > MAX_QUANTITY) {
      throw new MenuItemError(`количество не может превышать ${MAX_QUANTITY}`);
    }

    const byGroup = new Map<string, string[]>();
    for (const selection of selections) {
      if (byGroup.has(selection.groupId)) {
        throw new OptionSelectionError("группа модификаторов указана дважды");
      }
      byGroup.set(selection.groupId, selection.optionIds);
    }

    // Выбор в группе, которой у блюда нет, — признак рассогласования
    // клиента и меню. Молча игнорировать нельзя: клиент рассчитывает
    // на то, что выбрал, и итоговая сумма его удивит.
    for (const groupId of byGroup.keys()) {
      if (!this.optionGroups.some((group) => group.id === groupId)) {
        throw new OptionSelectionError("выбран модификатор, которого нет у этого блюда");
      }
    }

    const chosenOptions: LinePrice["chosenOptions"] = [];
    let optionsDelta = 0;

    for (const group of this.optionGroups) {
      const options = group.resolveSelection(byGroup.get(group.id) ?? []);
      for (const option of options) {
        optionsDelta += option.priceDelta;
        chosenOptions.push({
          groupId: group.id,
          optionId: option.id,
          name: option.name,
          priceDelta: option.priceDelta,
        });
      }
    }

    const unitPrice = this.price + optionsDelta;

    // Надбавки могут быть отрицательными, поэтому теоретически цена
    // способна уйти в минус. Такое блюдо продавать нельзя — это ошибка
    // настройки меню, и обнаружить её лучше здесь, чем в чеке.
    if (unitPrice < 0) {
      throw new MenuItemError(
        `блюдо «${this.name}»: итоговая цена с модификаторами оказалась отрицательной`,
      );
    }

    return {
      basePrice: this.price,
      optionsDelta,
      unitPrice,
      quantity,
      lineTotal: unitPrice * quantity,
      chosenOptions,
    };
  }

  toProps(): MenuItemProps {
    return {
      id: this.id,
      restaurantId: this.restaurantId,
      categoryId: this.categoryId,
      name: this.name,
      description: this.description,
      composition: this.composition,
      price: this.price,
      weightGrams: this.weightGrams,
      calories: this.calories,
      isAvailable: this.isAvailable,
      sortOrder: this.sortOrder,
      optionGroups: [...this.optionGroups],
    };
  }
}
