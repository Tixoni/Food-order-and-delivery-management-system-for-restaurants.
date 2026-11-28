import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@apollo/client";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { errorText } from "../api/client";
import {
  PLACE_ORDER,
  RESTAURANTS_NEARBY,
  type Order,
  type RestaurantSummary,
} from "../api/queries";
import { useBasket, type BasketLine } from "../cart/basket";
import { formatMoney } from "../components/money";
import { AddressMapPicker } from "../components/AddressMapPicker";
import { loadAddress, saveAddress } from "./address";
import { TestOrderButton, TEST_ADDRESS, TEST_DETAILS } from "../components/TestOrderButton";

/**
 * Оформление заказа (ORD-1).
 *
 * Сумма на этой странице — предварительная: цены, наличие блюд, часы
 * работы и зону доставки сервер проверит заново в момент оформления
 * (ORD-2) и посчитает итог сам. Поэтому из браузера уходит только выбор —
 * блюда, количество, модификаторы, — а не цены.
 *
 * Повторное нажатие «Оформить» или обновление страницы не создаёт второй
 * заказ (ORD-4): ключ идемпотентности создаётся один раз на эту корзину
 * и живёт до успешного оформления. Новая корзина — новый ключ.
 */

const KEY_STORAGE = "fd:checkout-key";
const PHONE = /^(?:\+7[0-9]{10}|[78][0-9]{10}|[0-9]{10})$/;

/** Подпись корзины: изменился выбор — это уже другой заказ и другой ключ. */
function signatureOf(restaurantId: string | null, lines: BasketLine[]): string {
  return `${restaurantId}|${lines.map((line) => `${line.key}x${line.quantity}`).join(",")}`;
}

function checkoutKey(signature: string): string {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY_STORAGE) ?? "null") as {
      signature: string;
      key: string;
    } | null;
    if (saved?.signature === signature) return saved.key;
    const key = crypto.randomUUID();
    sessionStorage.setItem(KEY_STORAGE, JSON.stringify({ signature, key }));
    return key;
  } catch {
    // Без хранилища ключ живёт до перезагрузки страницы — двойное нажатие
    // всё равно не создаст двух заказов.
    return crypto.randomUUID();
  }
}

function forgetKey(): void {
  try {
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    // см. checkoutKey
  }
}

