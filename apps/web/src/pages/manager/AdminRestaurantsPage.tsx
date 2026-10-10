import { useState } from "react";
import { useMutation, useQuery } from "@apollo/client";
import { Link } from "react-router-dom";
import { errorText } from "../../api/client";
import {
  REGISTER_RESTAURANT,
  RESTAURANTS,
  UPDATE_RESTAURANT,
  type RestaurantDetails,
  type RestaurantSummary,
} from "../../api/queries";
import { formatMinutes, formatMoney, parseMoney } from "../../components/money";

interface Form {
  name: string;
  phone: string;
  addressText: string;
  latitude: string;
  longitude: string;
  minOrderAmount: string;
  deliveryFeeBase: string;
  avgCookingTimeMin: string;
}

const EMPTY: Form = {
  name: "",
  phone: "",
  addressText: "",
  latitude: "",
  longitude: "",
  minOrderAmount: "500",
  deliveryFeeBase: "150",
  avgCookingTimeMin: "30",
};

const LIST = { query: RESTAURANTS, variables: { page: 1, pageSize: 50 } };

/**
 * Регистрация ресторанов администратором (ADM-2).
 *
 * Именно администратор площадки, а не сам ресторан: в каталоге не должно
 * появляться заведений, с которыми нет договора. После регистрации
 * ресторану нужна зона доставки — без неё его не увидит ни один клиент.
 *
 * Ресторан не удаляется, а закрывается: по нему есть история заказов.
 * Закрытый ресторан пропадает из выдачи клиентам.
 */
export function AdminRestaurantsPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const restaurants = useQuery<{ restaurants: { items: RestaurantSummary[]; total: number } }>(
    RESTAURANTS,
    { variables: LIST.variables },
  );
  const [register, registering] = useMutation<{ registerRestaurant: RestaurantDetails }>(
    REGISTER_RESTAURANT,
    { refetchQueries: [LIST] },
  );
  const [update] = useMutation(UPDATE_RESTAURANT, { refetchQueries: [LIST] });

  const set = (field: keyof Form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    const minOrderAmount = parseMoney(form.minOrderAmount);
    const deliveryFeeBase = parseMoney(form.deliveryFeeBase);
    const avgCookingTimeMin = Number(form.avgCookingTimeMin);
    const hasLocation = form.latitude.trim() !== "" || form.longitude.trim() !== "";
    const latitude = Number(form.latitude.replace(",", "."));
    const longitude = Number(form.longitude.replace(",", "."));

    if (!form.name.trim()) return setMessage({ ok: false, text: "Укажите название" });
    if (minOrderAmount === null || deliveryFeeBase === null) {
      return setMessage({ ok: false, text: "Суммы — числа в рублях" });
    }
    if (!Number.isInteger(avgCookingTimeMin) || avgCookingTimeMin < 1) {
      return setMessage({ ok: false, text: "Время готовки — целое число минут" });
    }
    if (hasLocation && (!Number.isFinite(latitude) || !Number.isFinite(longitude))) {
      return setMessage({ ok: false, text: "Координаты — числа: широта и долгота" });
    }

    try {
      const result = await register({
        variables: {
          input: {
            name: form.name.trim(),
            ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
            ...(form.addressText.trim() ? { addressText: form.addressText.trim() } : {}),
            ...(hasLocation ? { location: { latitude, longitude } } : {}),
            minOrderAmount,
            deliveryFeeBase,
            avgCookingTimeMin,
          },
        },
      });
      setMessage({
        ok: true,
        text: `Ресторан «${result.data?.registerRestaurant.name}» зарегистрирован. Нарисуйте ему зону доставки — без неё его не увидит ни один клиент.`,
      });
      setForm(EMPTY);
    } catch (failure) {
      setMessage({ ok: false, text: errorText(failure) });
    }
  };

  const close = async (restaurant: RestaurantSummary) => {
    if (!window.confirm(`Закрыть «${restaurant.name}»? Он пропадёт из выдачи клиентам.`)) return;
    setMessage(null);
    try {
      await update({
        variables: {
          restaurantId: restaurant.id,
          input: { name: restaurant.name },
          isActive: false,
        },
      });
      setMessage({ ok: true, text: `«${restaurant.name}» закрыт` });
    } catch (failure) {
      setMessage({ ok: false, text: errorText(failure) });
    }
  };

  return (
    <main className="page">
      <h1 className="page__title">Рестораны</h1>
      <p className="page__hint">Регистрация заведений, с которыми заключён договор.</p>
      {message && (
        <p className={`notice ${message.ok ? "notice--ok" : "notice--error"}`} role="status">
          {message.text}
          {message.ok && message.text.includes("зарегистрирован") && (
            <>
              {" "}
              <Link to="/manage/zone">Перейти к зонам доставки →</Link>
            </>
          )}
        </p>
      )}

      <form className="card form" onSubmit={submit}>
        <h2 className="editor__title">Новый ресторан</h2>
        <div className="row">
          <div className="field">
            <label className="field__label" htmlFor="r-name">
              Название
            </label>
            <input id="r-name" value={form.name} onChange={set("name")} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="r-phone">
              Телефон
            </label>
            <input id="r-phone" type="tel" value={form.phone} onChange={set("phone")} />
          </div>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="r-address">
            Адрес
          </label>
          <input id="r-address" value={form.addressText} onChange={set("addressText")} />
        </div>
        <div className="row">
          <div className="field">
            <label className="field__label" htmlFor="r-lat">
              Широта — точка выдачи курьеру
            </label>
            <input
              id="r-lat"
              inputMode="decimal"
              value={form.latitude}
              onChange={set("latitude")}
              placeholder="55.7558"
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="r-lon">
              Долгота
            </label>
            <input
              id="r-lon"
              inputMode="decimal"
              value={form.longitude}
              onChange={set("longitude")}
              placeholder="37.6176"
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label className="field__label" htmlFor="r-min">
              Заказ от, ₽
            </label>
            <input
              id="r-min"
              inputMode="decimal"
              value={form.minOrderAmount}
              onChange={set("minOrderAmount")}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="r-fee">
              Доставка, ₽
            </label>
            <input
              id="r-fee"
              inputMode="decimal"
              value={form.deliveryFeeBase}
              onChange={set("deliveryFeeBase")}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="r-cook">
              Готовят, мин
            </label>
            <input
              id="r-cook"
              inputMode="numeric"
              value={form.avgCookingTimeMin}
              onChange={set("avgCookingTimeMin")}
            />
          </div>
        </div>
        <button type="submit" disabled={registering.loading}>
          {registering.loading ? "Регистрируем…" : "Зарегистрировать"}
        </button>
      </form>

      <h2 className="section__title">
        Действующие рестораны
        {restaurants.data ? ` · ${restaurants.data.restaurants.total}` : ""}
      </h2>
      {restaurants.error && <p className="notice notice--error">{errorText(restaurants.error)}</p>}
      {restaurants.data?.restaurants.items.map((restaurant) => (
        <article key={restaurant.id} className="item">
          <div className="item__body">
            <div className="item__name">{restaurant.name}</div>
            <div className="item__note">
              доставка {formatMoney(restaurant.deliveryFee)} · от{" "}
              {formatMoney(restaurant.minOrderAmount)} · готовят ~
              {formatMinutes(restaurant.avgCookingTimeMin)}
            </div>
          </div>
          <div className="item__aside">
            <button
              type="button"
              className="secondary small"
              onClick={() => void close(restaurant)}
            >
              Закрыть
            </button>
          </div>
        </article>
      ))}
    </main>
  );
}
