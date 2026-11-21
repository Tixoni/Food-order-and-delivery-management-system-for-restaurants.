import { useMutation, useQuery } from "@apollo/client";
import { useState, type FormEvent } from "react";
import { errorText } from "../api/client";
import {
  OPERATOR_CANCEL_ORDER,
  OPERATOR_ORDERS,
  ORDER,
  type Order,
  type OrderTransition,
} from "../api/queries";
import { formatMoney, parseMoney } from "../components/money";
import { formatTime, isFinished, statusText } from "../components/orderStatus";

const PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const AMOUNT = /^\d+(?:[.,]\d{1,2})?$/;
const ACTOR: Record<string, string> = {
  CUSTOMER: "Клиент",
  RESTAURANT: "Ресторан",
  COURIER: "Курьер",
  OPERATOR: "Оператор",
  SYSTEM: "Система",
};

type OrderRow = Pick<Order, "id" | "orderNumber" | "status" | "placedAt" | "restaurant"> & {
  amounts: Pick<Order["amounts"], "total">;
};

export function OperatorOrdersPage() {
  const [term, setTerm] = useState("");
  const [number, setNumber] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const orders = useQuery<{ operatorOrders: OrderRow[] }>(OPERATOR_ORDERS, {
    variables: { number, offset, limit: PAGE_SIZE },
    fetchPolicy: "network-only",
  });
  const items = orders.data?.operatorOrders ?? [];

  function search(event: FormEvent) {
    event.preventDefault();
    const value = term.trim().replace(/^№\s*/, "");
    const orderNumber = Number(value);
    if (UUID.test(value)) {
      setError("");
      setActiveId(value.toLowerCase());
      return;
    }
    if (value && (!/^\d+$/.test(value) || orderNumber < 1 || orderNumber > 2147483647)) {
      setError("Укажи номер заказа или его полный ID.");
      return;
    }
    setError("");
    setActiveId(null);
    setNumber(value ? orderNumber : null);
    setOffset(0);
  }

  return (
    <main className="page page--narrow">
      <h1 className="page__title">Заказы поддержки</h1>
      <form className="card form" onSubmit={search}>
        <div className="field">
          <label className="field__label" htmlFor="operator-search">
            Номер или ID заказа
          </label>
          <input
            id="operator-search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            maxLength={50}
          />
        </div>
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit">Найти</button>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setTerm("");
              setNumber(null);
              setActiveId(null);
              setOffset(0);
              setError("");
              void orders.refetch({ number: null, offset: 0 }).catch(() => undefined);
            }}
          >
            Последние заказы
          </button>
        </div>
      </form>

      {activeId ? (
        <OperatorOrderDetails key={activeId} id={activeId} onBack={() => setActiveId(null)} />
      ) : (
        <>
          {orders.loading && <p className="notice notice--quiet">Загружаем заказы…</p>}
          {orders.error && <p className="notice notice--error">{errorText(orders.error)}</p>}
          {!orders.loading && !orders.error && items.length === 0 && (
            <p className="notice notice--quiet">Заказы не найдены.</p>
          )}
          <ul className="order-list">
            {items.map((order) => (
              <li key={order.id}>
                <article className="card order-card">
                  <div className="order-card__head">
                    <strong>
                      №{order.orderNumber} · {order.restaurant?.name ?? "Ресторан"}
                    </strong>
                    <span className="price">{formatMoney(order.amounts.total)}</span>
                  </div>
                  <p className="item__note">
                    {statusText(order.status)} · {formatTime(order.placedAt)}
                  </p>
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => setActiveId(order.id)}
                  >
                    Открыть заказ №{order.orderNumber}
                  </button>
                </article>
              </li>
            ))}
          </ul>
          {(offset > 0 || items.length === PAGE_SIZE) && (
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={offset === 0 || orders.loading}
                onClick={() => setOffset(offset - PAGE_SIZE)}
              >
                Назад
              </button>
              <button
                type="button"
                className="secondary"
                disabled={items.length < PAGE_SIZE || orders.loading}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Дальше
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function OperatorOrderDetails({ id, onBack }: { id: string; onBack: () => void }) {
  const result = useQuery<{ order: Order; orderTransitions: OrderTransition[] }>(ORDER, {
    variables: { id },
    fetchPolicy: "network-only",
  });
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [cancel, cancellation] = useMutation(OPERATOR_CANCEL_ORDER);
  const order = result.data?.order;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!order || cancellation.loading) return;
    const value = amount.trim();
    const refundAmount = parseMoney(value);
    if (
      value &&
      (!AMOUNT.test(value) || refundAmount === null || refundAmount > order.amounts.total)
    ) {
      setError("Укажи сумму возврата в рублях, от нуля до суммы заказа.");
      return;
    }
    if (!reason.trim()) {
      setError("Укажи причину отмены.");
      return;
    }
    if (!window.confirm(`Отменить заказ №${order.orderNumber}?`)) return;
    setError("");
    try {
      await cancel({
        variables: { id, reason: reason.trim(), refundAmount },
        refetchQueries: ["Order", "OperatorOrders"],
      });
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  return (
    <section>
      <button type="button" className="secondary small" onClick={onBack}>
        К списку
      </button>
      {result.loading && !order && <p className="notice notice--quiet">Загружаем заказ…</p>}
      {result.error && <p className="notice notice--error">{errorText(result.error)}</p>}
      {order && (
        <>
          <h2 className="section__title">Заказ №{order.orderNumber}</h2>
          <div className="card">
            <p>
              <strong>{statusText(order.status)}</strong> · {formatMoney(order.amounts.total)}
            </p>
            <p className="item__note">
              {order.restaurant?.name ?? "Ресторан"} · {order.addressText}
            </p>
            <p className="item__note">ID: {order.id}</p>
            {order.cancelComment && <p>Причина отмены: {order.cancelComment}</p>}
          </div>
          <h3 className="section__title">История переходов</h3>
          <ol className="order-list">
            {(result.data?.orderTransitions ?? []).map((transition, index) => (
              <li key={index} className="item">
                <div className="item__body">
                  <strong>
                    {transition.from ? `${statusText(transition.from)} → ` : ""}
                    {statusText(transition.to)}
                  </strong>
                  <p className="item__note">
                    {formatTime(transition.at)} ·{" "}
                    {ACTOR[transition.actorType] ?? transition.actorType}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {!isFinished(order.status) && (
            <form className="card form" onSubmit={(event) => void submit(event)}>
              <div className="field">
                <label htmlFor="operator-reason" className="field__label">
                  Причина отмены
                </label>
                <textarea
                  id="operator-reason"
                  maxLength={500}
                  rows={2}
                  required
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="operator-refund" className="field__label">
                  Частичный возврат, ₽
                </label>
                <input
                  id="operator-refund"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <p className="item__note">Пустое поле — полный возврат при списании.</p>
              </div>
              {error && (
                <p className="notice notice--error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" className="secondary" disabled={cancellation.loading}>
                Отменить заказ
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
