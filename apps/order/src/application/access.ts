import { ForbiddenError } from "@food-delivery/shared";

/**
 * Кто выполняет запрос — в том объёме, который нужен для проверки прав.
 * Берётся из проверенного токена, а не из тела запроса.
 */
export interface Requester {
  id: string;
  roles: readonly string[];
  /** Ресторан сотрудника — менеджера или кухни. */
  restaurantId?: string;
}

const STAFF = ["operator", "admin"];
const RESTAURANT_STAFF = ["kitchen", "manager"];

export const isStaff = (requester: Requester) =>
  requester.roles.some((role) => STAFF.includes(role));

/**
 * Проверка владения ресурсом — вторая половина SEC-2.
 *
 * Роль отвечает на вопрос «имеет ли право вообще», эта проверка — «имеет ли
 * право на этот заказ». Без неё клиент получил бы чужой заказ по прямому
 * идентификатору, а кухня одного ресторана — заказы другого.
 */
export function canSeeOrder(
  requester: Requester,
  order: { customerId: string; restaurantId: string },
): boolean {
  if (isStaff(requester)) return true;
  if (requester.roles.includes("client") && order.customerId === requester.id) return true;
  return (
    requester.roles.some((role) => RESTAURANT_STAFF.includes(role)) &&
    !!requester.restaurantId &&
    requester.restaurantId === order.restaurantId
  );
}

/** Команды кухни: только сотрудник своего ресторана или администратор. */
export function assertWorksAt(requester: Requester, restaurantId: string): void {
  if (requester.roles.includes("admin")) return;
  if (!requester.restaurantId) {
    throw new ForbiddenError(
      "учётная запись не привязана ни к одному ресторану: обратитесь к администратору",
    );
  }
  if (requester.restaurantId !== restaurantId) {
    throw new ForbiddenError("нет прав на заказы этого ресторана", { restaurantId });
  }
}
