import { useState } from "react";
import { useApolloClient } from "@apollo/client";
import { useNavigate } from "react-router-dom";
import { MENU, RESTAURANTS_NEARBY, type MenuSection, type RestaurantSummary } from "../api/queries";
import { useBasket } from "../cart/basket";
import { useSession } from "../auth/session";
import { errorText } from "../api/client";
import { initialChoice, problems, toSelections, unitPrice } from "./modifiers";
import { saveAddress } from "../pages/address";

export const TEST_ADDRESS = {
  label: "Москва, Тверская улица, 7",
  latitude: 55.7615,
  longitude: 37.6094,
};
export const TEST_DETAILS = {
  apartment: "42",
  entrance: "2",
  floor: "6",
  phone: "+7 900 000-00-00",
  comment: "Тестовый заказ. Позвонить у подъезда, приборы на двоих.",
};

export function TestOrderButton({ onPrepared }: { onPrepared?: () => void }) {
  const client = useApolloClient();
  const basket = useBasket();
  const { hasRole } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function prepare() {
    if (basket.lines.length && !window.confirm("Заменить текущую корзину тестовым заказом?"))
      return;
    setBusy(true);
    setError("");
    try {
      const restaurants = await client.query<{ restaurantsNearby: RestaurantSummary[] }>({
        query: RESTAURANTS_NEARBY,
        variables: TEST_ADDRESS,
        fetchPolicy: "network-only",
      });
      const list = restaurants.data.restaurantsNearby;
      const restaurant = list.find((item) => item.name.startsWith("Вкусно Дворик")) ?? list[0];
      if (!restaurant) throw new Error("По тестовому адресу нет доступных ресторанов.");
      const result = await client.query<{ menu: { categories: MenuSection[] } }>({
        query: MENU,
        variables: { restaurantId: restaurant.id, includeUnavailable: false },
        fetchPolicy: "network-only",
      });
      const entries = result.data.menu.categories
        .flatMap((category) => category.items)
        .map((item) => {
          const choice = initialChoice(item);
          return { item, choice, price: unitPrice(item, choice) };
        })
        .filter(
          ({ item, choice, price }) =>
            item.isAvailable && price > 0 && Object.keys(problems(item, choice)).length === 0,
        )
        .slice(0, 2);
      if (!entries.length) throw new Error("Нет доступных блюд для тестового заказа.");
      const restAmount = entries.slice(1).reduce((sum, entry) => sum + entry.price, 0);
      const quantity = Math.max(
        1,
        Math.ceil((restaurant.minOrderAmount - restAmount) / entries[0].price),
      );
      if (quantity > 99) throw new Error("Не удалось набрать минимальную сумму.");
      basket.clear();
      entries.forEach(({ item, choice, price }, index) =>
        basket.add(
          restaurant,
          {
            itemId: item.id,
            name: item.name,
            quantity: index === 0 ? quantity : 1,
            unitPrice: price,
            ...toSelections(item, choice),
          },
          true,
        ),
      );
      saveAddress(TEST_ADDRESS);
      sessionStorage.setItem("fd:test-order", "1");
      if (onPrepared) onPrepared();
      navigate("/checkout", { state: { testOrder: true } });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="test-order">
      <button type="button" className="secondary" disabled={busy} onClick={() => void prepare()}>
        {busy ? "Собираем заказ…" : "Заполнить тестовый заказ"}
      </button>
      {!hasRole("client") && <span className="item__note">Оформление после входа клиентом</span>}
      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
