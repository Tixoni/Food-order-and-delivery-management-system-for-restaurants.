import { Inject, Injectable } from "@nestjs/common";
import { ForbiddenError, NotFoundError, ValidationError } from "@food-delivery/shared";
import type { Actor } from "../../domain/order";
import { assertWorksAt, canSeeOrder, isStaff, type Requester } from "../access";
import { domain } from "../domain-errors";
import {
  ConcurrentModificationError,
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
 * Одновременные записи разрешает оптимистичная блокировка. Проигравшая
 * команда перечитывает заказ и применяется заново: правила автомата
 * проверяются на свежем состоянии. Если заказ за это время действительно
 * ушёл дальше — например, кухня начала готовить, пока клиент нажимал
 * «отменить», — команда получит настоящий конфликт. А если второй записью
 * была служебная отметка саги, клиент ошибки не увидит.
 */
const MAX_ATTEMPTS = 3;

@Injectable()
export class OrderCommandsUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ORDER_COMMITTER) private readonly committer: OrderCommitter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** ORD-5: клиент отменяет заказ до начала готовки; деньги вернутся полностью. */
  async cancelByCustomer(orderId: string, requester: Requester, comment?: string | null) {
    const actor: Actor = { type: "CUSTOMER", id: requester.id };
    return this.run(
      async () => {
        const loaded = await this.load(orderId);
        if (!requester.roles.includes("client") || loaded.order.customerId !== requester.id) {
          throw new NotFoundError("заказ не найден", { orderId });
        }
        return loaded;
      },
      ({ order }) => order.cancel(actor, "CUSTOMER", comment ?? null, this.clock()),
    );
  }

  /** KIT-2: кухня принимает заказ и называет время готовки. */
  async confirm(orderId: string, requester: Requester, cookingMinutes: number) {
    return this.run(
      () => this.loadForKitchen(orderId, requester),
      ({ order }) => order.confirm(Number(cookingMinutes), this.kitchen(requester), this.clock()),
    );
  }

  /** KIT-3: кухня отклоняет заказ с причиной; холд будет снят. */
  async reject(orderId: string, requester: Requester, reason: string) {
    if (!reason?.trim()) throw new ValidationError("укажите причину отклонения");
    return this.run(
      () => this.loadForKitchen(orderId, requester),
      ({ order }) => order.cancel(this.kitchen(requester), "RESTAURANT", reason, this.clock()),
    );
  }

  /** KIT-4: заказ готов к выдаче курьеру. */
  async markReady(orderId: string, requester: Requester) {
    return this.run(
      () => this.loadForKitchen(orderId, requester),
      ({ order }) => order.markReady(this.kitchen(requester), this.clock()),
    );
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
    if (refundAmount != null && (!Number.isInteger(refundAmount) || refundAmount < 0)) {
      throw new ValidationError("сумма возврата — целое неотрицательное число копеек");
    }
    const actor: Actor = { type: "OPERATOR", id: requester.id };
    return this.run(
      () => this.load(orderId),
      ({ order, saga }) => {
        if (refundAmount != null) {
          if (refundAmount > order.amounts.total) {
            throw new ValidationError("сумма возврата больше суммы заказа");
          }
          saga.record({ refundTarget: refundAmount });
        }
        return order.cancel(actor, "OPERATOR", comment, this.clock());
      },
    );
  }

  /** Оператор разобрался с заказом из своей очереди. */
  async clearAttention(orderId: string, requester: Requester) {
    this.assertStaff(requester);
    return this.run(
      () => this.load(orderId),
      ({ order }) => {
        if (!order.attentionReason) return false;
        order.clearAttention();
        return true;
      },
    );
  }

  /**
   * Прочитать, применить, сохранить; при одновременной записи — заново,
   * не больше трёх раз. `change` возвращает, изменилось ли что-нибудь:
   * повтор уже выполненной команды ничего не сохраняет.
   */
  private async run(load: () => Promise<LoadedOrder>, change: (loaded: LoadedOrder) => boolean) {
    for (let attempt = 1; ; attempt += 1) {
      const loaded = await load();
      const changed = domain(() => change(loaded));
      if (!changed) return loaded.order;
      try {
        await this.committer.commit(loaded, this.clock());
        return loaded.order;
      } catch (error) {
        if (!(error instanceof ConcurrentModificationError) || attempt >= MAX_ATTEMPTS) throw error;
      }
    }
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
