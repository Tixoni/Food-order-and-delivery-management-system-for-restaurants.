import { useState } from "react";
import { useQuery } from "@apollo/client";
import { RESTAURANTS, type RestaurantSummary } from "../../api/queries";
import { useSession } from "../../auth/session";

/**
 * С каким рестораном работает сотрудник.
 *
 * Менеджер и кухня привязаны к своему ресторану — привязка берётся
 * из токена, выбрать чужой нельзя. Администратор работает со всеми
 * и выбирает ресторан из списка. Даже если подменить выбор в браузере,
 * каталог проверит владение рестораном сам (SEC-2).
 */
export function useManagedRestaurant() {
  const { user, hasRole } = useSession();
  const isAdmin = hasRole("admin");
  const [chosen, setChosen] = useState<string | null>(null);

  const list = useQuery<{ restaurants: { items: RestaurantSummary[] } }>(RESTAURANTS, {
    variables: { page: 1, pageSize: 50 },
    skip: !isAdmin,
  });

  const restaurants = list.data?.restaurants.items ?? [];
  const restaurantId = isAdmin
    ? (chosen ?? restaurants[0]?.id ?? null)
    : (user?.restaurantId ?? null);
  const restaurantName = restaurants.find((restaurant) => restaurant.id === restaurantId)?.name;

  const picker = isAdmin ? (
    <div className="field picker">
      <label className="field__label" htmlFor="restaurant-picker">
        Ресторан
      </label>
      <select
        id="restaurant-picker"
        value={restaurantId ?? ""}
        onChange={(event) => setChosen(event.target.value)}
      >
        {restaurants.map((restaurant) => (
          <option key={restaurant.id} value={restaurant.id}>
            {restaurant.name}
          </option>
        ))}
      </select>
    </div>
  ) : null;

  const missing =
    !isAdmin && !user?.restaurantId ? (
      <p className="notice notice--error">
        Учётная запись не привязана ни к одному ресторану — обратитесь к администратору.
      </p>
    ) : null;

  return { restaurantId, restaurantName, picker, missing, isAdmin };
}
