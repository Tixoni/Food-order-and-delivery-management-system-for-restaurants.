import { UnauthorizedError } from "@food-delivery/shared";
import type { AuthenticatedUser } from "@food-delivery/service-kit";
import type { Requester } from "../../application/access";

/** Пользователь из проверенного токена — в том виде, который нужен сценариям. */
export function requesterOf(user: AuthenticatedUser | undefined): Requester {
  if (!user) throw new UnauthorizedError("требуется вход в систему");
  return {
    id: user.id,
    roles: user.roles,
    ...(user.restaurantId ? { restaurantId: user.restaurantId } : {}),
  };
}

/** Необязательное число из строки запроса. */
export function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return Number(value);
}
