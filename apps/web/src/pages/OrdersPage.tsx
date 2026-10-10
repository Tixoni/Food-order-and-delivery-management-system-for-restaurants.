import { useQuery } from "@apollo/client";
import { Link } from "react-router-dom";
import { errorText } from "../api/client";
import { MY_ORDERS, type Order } from "../api/queries";
import { formatMoney } from "../components/money";
import { formatTime, isFinished, statusText } from "../components/orderStatus";

const PAGE = 20;

/** История заказов клиента (ORD-7): новые сверху, активные — с отметкой. */
export function OrdersPage() {
  const orders = useQuery<{ myOrders: Order[] }>(MY_ORDERS, {
    variables: { limit: PAGE, offset: 0 },
  });
  const items = orders.data?.myOrders ?? [];

  return (
    <main className="page page--narrow">
      <h1 className="page__title">Мои заказы</h1>

      {orders.loading && !orders.data && <p className="notice notice--quiet">Загружаем…</p>}
      {orders.error && <p className="notice notice--error">{errorText(orders.error)}</p>}
      {orders.data && items.length === 0 && (
        <p className="notice notice--quiet">
          Заказов пока нет. <Link to="/">Выбрать ресторан</Link>
        </p>
      )}

      <ul className="order-list">
        {items.map((order) => (
          <li key={order.id}>
            <Link to={`/orders/${order.id}`} className="card order-card">
              <div className="order-card__head">
                <span className="order-card__title">
                  {order.restaurant?.name ?? "Ресторан"} · №{order.orderNumber}
                </span>
                <span className="price">{formatMoney(order.amounts.total)}</span>
              </div>
              <div className="order-card__meta">
                <span
                  className={`badge ${
                    order.status === "CANCELLED"
                      ? "badge--stopped"
                      : isFinished(order.status)
                        ? ""
                        : "badge--ok"
                  }`}
                >
                  {statusText(order.status)}
                </span>
                <span className="item__note">{formatTime(order.placedAt)}</span>
              </div>
              <div className="item__note item__note--clamp">
                {order.lines.map((line) => `${line.name} × ${line.quantity}`).join(", ")}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
