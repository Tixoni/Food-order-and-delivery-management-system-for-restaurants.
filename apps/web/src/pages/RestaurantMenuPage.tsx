import { useMemo, useState } from "react";
import { useQuery } from "@apollo/client";
import { Link, useLocation, useParams } from "react-router-dom";
import { errorText } from "../api/client";
import {
  MENU,
  RESTAURANTS,
  RESTAURANTS_NEARBY,
  type MenuItem,
  type MenuSection,
  type RestaurantSummary,
} from "../api/queries";
import { useBasket } from "../cart/basket";
import { BasketPanel } from "../components/BasketPanel";
import { ItemDialog } from "../components/ItemDialog";
import { formatDelivery, formatMinutes, formatMoney } from "../components/money";
import { minPrice } from "../components/modifiers";
import { loadAddress } from "./address";

/**
 * Меню ресторана для клиента (CAT-2, CAT-3).
 *
 * Клиенту приходит только то, что можно заказать: блюда из стоп-листа
 * каталог не отдаёт (CAT-4), и в меню они просто исчезают. Поэтому здесь
 * нет «серых» недоступных блюд — показывать то, что нельзя купить,
 * значит раздражать клиента.
 *
 * Условия доставки (стоимость, минимальная сумма) зависят от зоны,
 * в которую попал адрес, поэтому берутся из выдачи «рестораны по адресу».
 */

interface LocationState {
  restaurant?: RestaurantSummary;
}

