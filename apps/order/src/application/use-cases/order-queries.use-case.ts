import { Inject, Injectable } from "@nestjs/common";
import { ForbiddenError, NotFoundError, ValidationError } from "@food-delivery/shared";
import { ORDER_STATUSES } from "../../domain/order-status";
import { assertWorksAt, canSeeOrder, isStaff, type Requester } from "../access";
import {
  ORDER_READ_MODEL,
  type OrderHistoryView,
  type OrderReadModel,
  type OrderView,
} from "../ports/order-read-model";

const MAX_PAGE = 100;

const page = (value: number | undefined, fallback: number, max = MAX_PAGE) => {
  if (value === undefined || Number.isNaN(value)) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ValidationError(`параметр страницы должен быть целым числом от 0 до ${max}`);
  }
  return value;
};

/**
 * Чтение заказов (облегчённый CQRS): готовые представления из отдельного
 * порта, без загрузки агрегата и саги. Права проверяются здесь — до того,
 * как данные уйдут наружу (SEC-2).
 */
@Injectable()
export class OrderQueriesUseCase {
  constructor(@Inject(ORDER_READ_MODEL) private readonly read: OrderReadModel) {}

  /** TRK-1 и ORD-7: заказ целиком. Чужой заказ — «не найден», а не «нет прав». */
  async get(orderId: string, requester: Requester): Promise<OrderView> {
    const view = await this.read.get(orderId);
    if (!view || !canSeeOrder(requester, view)) {
      throw new NotFoundError("заказ не найден", { orderId });
    }
    return view;
  }

  /** ORD-7: история заказов клиента. */
  async listMine(requester: Requester, limit?: number, offset?: number) {
    if (!requester.roles.includes("client"))
      throw new ForbiddenError("история заказов — для клиента");
    return this.read.listByCustomer(requester.id, page(limit, 20) || 20, page(offset, 0, 10_000));
  }

  /** KIT-1: очередь кухни своего ресторана. */
  async kitchenQueue(restaurantId: string, requester: Requester) {
    if (!requester.roles.some((role) => ["kitchen", "manager", "admin"].includes(role))) {
      throw new ForbiddenError("очередь доступна кухне ресторана");
    }
    assertWorksAt(requester, restaurantId);
    return this.read.kitchenQueue(restaurantId);
  }

  /** ADM-3: поиск заказов оператором — по статусу и по очереди «нужно внимание». */
  async list(
    requester: Requester,
    filter: { statuses?: string[]; attentionOnly?: boolean; limit?: number; offset?: number },
  ) {
    if (!isStaff(requester)) throw new ForbiddenError("поиск заказов — для оператора");
    const unknown = (filter.statuses ?? []).filter(
      (status) => !(ORDER_STATUSES as readonly string[]).includes(status),
    );
    if (unknown.length > 0) throw new ValidationError("неизвестный статус заказа", { unknown });
    return this.read.list({
      ...(filter.statuses?.length ? { statuses: filter.statuses } : {}),
      attentionOnly: filter.attentionOnly ?? false,
      limit: page(filter.limit, 50) || 50,
      offset: page(filter.offset, 0, 100_000),
    });
  }

  /**
   * ADM-3: полная история — переходы, шаги саги с попытками и ошибками,
   * ожидающие таймеры. Клиент видит только переходы своего заказа:
   * внутреннее устройство оплаты ему знать незачем.
   */
  async history(orderId: string, requester: Requester): Promise<OrderHistoryView> {
    const order = await this.get(orderId, requester);
    const history = await this.read.history(order.id);
    if (!history) throw new NotFoundError("заказ не найден", { orderId });
    return isStaff(requester) ? history : { ...history, saga: null, pending: [] };
  }
}
