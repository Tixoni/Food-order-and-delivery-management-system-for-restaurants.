import { useState } from "react";
import { useQuery } from "@apollo/client";
import { Link } from "react-router-dom";
import { errorText } from "../api/client";
import { RESTAURANTS, RESTAURANTS_NEARBY, type RestaurantSummary } from "../api/queries";
import { formatDelivery, formatMinutes, formatMoney } from "../components/money";
import { clearAddress, loadAddress, saveAddress, type Address } from "./address";

/**
 * Витрина клиента — требование CAT-1.
 *
 * Клиент вводит адрес и видит рестораны, которые по нему доставляют,
 * вместе с условиями именно той зоны, в которую адрес попал.
 *
 * Перевод адреса в координаты (геокодирование) выполняется здесь,
 * а не в сервисе: карта и справочник адресов уже есть в браузере,
 * и держать в сервисе второй справочник незачем. Сервис работает
 * с координатами — они однозначны, в отличие от текста адреса.
 */

/** Несколько заранее заданных адресов: на защите некогда искать адрес. */
const SAMPLE_ADDRESSES = [
  { label: "Тверская, центр", latitude: 55.7615, longitude: 37.6094 },
  { label: "Арбат", latitude: 55.7494, longitude: 37.5914 },
  { label: "Сокольники", latitude: 55.7887, longitude: 37.6799 },
  { label: "Университет", latitude: 55.6925, longitude: 37.5346 },
];

/** Поиск адреса по названию: открытая служба OpenStreetMap. */
async function geocode(query: string): Promise<Address | null> {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ru&q=" +
    encodeURIComponent(query);

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;

  const [found] = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;

  return found
    ? {
        label: found.display_name.split(",").slice(0, 3).join(", "),
        latitude: Number(found.lat),
        longitude: Number(found.lon),
      }
    : null;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function RestaurantCard({ restaurant }: { restaurant: RestaurantSummary }) {
  return (
    // Сведения о ресторане и условия зоны передаются в меню вместе с переходом:
    // запрашивать их там заново незачем.
    <Link to={`/restaurants/${restaurant.id}`} state={{ restaurant }} className="restaurant">
      <span className="restaurant__name">{restaurant.name}</span>
      <span className="restaurant__meta">
        <span>{capitalize(formatDelivery(restaurant.deliveryFee))}</span>
        <span>от {formatMoney(restaurant.minOrderAmount)}</span>
        <span>готовят ~{formatMinutes(restaurant.avgCookingTimeMin)}</span>
      </span>
    </Link>
  );
}

export function StorefrontPage() {
  const [address, setAddress] = useState<Address | null>(loadAddress);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const chooseAddress = (next: Address) => {
    setAddress(next);
    setSearchError(null);
    saveAddress(next);
  };

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 3) {
      setSearchError("Введите адрес подробнее: улицу и номер дома");
      return;
    }

    setSearching(true);
    setSearchError(null);
    try {
      const found = await geocode(query);
      if (found) chooseAddress(found);
      else setSearchError("Такой адрес не найден. Попробуйте написать иначе");
    } catch {
      setSearchError("Не удалось определить адрес: проверьте подключение");
    } finally {
      setSearching(false);
    }
  };

  const nearby = useQuery<{ restaurantsNearby: RestaurantSummary[] }>(RESTAURANTS_NEARBY, {
    variables: { latitude: address?.latitude ?? 0, longitude: address?.longitude ?? 0 },
    skip: !address,
  });

  // Пока адрес не указан, показывается общий список: пустой экран
  // с одним полем ввода не объясняет, что вообще есть в системе.
  const all = useQuery<{ restaurants: { items: RestaurantSummary[]; total: number } }>(
    RESTAURANTS,
    { variables: { page: 1, pageSize: 12 }, skip: !!address },
  );

  const restaurants = address ? nearby.data?.restaurantsNearby : all.data?.restaurants.items;
  const loading = address ? nearby.loading : all.loading;
  const failure = address ? nearby.error : all.error;

  return (
    <main className="page">
      <h1 className="page__title">Куда доставить?</h1>
      <p className="page__hint">
        Покажем рестораны, которые доставляют по вашему адресу, со стоимостью доставки и минимальной
        суммой заказа.
      </p>

      <form className="card form" onSubmit={search}>
        <div className="row">
          <div className="field" style={{ flex: "1 1 18rem" }}>
            <label className="field__label" htmlFor="address">
              Адрес доставки
            </label>
            <input
              id="address"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Москва, ул. Тверская, 7"
              autoComplete="street-address"
            />
          </div>
          <button type="submit" disabled={searching}>
            {searching ? "Ищем…" : "Найти"}
          </button>
        </div>

        <div className="row" style={{ gap: "0.375rem" }}>
          {SAMPLE_ADDRESSES.map((sample) => (
            <button
              key={sample.label}
              type="button"
              className="secondary small"
              onClick={() => chooseAddress(sample)}
            >
              {sample.label}
            </button>
          ))}
        </div>

        {searchError && <p className="notice notice--error">{searchError}</p>}
      </form>

      {address && (
        <p className="page__hint" style={{ marginTop: "1rem" }}>
          Доставка по адресу: <strong>{address.label}</strong>{" "}
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              setAddress(null);
              clearAddress();
            }}
          >
            изменить
          </button>
        </p>
      )}

      {loading && <p className="notice notice--quiet">Загружаем рестораны…</p>}
      {failure && <p className="notice notice--error">{errorText(failure)}</p>}

      {restaurants && restaurants.length === 0 && (
        <p className="notice notice--quiet">
          По этому адресу пока никто не доставляет. Попробуйте другой адрес — зоны доставки у
          ресторанов разные.
        </p>
      )}

      {restaurants && restaurants.length > 0 && (
        <>
          <h2 className="section__title">
            {address ? `Доставляют сюда: ${restaurants.length}` : "Все рестораны"}
          </h2>
          <div className="grid">
            {restaurants.map((restaurant) => (
              <RestaurantCard key={restaurant.id} restaurant={restaurant} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}
