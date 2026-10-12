import { useEffect, useState } from "react";
import { useMutation, useQuery, useSubscription } from "@apollo/client";
import { errorText } from "../api/client";
import {
  CONFIRM_ORDER,
  KITCHEN_QUEUE,
  KITCHEN_QUEUE_CHANGED,
  MARK_ORDER_READY,
  REJECT_ORDER,
  type Order,
} from "../api/queries";
import { formatMoney } from "../components/money";
import { formatTime } from "../components/orderStatus";
import { countdown, useNow } from "../components/useNow";

const COOKING_OPTIONS = [10, 15, 20, 30, 45];

/**
 * Экран кухни (KIT-1..5).
 *
 * Очередь приходит запросом, а изменения — подпиской по WebSocket: новый
 * заказ появляется сразу, без перезагрузки. Подписка не несёт самих
 * заказов, только сигнал «очередь изменилась»: экран перечитывает очередь
 * целиком, и показанное всегда совпадает с сервером.
 *
 * У нового заказа — обратный отсчёт до автоотмены (KIT-5): срок берётся
 * из того же таймера сервиса заказов, по которому заказ отменится сам.
 */
export function KitchenPage() {
  const queue = useQuery<{ kitchenQueue: Order[] }>(KITCHEN_QUEUE, {
    fetchPolicy: "network-only",
    // Страховка на случай потери соединения WebSocket.
    pollInterval: 30_000,
  });
  const changed = useSubscription(KITCHEN_QUEUE_CHANGED);
  const { refetch } = queue;
  useEffect(() => {
    if (changed.data) void refetch();
  }, [changed.data, refetch]);

  const orders = queue.data?.kitchenQueue ?? [];
  const fresh = orders.filter((o) => o.status === "AWAITING_RESTAURANT");
  const cooking = orders.filter((o) => o.status === "COOKING");
  const waiting = orders.filter((o) => o.status === "READY" || o.status === "ASSIGNING_COURIER");

  // Новый заказ — заметно: счётчик в заголовке вкладки.
  useEffect(() => {
    document.title = fresh.length > 0 ? `(${fresh.length}) Кухня` : "Кухня";
    return () => {
      document.title = "Доставка еды";
    };
  }, [fresh.length]);

  return (
    <main className="page page--wide">
      <h1 className="page__title">Кухня</h1>
      <p className="page__hint">
        {changed.error
          ? "Нет связи для обновлений — очередь обновляется раз в 30 секунд."
          : "Новые заказы появляются сами."}
      </p>
      {queue.error && <p className="notice notice--error">{errorText(queue.error)}</p>}
      {queue.loading && !queue.data && <p className="notice notice--quiet">Загружаем очередь…</p>}

      <div className="kitchen">
        <section className="kitchen__column" aria-label="Новые">
          <h2 className="section__title">Новые · {fresh.length}</h2>
          {fresh.length === 0 && <p className="item__note">Новых заказов нет.</p>}
          {fresh.map((order) => (
            <NewOrder key={order.id} order={order} onDone={() => void refetch()} />
          ))}
        </section>

        <section className="kitchen__column" aria-label="Готовятся">
          <h2 className="section__title">Готовятся · {cooking.length}</h2>
          {cooking.map((order) => (
            <CookingOrder key={order.id} order={order} onDone={() => void refetch()} />
          ))}
        </section>

        <section className="kitchen__column" aria-label="Ждут курьера">
          <h2 className="section__title">Ждут курьера · {waiting.length}</h2>
          {waiting.map((order) => (
            <article key={order.id} className="card kitchen-card">
              <OrderSummary order={order} />
              <p className="item__note">Готов с {formatTime(order.readyAt)}</p>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

function OrderSummary({ order }: { order: Order }) {
  return (
    <>
      <div className="kitchen-card__head">
        <strong>№{order.orderNumber}</strong>
        <span className="price">{formatMoney(order.amounts.items)}</span>
      </div>
      <ul className="kitchen-card__lines">
        {order.lines.map((line, index) => (
          <li key={`${line.menuItemId}-${index}`}>
            {line.name} × {line.quantity}
            {line.options.length > 0 && (
              <span className="item__note"> · {line.options.map((o) => o.name).join(", ")}</span>
            )}
          </li>
        ))}
      </ul>
      {order.comment && <p className="kitchen-card__comment">«{order.comment}»</p>}
    </>
  );
}

function NewOrder({ order, onDone }: { order: Order; onDone: () => void }) {
  const now = useNow();
  const [minutes, setMinutes] = useState(15);
  const [confirm, confirming] = useMutation(CONFIRM_ORDER);
  const [reject, rejecting] = useMutation(REJECT_ORDER);
  const left = countdown(order.respondBy, now);
  const urgent = order.respondBy && new Date(order.respondBy).getTime() - now < 60_000;

  const accept = async () => {
    await confirm({ variables: { id: order.id, cookingMinutes: minutes } }).catch(() => undefined);
    onDone();
  };
  const decline = async () => {
    const reason = window.prompt("Почему ресторан не может принять заказ?", "Нет ингредиентов");
    if (!reason?.trim()) return;
    await reject({ variables: { id: order.id, reason: reason.trim() } }).catch(() => undefined);
    onDone();
  };

  return (
    <article
      className={`card kitchen-card kitchen-card--new${urgent ? " kitchen-card--urgent" : ""}`}
    >
      <OrderSummary order={order} />
      {left && (
        <p className="kitchen-card__timer" aria-live="polite">
          Принять до автоотмены: <strong>{left}</strong>
        </p>
      )}
      <div className="kitchen-card__actions">
        <label className="field__label" htmlFor={`minutes-${order.id}`}>
          Готовим, минут
        </label>
        <select
          id={`minutes-${order.id}`}
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        >
          {COOKING_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void accept()} disabled={confirming.loading}>
          Принять
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => void decline()}
          disabled={rejecting.loading}
        >
          Отклонить
        </button>
      </div>
      {(confirming.error || rejecting.error) && (
        <p className="notice notice--error">{errorText(confirming.error ?? rejecting.error)}</p>
      )}
    </article>
  );
}

function CookingOrder({ order, onDone }: { order: Order; onDone: () => void }) {
  const now = useNow();
  const [ready, marking] = useMutation(MARK_ORDER_READY);
  const due =
    order.confirmedAt && order.expectedCookingMin
      ? new Date(
          new Date(order.confirmedAt).getTime() + order.expectedCookingMin * 60_000,
        ).toISOString()
      : null;
  const late = due && new Date(due).getTime() < now;

  return (
    <article className={`card kitchen-card${late ? " kitchen-card--urgent" : ""}`}>
      <OrderSummary order={order} />
      {due && (
        <p className="kitchen-card__timer">
          {late ? (
            "Обещанное время вышло"
          ) : (
            <>
              До готовности: <strong>{countdown(due, now)}</strong>
            </>
          )}
        </p>
      )}
      <button
        type="button"
        onClick={() =>
          void ready({ variables: { id: order.id } })
            .catch(() => undefined)
            .then(onDone)
        }
        disabled={marking.loading}
      >
        Готово
      </button>
      {marking.error && <p className="notice notice--error">{errorText(marking.error)}</p>}
    </article>
  );
}