function matches(item: MenuItem, filter: string): boolean {
  if (!filter) return true;
  const haystack = `${item.name} ${item.composition ?? ""} ${item.description ?? ""}`.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Сведения о ресторане: из перехода с витрины, иначе — из выдачи по адресу или общего списка. */
function useRestaurant(restaurantId: string, fromLink: RestaurantSummary | undefined) {
  const address = loadAddress();
  const nearby = useQuery<{ restaurantsNearby: RestaurantSummary[] }>(RESTAURANTS_NEARBY, {
    variables: { latitude: address?.latitude ?? 0, longitude: address?.longitude ?? 0 },
    skip: !!fromLink || !address,
  });
  const listed = useQuery<{ restaurants: { items: RestaurantSummary[] } }>(RESTAURANTS, {
    // Каталог отдаёт не больше 50 ресторанов за раз; для прототипа
    // этого достаточно, чтобы найти название по прямой ссылке.
    variables: { page: 1, pageSize: 50 },
    skip: !!fromLink || !!nearby.data?.restaurantsNearby.some((r) => r.id === restaurantId),
  });

  return (
    fromLink ??
    nearby.data?.restaurantsNearby.find((restaurant) => restaurant.id === restaurantId) ??
    listed.data?.restaurants.items.find((restaurant) => restaurant.id === restaurantId) ??
    null
  );
}

function Dish({ item, onChoose }: { item: MenuItem; onChoose: () => void }) {
  const hasOptions = item.optionGroups.length > 0;
  return (
    <article className="item">
      {item.imageUrl ? (
        <img className="dish-image" src={item.imageUrl} alt="" loading="lazy" />
      ) : null}
      <div className="item__body">
        <div className="item__name">{item.name}</div>
        {(item.description || item.composition) && (
          <div className="item__note item__note--clamp">{item.description ?? item.composition}</div>
        )}
        <div className="item__note">
          {[
            item.weightGrams ? `${item.weightGrams} г` : null,
            item.calories ? `${item.calories} ккал` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <div className="item__aside">
        <span className="price">
          {hasOptions ? `от ${formatMoney(minPrice(item))}` : formatMoney(item.price)}
        </span>
        <button type="button" className="small" onClick={onChoose}>
          {hasOptions ? "Выбрать" : "В корзину"}
        </button>
      </div>
    </article>
  );
}

export function RestaurantMenuPage() {
  const { restaurantId = "" } = useParams();
  const location = useLocation();
  const restaurant = useRestaurant(
    restaurantId,
    (location.state as LocationState | null)?.restaurant,
  );
  const basket = useBasket();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<MenuItem | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const menu = useQuery<{ menu: { categories: MenuSection[] } }>(MENU, {
    variables: { restaurantId, includeUnavailable: false },
  });

  const sections = useMemo(
    () =>
      (menu.data?.menu.categories ?? [])
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => matches(item, filter)),
        }))
        .filter((section) => section.items.length > 0),
    [menu.data, filter],
  );

  const name = restaurant?.name ?? "Меню ресторана";
  // Условия зоны известны, только если ресторан найден по адресу клиента.
  const terms = restaurant?.zone
    ? { deliveryFee: restaurant.deliveryFee, minOrderAmount: restaurant.minOrderAmount }
    : null;

  const addToBasket = (
    item: MenuItem,
    line: {
      quantity: number;
      selections: Array<{ groupId: string; optionIds: string[] }>;
      optionNames: string[];
      unitPrice: number;
    },
  ) => {
    const target = { id: restaurantId, name };
    const entry = { itemId: item.id, name: item.name, ...line };
    if (!basket.add(target, entry)) {
      const replace = window.confirm(
        `В корзине блюда из «${basket.restaurantName}». Привезти заказ из двух ресторанов одним курьером нельзя. Начать новую корзину?`,
      );
      if (!replace) return;
      basket.add(target, entry, true);
    }
    setOpen(null);
    setAdded(item.name);
    window.setTimeout(() => setAdded(null), 2500);
  };

  const choose = (item: MenuItem) => {
    if (item.optionGroups.length === 0) {
      addToBasket(item, { quantity: 1, selections: [], optionNames: [], unitPrice: item.price });
    } else {
      setOpen(item);
    }
  };

  return (
    <main className="page page--wide">
      <p className="page__crumbs">
        <Link to="/">← Все рестораны</Link>
      </p>
      <h1 className="page__title">{name}</h1>
      {restaurant && (
        <p className="restaurant__meta restaurant__meta--header">
          {terms ? (
            <>
              <span>{formatDelivery(terms.deliveryFee)}</span>
              <span>заказ от {formatMoney(terms.minOrderAmount)}</span>
            </>
          ) : (
            <span>Условия доставки зависят от адреса</span>
          )}
          <span>готовят ~{formatMinutes(restaurant.avgCookingTimeMin)}</span>
        </p>
      )}

      <div className="menu-layout">
        <div className="menu-layout__main">
          {menu.loading && !menu.data && <p className="notice notice--quiet">Загружаем меню…</p>}
          {menu.error && <p className="notice notice--error">{errorText(menu.error)}</p>}

          {menu.data && (
            <>
              <div className="menu-tools">
                <input
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Найти блюдо: «сыр», «острый»…"
                  aria-label="Поиск по меню"
                />
                <nav className="chips" aria-label="Разделы меню">
                  {sections.map((section) => (
                    <a key={section.id} className="chip" href={`#section-${section.id}`}>
                      {section.name}
                    </a>
                  ))}
                </nav>
              </div>

              {sections.length === 0 && (
                <p className="notice notice--quiet">
                  {filter
                    ? "Ничего не нашлось — попробуйте другое слово."
                    : "В меню пока ничего нет."}
                </p>
              )}

              {sections.map((section) => (
                <section key={section.id} id={`section-${section.id}`} className="menu-section">
                  <h2 className="section__title">{section.name}</h2>
                  {section.items.map((item) => (
                    <Dish key={item.id} item={item} onChoose={() => choose(item)} />
                  ))}
                </section>
              ))}
            </>
          )}
        </div>

        <div className="menu-layout__side" id="basket">
          <BasketPanel
            terms={basket.restaurantId === restaurantId || basket.lines.length === 0 ? terms : null}
          />
        </div>
      </div>

      {basket.count > 0 && (
        <a className="basket-bar" href="#basket">
          <span>Корзина · {basket.count}</span>
          <span className="price">{formatMoney(basket.itemsAmount)}</span>
        </a>
      )}

      {added && (
        <p className="toast" role="status">
          «{added}» в корзине
        </p>
      )}

      {open && (
        <ItemDialog
          item={open}
          onAdd={(line) => addToBasket(open, line)}
          onClose={() => setOpen(null)}
        />
      )}
    </main>
  );
}
