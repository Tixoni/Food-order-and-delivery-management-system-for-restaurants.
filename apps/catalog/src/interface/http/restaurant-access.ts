import { ForbiddenError } from "@food-delivery/shared";
import { ROLES, hasRole, type AuthenticatedUser } from "@food-delivery/service-kit";

/**
 * Проверка владения ресурсом — вторая половина требования SEC-2.
 *
 * Роль отвечает на вопрос «имеет ли право вообще», а эта проверка —
 * «имеет ли право на этот ресторан». Без неё менеджер любого ресторана
 * может убрать в стоп-лист блюдо любого другого: роль-то у него есть.
 *
 * Привязка сотрудника к ресторану берётся из токена, а не из запроса:
 * значение из запроса подставляет клиентская часть, и подменить его
 * может кто угодно.
 */
export function assertManagesRestaurant(
  user: AuthenticatedUser | undefined,
  restaurantId: string,
): void {
  // Администратор работает со всеми ресторанами: он их и регистрирует (ADM-2).
  if (hasRole(user, ROLES.admin)) return;

  if (!user?.restaurantId) {
    throw new ForbiddenError(
      "учётная запись не привязана ни к одному ресторану: обратитесь к администратору",
    );
  }

  if (user.restaurantId !== restaurantId) {
    throw new ForbiddenError("нет прав на этот ресторан", { restaurantId });
  }
}