export function CheckoutPage() {
  const basket = useBasket();
  const navigate = useNavigate();
  const location = useLocation();
  const [address, setAddress] = useState(loadAddress);
  const [apartment, setApartment] = useState("");
  const [entrance, setEntrance] = useState("");
  const [floor, setFloor] = useState("");
  const [phone, setPhone] = useState("");
  const [comment, setComment] = useState("");
  const [touched, setTouched] = useState(false);
  const fillTestDetails = () => {
    setAddress(TEST_ADDRESS);
    setApartment(TEST_DETAILS.apartment);
    setEntrance(TEST_DETAILS.entrance);
    setFloor(TEST_DETAILS.floor);
    setPhone(TEST_DETAILS.phone);
    setComment(TEST_DETAILS.comment);
    setTouched(false);
  };
  useEffect(() => {
    if (
      (location.state as { testOrder?: boolean } | null)?.testOrder ||
      sessionStorage.getItem("fd:test-order") === "1"
    ) {
      fillTestDetails();
      sessionStorage.removeItem("fd:test-order");
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate]);
  const chooseAddress = (next: NonNullable<typeof address>) => {
    setAddress(next);
    saveAddress(next);
  };

  const signature = signatureOf(basket.restaurantId, basket.lines);
  const idempotencyKey = useMemo(() => checkoutKey(signature), [signature]);

  // Условия доставки — той зоны, в которую попал адрес клиента.
  const nearby = useQuery<{ restaurantsNearby: RestaurantSummary[] }>(RESTAURANTS_NEARBY, {
    variables: { latitude: address?.latitude ?? 0, longitude: address?.longitude ?? 0 },
    skip: !address,
  });
  const offer = nearby.data?.restaurantsNearby.find((r) => r.id === basket.restaurantId);

  const [place, placing] = useMutation<{ placeOrder: { replayed: boolean; order: Order } }>(
    PLACE_ORDER,
  );

  if (basket.lines.length === 0) {
    return (
      <main className="page page--narrow">
        <h1 className="page__title">Оформление заказа</h1>
        <p className="notice notice--quiet">
          Корзина пуста. <Link to="/">Выбрать ресторан</Link>
        </p>
        <TestOrderButton onPrepared={fillTestDetails} />
      </main>
    );
  }

  if (!address) {
    return (
      <main className="page page--narrow">
        <h1 className="page__title">Оформление заказа</h1>
        <p className="notice notice--quiet">
          Сначала укажите адрес доставки <Link to="/">на витрине</Link> — от него зависят стоимость
          доставки и минимальная сумма заказа.
        </p>
        <AddressMapPicker address={null} onChoose={chooseAddress} />
      </main>
    );
  }

  const cleanPhone = phone.trim();
  const phoneValid = cleanPhone.length <= 32 && PHONE.test(cleanPhone.replace(/[ ()-]/g, ""));
  const apartmentValid =
    !apartment.trim() || /^[\p{L}\d][\p{L}\d/-]{0,15}$/u.test(apartment.trim());
  const entranceValid = !entrance.trim() || /^[\p{L}\d][\p{L}\d-]{0,7}$/u.test(entrance.trim());
  const floorValid = !floor.trim() || /^-?\d{1,3}$/.test(floor.trim());
  const shortfall = offer ? Math.max(0, offer.minOrderAmount - basket.itemsAmount) : 0;
  const notDelivering = nearby.data && !offer;
  // Телефон проверяется при нажатии, а не блокирует кнопку: иначе клиент
  // не поймёт, почему кнопка не нажимается.
  const canSubmit = !!offer && shortfall === 0 && !placing.loading;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit || !basket.restaurantId) return;
    if (!apartmentValid || !entranceValid || !floorValid || !phoneValid) {
      const invalidField = !apartmentValid
        ? "apartment"
        : !entranceValid
          ? "entrance"
          : !floorValid
            ? "floor"
            : "phone";
      (event.currentTarget.elements.namedItem(invalidField) as HTMLInputElement | null)?.focus();
      return;
    }

    const text = [
      address.label,
      apartment.trim() && `кв./офис ${apartment.trim()}`,
      entrance.trim() && `подъезд ${entrance.trim()}`,
      floor.trim() && `этаж ${floor.trim()}`,
    ]
      .filter(Boolean)
      .join(", ");
    try {
      const result = await place({
        variables: {
          input: {
            restaurantId: basket.restaurantId,
            idempotencyKey,
            address: { text, latitude: address.latitude, longitude: address.longitude },
            contactPhone: cleanPhone,
            comment: comment.trim() || null,
            items: basket.lines.map((line) => ({
              itemId: line.itemId,
              quantity: line.quantity,
              selections: line.selections,
            })),
          },
        },
      });
      const order = result.data?.placeOrder.order;
      if (!order) return;
      forgetKey();
      basket.clear();
      navigate(`/orders/${order.id}`, { replace: true, state: { justPlaced: true } });
    } catch {
      // Текст ошибки показывает состояние мутации
    }
  };

  return (
    <main className="page page--checkout">
      <p className="page__crumbs">
        <Link to={`/restaurants/${basket.restaurantId}`}>← {basket.restaurantName}</Link>
      </p>
      <h1 className="page__title">Оформление заказа</h1>
      <p className="page__hint">Проверьте адрес и контакт перед отправкой на кухню.</p>
      <TestOrderButton onPrepared={fillTestDetails} />

      <form className="checkout" onSubmit={submit} noValidate>
        <section className="card form">
          <h2 className="section__title">Куда доставить</h2>
          <p className="checkout__address">{address.label}</p>
          <AddressMapPicker address={address} onChoose={chooseAddress} />
          <div className="checkout__details">
            {(
              [
                [
                  "apartment",
                  "Квартира или офис",
                  apartment,
                  setApartment,
                  apartmentValid,
                  "Например, 42 или 42А",
                ],
                ["entrance", "Подъезд", entrance, setEntrance, entranceValid, "Например, 2"],
                ["floor", "Этаж", floor, setFloor, floorValid, "Укажите целое число"],
              ] as const
            ).map(([id, label, value, setValue, valid, help]) => (
              <div className="field" key={id}>
                <label className="field__label" htmlFor={id}>
                  {label}
                </label>
                <input
                  id={id}
                  name={id}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  onBlur={() => {
                    if (value.trim() && !valid) setTouched(true);
                  }}
                  aria-invalid={touched && !valid}
                  aria-describedby={touched && !valid ? `${id}-error` : undefined}
                />
                {touched && !valid && (
                  <span id={`${id}-error`} className="checkout__problem">
                    {help}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="phone">
              Телефон для курьера
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="+7 900 000-00-00"
              autoComplete="tel"
              required
              aria-invalid={touched && !phoneValid}
              aria-describedby={touched && !phoneValid ? "phone-error" : undefined}
            />
            {touched && !phoneValid && (
              <span id="phone-error" className="item__note checkout__problem">
                Укажите номер телефона, например +7 900 000-00-00.
              </span>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="comment">
              Комментарий
            </label>
            <textarea
              id="comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Например: без лука, позвонить заранее"
            />
          </div>
        </section>

        <section className="card checkout__summary">
          <h2 className="section__title">Заказ в «{basket.restaurantName}»</h2>
          <ul className="basket__lines">
            {basket.lines.map((line) => (
              <li key={line.key} className="basket__line">
                <div className="basket__line-body">
                  <span>
                    {line.name} × {line.quantity}
                  </span>
                  {line.optionNames.length > 0 && (
                    <span className="item__note">{line.optionNames.join(", ")}</span>
                  )}
                </div>
                <span className="price">{formatMoney(line.unitPrice * line.quantity)}</span>
              </li>
            ))}
          </ul>
          <dl className="basket__totals">
            <dt>Блюда</dt>
            <dd className="price">{formatMoney(basket.itemsAmount)}</dd>
            {offer && (
              <>
                <dt>Доставка</dt>
                <dd className="price">
                  {offer.deliveryFee === 0 ? "бесплатно" : formatMoney(offer.deliveryFee)}
                </dd>
              </>
            )}
            <dt className="basket__total">Итого, примерно</dt>
            <dd className="price basket__total">
              {formatMoney(basket.itemsAmount + (offer?.deliveryFee ?? 0))}
            </dd>
          </dl>
          <p className="item__note">
            Точную сумму посчитает ресторан по актуальным ценам. Деньги сначала замораживаются на
            карте и списываются, только когда ресторан примет заказ.
          </p>

          {nearby.loading && !nearby.data && (
            <p className="notice notice--quiet">Проверяем условия доставки…</p>
          )}
          {nearby.error && (
            <p className="notice notice--error" role="alert">
              {errorText(nearby.error)}
            </p>
          )}
          {notDelivering && (
            <p className="notice notice--error">
              «{basket.restaurantName}» не доставляет по этому адресу. Выберите другой ресторан или
              адрес.
            </p>
          )}
          {offer && shortfall > 0 && (
            <p className="notice notice--quiet">
              До минимальной суммы заказа не хватает <strong>{formatMoney(shortfall)}</strong>
            </p>
          )}
          {placing.error && (
            <p className="notice notice--error" role="alert">
              {errorText(placing.error)}
            </p>
          )}

          <button type="submit" className="checkout__submit" disabled={!canSubmit}>
            {placing.loading ? "Оформляем…" : "Оформить заказ"}
          </button>
        </section>
      </form>
    </main>
  );
}
