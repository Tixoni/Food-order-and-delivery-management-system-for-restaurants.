import { Inject, Injectable } from "@nestjs/common";
import { DomainRuleError, NotFoundError } from "@food-delivery/shared";
import type { LinePrice, OptionSelection } from "../../domain/menu-item";
import { MENU_REPOSITORY, type MenuRepository } from "../ports/menu.repository";

export interface PriceMenuItemQuery {
  itemId: string;
  selections?: OptionSelection[];
  quantity?: number;
}

/**
 * Расчёт стоимости позиции с выбранными модификаторами.
 *
 * Зачем отдельный сценарий: цену считает сервис, а не клиент. Браузер
 * можно изменить, и если доверить расчёт ему, в заказ придёт любая сумма.
 * Этот же расчёт позже будет вызывать сервис заказов при добавлении
 * в корзину (CART-2) — правило остаётся в одном месте.
 */
@Injectable()
export class PriceMenuItemUseCase {
  constructor(@Inject(MENU_REPOSITORY) private readonly menu: MenuRepository) {}

  async execute(query: PriceMenuItemQuery): Promise<LinePrice> {
    const item = await this.menu.findItemById(query.itemId);
    if (!item) {
      throw new NotFoundError("блюдо не найдено", { itemId: query.itemId });
    }

    try {
      return item.calculatePrice(query.selections ?? [], query.quantity ?? 1);
    } catch (error) {
      // Неверный выбор модификаторов или блюдо в стоп-листе — это сообщение
      // пользователю, а не сбой системы. Текст исключения домена написан
      // для человека и передаётся как есть.
      throw new DomainRuleError(error instanceof Error ? error.message : String(error), {
        itemId: query.itemId,
      });
    }
  }
}
