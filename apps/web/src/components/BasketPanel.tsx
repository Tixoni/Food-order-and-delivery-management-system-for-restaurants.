import { Link } from "react-router-dom";
import { useBasket } from "../cart/basket";
import { formatMoney } from "./money";

interface Props {
  /** Условия зоны доставки по адресу клиента, если адрес указан. */
  terms: { deliveryFee: number; minOrderAmount: number } | null;
}

/**
 * Корзина рядом с меню: что выбрано, сколько стоит, хватает ли до минимальной
 * суммы заказа (CART-2, CART-3).
 *
 * Итог здесь — предварительный: его пересчитает сервер по актуальным ценам
 * при оформлении. Поэтому подпись честно говорит «примерно», а не «к оплате».
 */
export function BasketPanel({ terms }: Props) {
  const basket = useBasket();
  if (basket.lines.length === 0) {
    return (
      <aside className="basket basket--empty" aria-label="Корзина">
        <p className="basket__title">Корзина пуста</p>
        <p className="item__note">Выберите блюдо — оно появится здесь.</p>
      </aside>
    );
  }

  const shortfall = terms ? Math.max(0, terms.minOrderAmount - basket.itemsAmount) : 0;
  const total = basket.itemsAmount + (terms?.deliveryFee ?? 0);

  return (
    <aside className="basket" aria-label="Корзина">
      <p className="basket__title">
        Корзина · {basket.restaurantName}
        <button type="button" className="secondary small basket__clear" onClick={basket.clear}>
          Очистить
        </button>
      </p>

      <ul className="basket__lines">
        {basket.lines.map((line) => (
          <li key={line.key} className="basket__line">
            <div className="basket__line-body">
              <span>{line.name}</span>
              {line.optionNames.length > 0 && (
                <span className="item__note">{line.optionNames.join(", ")}</span>
              )}
            </div>
            <div className="stepper" role="group" aria-label={`Количество: ${line.name}`}>
              <button
                type="button"
                className="secondary small"
                aria-label="Меньше"
                onClick={() => basket.setQuantity(line.key, line.quantity - 1)}
              >
                −
              </button>
              <span className="stepper__value">{line.quantity}</span>
              <button
                type="button"
                className="secondary small"
                aria-label="Больше"
                disabled={line.quantity >= 99}
                onClick={() => basket.setQuantity(line.key, line.quantity + 1)}
              >
                +
              </button>
            </div>
            <span className="price">{formatMoney(line.unitPrice * line.quantity)}</span>
          </li>
        ))}
      </ul>

      <dl className="basket__totals">
        <dt>Блюда</dt>
        <dd className="price">{formatMoney(basket.itemsAmount)}</dd>
        {terms && (
          <>
            <dt>Доставка</dt>
            <dd className="price">
              {terms.deliveryFee === 0 ? "бесплатно" : formatMoney(terms.deliveryFee)}
            </dd>
          </>
        )}
        <dt className="basket__total">Итого, примерно</dt>
        <dd className="price basket__total">{formatMoney(total)}</dd>
      </dl>

      {!terms && (
        <p className="notice notice--quiet">
          Укажите адрес на витрине — покажем стоимость доставки и минимальную сумму заказа.
        </p>
      )}
      {terms && shortfall > 0 && (
        <p className="notice notice--quiet">
          До минимальной суммы заказа не хватает <strong>{formatMoney(shortfall)}</strong>
        </p>
      )}
      {terms && shortfall === 0 && (
        <Link to="/checkout" className="button basket__checkout">
          Оформить заказ
        </Link>
      )}
    </aside>
  );
}
