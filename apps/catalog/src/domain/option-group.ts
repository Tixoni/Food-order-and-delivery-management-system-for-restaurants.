import { assertMoney, type Kopecks } from "./money";

/**
 * Модификаторы блюда — требование CAT-3.
 *
 * Пример: у пиццы есть группа «Размер» (обязательная, ровно один вариант)
 * и группа «Добавки» (необязательная, от нуля до пяти). Каждый вариант
 * меняет цену блюда.
 *
 * Правила выбора живут здесь, а не в обработчике запроса: их нужно
 * применять и при показе меню, и при добавлении в корзину, и при
 * оформлении заказа. Повторять их в трёх местах — значит рано или
 * поздно получить три разных поведения.
 */

export class OptionSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptionSelectionError";
  }
}

export type SelectionType = "single" | "multiple";

export interface ItemOptionProps {
  id: string;
  name: string;
  /** Надбавка к цене блюда. Может быть отрицательной. */
  priceDelta: Kopecks;
  isAvailable: boolean;
}

export class ItemOption {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly priceDelta: Kopecks,
    readonly isAvailable: boolean,
  ) {}

  static create(props: ItemOptionProps): ItemOption {
    if (props.name.trim().length === 0) {
      throw new OptionSelectionError("название варианта не может быть пустым");
    }
    assertMoney(props.priceDelta, `вариант «${props.name}»`, { allowNegative: true });

    return new ItemOption(props.id, props.name.trim(), props.priceDelta, props.isAvailable);
  }
}

export interface OptionGroupProps {
  id: string;
  name: string;
  selectionType: SelectionType;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  options: ItemOption[];
}

export class OptionGroup {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly selectionType: SelectionType,
    readonly isRequired: boolean,
    readonly minSelect: number,
    readonly maxSelect: number,
    readonly options: readonly ItemOption[],
  ) {}

  static create(props: OptionGroupProps): OptionGroup {
    const { name, selectionType, isRequired, minSelect, maxSelect, options } = props;

    if (name.trim().length === 0) {
      throw new OptionSelectionError("название группы модификаторов не может быть пустым");
    }
    if (!Number.isInteger(minSelect) || minSelect < 0) {
      throw new OptionSelectionError(`группа «${name}»: минимум должен быть целым от нуля`);
    }
    if (!Number.isInteger(maxSelect) || maxSelect < 1) {
      throw new OptionSelectionError(`группа «${name}»: максимум должен быть целым от единицы`);
    }
    if (maxSelect < minSelect) {
      throw new OptionSelectionError(`группа «${name}»: максимум меньше минимума`);
    }
    // Одиночный выбор с максимумом больше одного — противоречие в настройке:
    // либо это множественный выбор, либо максимум равен единице.
    if (selectionType === "single" && maxSelect !== 1) {
      throw new OptionSelectionError(
        `группа «${name}»: при одиночном выборе максимум должен быть равен единице`,
      );
    }
    if (isRequired && minSelect < 1) {
      throw new OptionSelectionError(
        `группа «${name}»: обязательная группа должна требовать хотя бы один вариант`,
      );
    }
    if (options.length === 0) {
      throw new OptionSelectionError(`группа «${name}»: нужен хотя бы один вариант`);
    }
    if (new Set(options.map((o) => o.id)).size !== options.length) {
      throw new OptionSelectionError(`группа «${name}»: варианты с одинаковыми идентификаторами`);
    }
    if (minSelect > options.length) {
      throw new OptionSelectionError(
        `группа «${name}»: требуется вариантов больше, чем есть в группе`,
      );
    }

    return new OptionGroup(
      props.id,
      name.trim(),
      selectionType,
      isRequired,
      minSelect,
      maxSelect,
      Object.freeze([...options]),
    );
  }

  findOption(optionId: string): ItemOption | undefined {
    return this.options.find((option) => option.id === optionId);
  }

  /**
   * Проверяет выбор клиента и возвращает выбранные варианты.
   * Бросает исключение с понятным сообщением — оно дойдёт до пользователя.
   */
  resolveSelection(selectedIds: readonly string[]): ItemOption[] {
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new OptionSelectionError(`группа «${this.name}»: вариант выбран дважды`);
    }
    if (selectedIds.length < this.minSelect) {
      throw new OptionSelectionError(
        this.isRequired && this.minSelect === 1
          ? `нужно выбрать вариант в группе «${this.name}»`
          : `группа «${this.name}»: нужно выбрать не менее ${this.minSelect}`,
      );
    }
    if (selectedIds.length > this.maxSelect) {
      throw new OptionSelectionError(
        `группа «${this.name}»: можно выбрать не более ${this.maxSelect}`,
      );
    }

    return selectedIds.map((id) => {
      const option = this.findOption(id);
      if (!option) {
        throw new OptionSelectionError(`группа «${this.name}»: вариант не найден`);
      }
      if (!option.isAvailable) {
        throw new OptionSelectionError(`вариант «${option.name}» временно недоступен`);
      }
      return option;
    });
  }
}
