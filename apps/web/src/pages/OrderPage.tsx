import { useEffect } from "react";
import { useMutation, useQuery } from "@apollo/client";
import { Link, useLocation, useParams } from "react-router-dom";
import { errorText } from "../api/client";
import { CANCEL_ORDER, ORDER, type Order, type OrderTransition } from "../api/queries";
import { formatMinutes, formatMoney } from "../components/money";
import {
  CLIENT_STEPS,
  cancelText,
  formatTime,
  isFinished,
  statusText,
  stepIndex,
} from "../components/orderStatus";

/** Как часто экран переспрашивает статус, пока заказ в работе. */
const POLL_MS = 3_000;

/** Ожидаемое время доставки: готовка от подтверждения плюс дорога. */
function expectedBy(order: Order): string | null {
  if (!order.confirmedAt || !order.expectedCookingMin) return null;
  const at = new Date(order.confirmedAt).getTime() + order.expectedCookingMin * 60_000;
  return new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Отслеживание заказа (TRK-1) и отмена до начала готовки (ORD-5).
 *
 * Пока заказ в работе, экран переспрашивает статус раз в несколько секунд.
 * Это временное решение итерации 2: в итерации 3 статусы будут приходить
 * подпиской по WebSocket (NTF-1), и опрос уйдёт. Опрос останавливается,
 * как только заказ доставлен или отменён, — дальше статус не меняется.
 *
 * Кнопка «Отменить» показывается по признаку из сервиса заказов, а не по
 * списку статусов здесь: правило ORD-5 живёт в одном месте.
 */
export function OrderPage() {
  const { orderId = "" } = useParams();
  const location = useLocation();
  const justPlaced = (location.state as { justPlaced?: boolean } | null)?.justPlaced;

  const query = useQuery<{ order: Order; orderTransitions: OrderTransition[] }>(ORDER, {
    variables: { id: orderId },
    pollInterval: POLL_MS,
    // Статус берётся с сервера при каждом опросе, а не из кэша.
    fetchPolicy: "network-only",
    nextFetchPolicy: "network-only",
  });
  const [cancel, cancelling] = useMutation(CANCEL_ORDER);

  const order = query.data?.order;
  const finished = order ? isFinished(order.status) : false;
  const { stopPolling } = query;
  useEffect(() => {
    if (finished) stopPolling();
  }, [finished, stopPolling]);

  if (query.loading && !query.data) {
    return (
      <main className="page page--narrow">
        <p className="notice notice--quiet">Загружаем заказ…</p>
      </main>
    );
  }
  if (!order) {
    return (
      <main className="page page--narrow">
        <p className="notice notice--error">
          {query.error ? errorText(query.error) : "Заказ не найден"}
        </p>
        <Link to="/orders">← Мои заказы</Link>
      </main>
    );
  }

  const current = stepIndex(order.status);
  const cancelled = order.status === "CANCELLED";
  const eta = expectedBy(order);

  const confirmCancel = async () => {
    if (!window.confirm("Отменить заказ? Замороженные деньги вернутся на карту.")) return;
    try {
      await cancel({ variables: { id: order.id, reason: null } });
      await query.refetch();
    } catch {
      // Текст ошибки показывает состояние мутации
    }
  };

  return (
    <main className="page page--narrow">
      <p className="page__crumbs">
        <Link to="/orders">← Мои заказы</Link>
      </p>
      <h1 className="page__title">
        Заказ №{order.orderNumber}
        {order.restaurant && <span className="page__subtitle"> · {order.restaurant.name}</span>}
      </h1>

      {/* Пока заказ не принят рестораном: дальше подсказка только мешает. */}
      {justPlaced && current >= 0 && current <= 1 && (
        <p className="notice notice--ok" role="status">
          Заказ оформлен. Мы заморозили сумму на карте и передадим заказ ресторану.
        </p>
      )}

      <section className="card">
        <p className="order-status">{statusText(order.status)}</p>
        {cancelled ? (
          <p className="notice notice--error">
            {cancelText(order.cancelReason)}
            {order.cancelComment ? ` — ${order.cancelComment}` : ""}. Замороженные или уже списанные
            деньги вернутся на карту.
          </p>
        ) : (
          <ol className="steps" aria-label="Ход заказа">
            {CLIENT_STEPS.map((step, index) => (
              <li
                key={step.key}
                className={`steps__item ${
                  index < current
                    ? "steps__item--done"
                    : index === current
                      ? "steps__item--now"
                      : ""
                }`}
                aria-current={index === current ? "step" : undefined}
              >
                {step.title}
              </li>
            ))}
          </ol>
        )}
        {eta && !finished && (
          <p className="item__note">
            Ресторан готовит {formatMinutes(order.expectedCookingMin ?? 0)} — будет готово примерно
            к {eta}
          </p>
        )}
        {!finished && <p className="item__note">Статус обновляется автоматически.</p>}

        {order.canCancel && (
          <button
            type="button"
            className="secondary"
            onClick={() => void confirmCancel()}
            disabled={cancelling.loading}
          >
            {cancelling.loading ? "Отменяем…" : "Отменить заказ"}
          </button>
        )}
        {cancelling.error && (
          <p className="notice notice--error" role="alert">
            {errorText(cancelling.error)}
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="section__title">Состав</h2>
        <ul className="basket__lines">
          {order.lines.map((line) => (
            <li
              key={`${line.menuItemId}-${line.options.map((o) => o.optionId).join(",")}`}
              className="basket__line"
            >
              <div className="basket__line-body">
                <span>
                  {line.name} × {line.quantity}
                </span>
                {line.options.length > 0 && (
                  <span className="item__note">{line.options.map((o) => o.name).join(", ")}</span>
                )}
              </div>
              <span className="price">{formatMoney(line.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <dl className="basket__totals">
          <dt>Блюда</dt>
          <dd className="price">{formatMoney(order.amounts.items)}</dd>
          <dt>Доставка</dt>
          <dd className="price">
            {order.amounts.delivery === 0 ? "бесплатно" : formatMoney(order.amounts.delivery)}
          </dd>
          {order.amounts.service > 0 && (
            <>
              <dt>Сервисный сбор</dt>
              <dd className="price">{formatMoney(order.amounts.service)}</dd>
            </>
          )}
          <dt className="basket__total">Итого</dt>
          <dd className="price basket__total">{formatMoney(order.amounts.total)}</dd>
        </dl>
        <p className="item__note">
          {order.addressText}
          {order.comment ? ` · ${order.comment}` : ""}
        </p>
      </section>

      {query.data && query.data.orderTransitions.length > 0 && (
        <section className="card">
          <h2 className="section__title">История</h2>
          <ul className="timeline">
            {query.data.orderTransitions.map((transition) => (
              <li key={`${transition.to}-${transition.at}`} className="timeline__item">
                <span>{statusText(transition.to)}</span>
                <span className="item__note">{formatTime(transition.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
