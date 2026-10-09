import { Inject, Injectable } from "@nestjs/common";
import { ForbiddenError, NotFoundError, ValidationError } from "@food-delivery/shared";
import type { Actor } from "../../domain/order";
import { assertWorksAt, canSeeOrder, isStaff, type Requester } from "../access";
import { domain } from "../domain-errors";
import {
  ORDER_REPOSITORY,
  type LoadedOrder,
  type OrderRepository,
} from "../ports/order.repository";
import { CLOCK, type Clock } from "../ports/clock";
import { ORDER_COMMITTER, type OrderCommitter } from "../saga/order-committer";

/**
 * Команды над заказом от людей: клиента, кухни, оператора.
 *
 * Каждая команда — переход по таблице автомата. Всё, что из перехода следует
 * (события, сроки, компенсации), решает процесс заказа, а не команда:
 * команда «отменить» не знает, что надо снять холд, — это знает сага.
 *
 * Повтор успешной команды ничего не меняет и ошибкой не считается.
 * Одновременные команды разрешает оптимистичная блокировка: проигравший
 * получает конфликт и перечитывает заказ.
 */
@Injectable()
export class OrderCommandsUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ORDER_COMMITTER) private readonly committer: OrderCommitter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** ORD-5: клиент отменяет заказ до начала готовки; деньги вернутся полностью. */
  async cancelByCustomer(orderId: string, requester: Requester, comment?: string | null) {
    const loaded = await this.load(orderId);
    if (!requester.roles.includes("client") || loaded.order.customerId !== requester.id) {
      throw new NotFoundError("заказ не найден", { orderId });
    }
    const actor: Actor = { type: "CUSTOMER", id: requester.id };
    return this.apply(loaded, () =>
      loaded.order.cancel(actor, "CUSTOMER", comment ?? null, this.clock()),
    );
  }

  /** KIT-2: кухня принимает заказ и называет время готовки. */
  async confirm(orderId: string, requester: Requester, cookingMinutes: number) {
    const loaded = await this.loadForKitchen(orderId, requester);
    return this.apply(loaded, () =>
      loaded.order.confirm(Number(cookingMinutes), this.kitchen(requester), this.clock()),
    );
  }

  /** KIT-3: кухня отклоняет заказ с причиной; холд будет снят. */
  async reject(orderId: string, requester: Requester, reason: string) {
    if (!reason?.trim()) throw new ValidationError("укажите причину отклонения");
    const loaded = await this.loadForKitchen(orderId, requester);
    return this.apply(loaded, () =>
      loaded.order.cancel(this.kitchen(requester), "RESTAURANT", reason, this.clock()),
    );
  }

  /** KIT-4: заказ готов к выдаче курьеру. */
  async markReady(orderId: string, requester: Requester) {
    const loaded = await this.loadForKitchen(orderId, requester);
    return this.apply(loaded, () => loaded.order.markReady(this.kitchen(requester), this.clock()));
  }

  /**
   * ORD-6 и ADM-3: отмена оператором на любом этапе. После списания —
   * возврат: полный или на указанную сумму (частичный возврат — PAY-6).
   */
  async cancelByOperator(
    orderId: string,
    requester: Requester,
    comment: string,
    refundAmount?: number | null,
  ) {
    this.assertStaff(requester);
    if (!comment?.trim()) throw new ValidationError("укажите причину отмены");
    const loaded = await this.load(orderId);
    if (refundAmount != null) {
      if (!Number.isInteger(refundAmount) || refundAmount < 0) {
        throw new ValidationError("сумма возврата — целое неотрицательное число копеек");
      }
      if (refundAmount > loaded.order.amounts.total) {
        throw new ValidationError("сумма возврата больше суммы заказа");
      }
      loaded.saga.record({ refundTarget: refundAmount });
    }
    const actor: Actor = { type: "OPERATOR", id: requester.id };
    return this.apply(loaded, () => loaded.order.cancel(actor, "OPERATOR", comment, this.clock()));
  }

  /** Оператор разобрался с заказом из своей очереди. */
  async clearAttention(orderId: string, requester: Requester) {
    this.assertStaff(requester);
    const loaded = await this.load(orderId);
    if (!loaded.order.attentionReason) return loaded.order;
    loaded.order.clearAttention();
    await this.committer.commit(loaded, this.clock());
    return loaded.order;
  }

  private async apply(loaded: LoadedOrder, command: () => boolean) {
    const changed = domain(command);
    if (changed) await this.committer.commit(loaded, this.clock());
    return loaded.order;
  }

  private async load(orderId: string): Promise<LoadedOrder> {
    const loaded = await this.orders.findById(orderId);
    if (!loaded) throw new NotFoundError("заказ не найден", { orderId });
    return loaded;
  }

  private async loadForKitchen(orderId: string, requester: Requester) {
    if (!requester.roles.some((role) => ["kitchen", "manager", "admin"].includes(role))) {
      throw new ForbiddenError("действие доступно кухне ресторана");
    }
    const loaded = await this.load(orderId);
    // Чужой заказ — «не найден», а не «нет прав»: не подтверждаем его существование.
    if (!canSeeOrder(requester, loaded.order)) {
      throw new NotFoundError("заказ не найден", { orderId });
    }
    assertWorksAt(requester, loaded.order.restaurantId);
    return loaded;
  }

  private kitchen(requester: Requester): Actor {
    return { type: "RESTAURANT", id: requester.id };
  }

  private assertStaff(requester: Requester) {
    if (!isStaff(requester)) throw new ForbiddenError("действие доступно оператору поддержки");
  }
}
