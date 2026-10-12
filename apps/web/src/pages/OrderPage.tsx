import { Suspense, lazy, useEffect, useState } from "react";
import { useMutation, useQuery, useSubscription } from "@apollo/client";
import { Link, useLocation, useParams } from "react-router-dom";
import { errorText } from "../api/client";
import {
  CANCEL_ORDER,
  COURIER_POSITION,
  COURIER_POSITION_UPDATED,
  ORDER,
  ORDER_UPDATED,
  type GeoPoint,
  type Order,
  type OrderCourierPosition,
  type OrderTransition,
} from "../api/queries";
import { formatMinutes, formatMoney } from "../components/money";
import {
  CLIENT_STEPS,
  cancelText,
  formatTime,
  isFinished,
  statusText,
  stepIndex,
} from "../components/orderStatus";

const DeliveryMap = lazy(() => import("../components/DeliveryMap"));

/**
 * Страховочный опрос на случай потери соединения WebSocket. Основной путь —
 * подписка: статус приходит в момент перехода, а не через несколько секунд.
 */
const FALLBACK_POLL_MS = 30_000;

/** Статусы, при которых на карте есть курьер. */
const COURIER_STATUSES = ["COOKING", "READY", "ASSIGNING_COURIER", "IN_TRANSIT"];

/** Уведомление о смене статуса (NTF-1, NTF-2): то, что клиенту важно узнать сразу. */
const NOTICE: Record<string, string> = {
  AWAITING_RESTAURANT: "Оплата прошла — заказ у ресторана",
  COOKING: "Ресторан принял заказ и начал готовить",
  ASSIGNING_COURIER: "Заказ готов — ждёт курьера",
  IN_TRANSIT: "Курьер забрал заказ и едет к вам",
  DELIVERED: "Заказ доставлен. Приятного аппетита!",
  CANCELLED: "Заказ отменён",
};

/** Ожидаемое время доставки: готовка от подтверждения плюс дорога. */
function expectedBy(order: Order): string | null {
  if (!order.confirmedAt || !order.expectedCookingMin) return null;
  const at = new Date(order.confirmedAt).getTime() + order.expectedCookingMin * 60_000;
  return new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Отслеживание заказа (TRK-1) и отмена до начала готовки (ORD-5).
 *
 * Статус приходит подпиской по WebSocket (NTF-1): шлюз пересылает
 * событие сервиса заказов, экран перечитывает заказ и показывает
 * уведомление. Пока курьер едет, на карте — его позиция, тоже по подписке
 * (TRK-2, PERF-3). Опрос раз в 30 секунд остаётся страховкой на случай
 * потери соединения и останавливается, когда заказ доставлен или отменён.
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
    pollInterval: FALLBACK_POLL_MS,
    // Статус берётся с сервера при каждом опросе, а не из кэша.
    fetchPolicy: "network-only",
    nextFetchPolicy: "network-only",
  });
  const [cancel, cancelling] = useMutation(CANCEL_ORDER);

  const order = query.data?.order;
  const finished = order ? isFinished(order.status) : false;
  const { stopPolling, refetch } = query;
  useEffect(() => {
    if (finished) stopPolling();
  }, [finished, stopPolling]);

  // Статус — подпиской: событие пришло — перечитать заказ и сказать клиенту.
  const update = useSubscription<{ orderUpdated: { status: string; at: string } }>(ORDER_UPDATED, {
    variables: { orderId },
    skip: finished,
  });
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const status = update.data?.orderUpdated.status;
    if (!status) return;
    void refetch();
    if (NOTICE[status]) {
      setNotice(NOTICE[status]);
      const timer = window.setTimeout(() => setNotice(null), 6000);
      return () => window.clearTimeout(timer);
    }
  }, [update.data, refetch]);

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
        {!finished && (
          <p className="item__note">
            {update.error
              ? "Нет связи для обновлений — статус обновляется раз в 30 секунд."
              : "Статус обновляется сам, как только меняется."}
          </p>
        )}

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

      {order && COURIER_STATUSES.includes(order.status) && (
        // Новый статус — перечитать позицию: доставка могла появиться только что.
        <CourierOnMap key={order.status} orderId={order.id} />
      )}

      {notice && (
        <p className="toast" role="status">
          {notice}
        </p>
      )}

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

/**
 * Где курьер (TRK-2). Начальная позиция — запросом, дальше — подпиской.
 * Позиция старше двух минут считается устаревшей: курьер мог потерять
 * связь, и точка часовой давности ввела бы клиента в заблуждение.
 */
function CourierOnMap({ orderId }: { orderId: string }) {
  const initial = useQuery<{ courierPosition: OrderCourierPosition }>(COURIER_POSITION, {
    variables: { orderId },
    fetchPolicy: "network-only",
    // Курьер принимает заказ без смены статуса заказа — экран узнаёт
    // о назначении по живой позиции или при этом перечитывании.
    pollInterval: 15_000,
  });
  const live = useSubscription<{ courierPositionUpdated: GeoPoint & { at: string } }>(
    COURIER_POSITION_UPDATED,
    { variables: { orderId } },
  );

  const info = initial.data?.courierPosition;
  if (!info) return null;
  const position = live.data?.courierPositionUpdated ?? info.position;
  const stale = position && Date.now() - new Date(position.at).getTime() > 120_000;
  // Позиции рассылаются только по принятой доставке: пришла живая
  // позиция — курьер назначен, даже если запрос ещё не перечитан.
  const assigned = info.status === "ASSIGNED" || info.status === "PICKED_UP" || !!live.data;

  return (
    <section className="card">
      <h2 className="section__title">
        {info.status === "PICKED_UP"
          ? "Курьер едет к вам"
          : assigned
            ? "Курьер едет в ресторан"
            : "Ищем курьера"}
      </h2>
      <Suspense fallback={<p className="item__note">Загружаем карту…</p>}>
        <DeliveryMap
          pickup={info.pickup}
          dropoff={info.dropoff}
          courier={assigned && position && !stale ? position : null}
        />
      </Suspense>
      {assigned && (
        <p className="item__note">
          {!position || stale
            ? "Позиция курьера устарела — он мог потерять связь, доставка продолжается."
            : `Позиция обновлена в ${new Date(position.at).toLocaleTimeString("ru-RU")}`}
        </p>
      )}
    </section>
  );
}
