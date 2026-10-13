import { Suspense, lazy, useEffect, useState } from "react";
import { useMutation, useQuery, useSubscription } from "@apollo/client";
import { errorText } from "../../api/client";
import {
  ACCEPT_OFFER,
  COURIER_DASHBOARD,
  COURIER_UPDATED,
  MARK_DELIVERED,
  MARK_PICKED_UP,
  REJECT_OFFER,
  SET_COURIER_SHIFT,
  type CourierDashboardData,
  type DeliveryTask,
} from "../../api/queries";
import { countdown, useNow } from "../../components/useNow";
import { useCourierLocation } from "./useCourierLocation";

const DeliveryMap = lazy(() => import("../../components/DeliveryMap"));

const SIMULATION_KEY = "fd:courier-simulation";

function loadSimulation(): boolean {
  try {
    return localStorage.getItem(SIMULATION_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Приложение курьера (DLV-1, DLV-2, DLV-4, DLV-5).
 *
 * Экран собран вокруг одного вопроса курьера: «что мне сейчас делать?».
 * Не на смене — выйти на смену. Пришло предложение — принять или
 * отказаться, пока идёт отсчёт. Есть доставка — ехать в ресторан,
 * потом к клиенту. Предложения приходят подпиской по WebSocket;
 * на случай потери связи экран перечитывается раз в 15 секунд.
 *
 * Телефон клиента виден только после принятия заказа: за 90 секунд
 * предложения номер не должен расходиться по всем курьерам района.
 */
export function CourierPage() {
  const dashboard = useQuery<{ courierDashboard: CourierDashboardData }>(COURIER_DASHBOARD, {
    fetchPolicy: "network-only",
    pollInterval: 15_000,
  });
  const signal = useSubscription(COURIER_UPDATED);
  const { refetch } = dashboard;
  useEffect(() => {
    if (signal.data) void refetch();
  }, [signal.data, refetch]);

  const [simulate, setSimulate] = useState(loadSimulation);
  const data = dashboard.data?.courierDashboard;
  const onShift = !!data && data.courier.status !== "offline";
  const delivery = data?.delivery ?? null;
  const target = delivery
    ? delivery.status === "PICKED_UP"
      ? delivery.dropoff
      : delivery.pickup
    : null;
  const location = useCourierLocation({
    onShift,
    simulate,
    target,
    start: data?.position ?? null,
  });

  const [setShift, shifting] = useMutation(SET_COURIER_SHIFT);
  const toggleShift = async () => {
    await setShift({ variables: { onShift: !onShift } }).catch(() => undefined);
    void refetch();
  };

  const toggleSimulation = (value: boolean) => {
    setSimulate(value);
    try {
      localStorage.setItem(SIMULATION_KEY, value ? "1" : "0");
    } catch {
      // Без хранилища режим просто не запомнится
    }
  };

  if (dashboard.loading && !data) {
    return (
      <main className="page page--narrow">
        <p className="notice notice--quiet">Загружаем…</p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="page page--narrow">
        <p className="notice notice--error">{errorText(dashboard.error)}</p>
      </main>
    );
  }

  return (
    <main className="page page--narrow courier">
      <div className="courier__head">
        <div>
          <h1 className="page__title">{data.courier.fullName}</h1>
          <p className="page__hint">{onShift ? statusText(data.courier.status) : "Не на смене"}</p>
        </div>
        <button
          type="button"
          className={onShift ? "secondary" : ""}
          onClick={() => void toggleShift()}
          disabled={shifting.loading}
        >
          {onShift ? "Закончить смену" : "Выйти на смену"}
        </button>
      </div>
      {shifting.error && <p className="notice notice--error">{errorText(shifting.error)}</p>}

      {onShift && (
        <p className="item__note courier__gps">
          {location.source === "gps" && "Геопозиция: GPS"}
          {location.source === "simulation" && "Геопозиция: имитация движения"}
          {location.source === "unavailable" && "Геопозиция недоступна — разрешите её в браузере"}
          {location.sentAt &&
            ` · отправлено ${new Date(location.sentAt).toLocaleTimeString("ru-RU")}`}
        </p>
      )}

      {data.offer && <OfferCard offer={data.offer} onDone={() => void refetch()} />}
      {delivery && (
        <DeliveryCard
          delivery={delivery}
          courier={location.position}
          onDone={() => void refetch()}
        />
      )}
      {onShift && !data.offer && !delivery && (
        <p className="notice notice--quiet">Ждём заказ рядом с вами. Предложение придёт само.</p>
      )}

      <label className="check courier__simulation">
        <input
          type="checkbox"
          checked={simulate}
          onChange={(event) => toggleSimulation(event.target.checked)}
        />
        Имитация движения (для демонстрации без выхода на улицу)
      </label>
    </main>
  );
}

/** «4,2 км» / «850 м». */
function kilometers(meters: number): string {
  return meters < 1000
    ? `${Math.round(meters / 10) * 10} м`
    : `${(meters / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`;
}

function statusText(status: string): string {
  return (
    {
      available: "Свободен, ждёт заказ",
      assigned: "Предложен заказ",
      busy: "Везёт заказ",
    }[status] ?? status
  );
}

function OfferCard({
  offer,
  onDone,
}: {
  offer: NonNullable<CourierDashboardData["offer"]>;
  onDone: () => void;
}) {
  const now = useNow();
  const [accept, accepting] = useMutation(ACCEPT_OFFER);
  const [reject, rejecting] = useMutation(REJECT_OFFER);
  const left = countdown(offer.expiresAt, now);
  const expired = new Date(offer.expiresAt).getTime() <= now;

  const respond = async (action: typeof accept) => {
    await action({ variables: { id: offer.id } }).catch(() => undefined);
    onDone();
  };

  return (
    <section className="card courier-offer" aria-live="assertive">
      <h2 className="section__title">Новый заказ</h2>
      <p>
        <strong>{offer.delivery.restaurant?.name ?? "Ресторан"}</strong>
        {offer.delivery.orderNumber ? ` · №${offer.delivery.orderNumber}` : ""}
      </p>
      <p className="item__note">
        Куда: {offer.delivery.dropoffAddress ?? "адрес появится после принятия"}
        {offer.delivery.route &&
          ` · от ресторана ${kilometers(offer.delivery.route.distanceMeters)}`}
      </p>
      <p className="courier-offer__timer">
        {expired ? (
          "Время на ответ вышло"
        ) : (
          <>
            Ответить за <strong>{left}</strong>
          </>
        )}
      </p>
      <div className="row">
        <button
          type="button"
          onClick={() => void respond(accept)}
          disabled={accepting.loading || expired}
        >
          Принять
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => void respond(reject)}
          disabled={rejecting.loading}
        >
          Отказаться
        </button>
      </div>
      {(accepting.error || rejecting.error) && (
        <p className="notice notice--error">{errorText(accepting.error ?? rejecting.error)}</p>
      )}
    </section>
  );
}

function DeliveryCard({
  delivery,
  courier,
  onDone,
}: {
  delivery: DeliveryTask;
  courier: { latitude: number; longitude: number } | null;
  onDone: () => void;
}) {
  const [pickedUp, picking] = useMutation(MARK_PICKED_UP);
  const [delivered, delivering] = useMutation(MARK_DELIVERED);
  const inTransit = delivery.status === "PICKED_UP";

  const mark = async (action: typeof pickedUp) => {
    await action({ variables: { deliveryId: delivery.id } }).catch(() => undefined);
    onDone();
  };

  return (
    <section className="card courier-delivery">
      <h2 className="section__title">
        {inTransit ? "Везёте клиенту" : "Едете в ресторан"}
        {delivery.orderNumber ? ` · №${delivery.orderNumber}` : ""}
      </h2>
      <dl className="courier-delivery__facts">
        <dt>Ресторан</dt>
        <dd>{delivery.restaurant?.name ?? "—"}</dd>
        <dt>Адрес клиента</dt>
        <dd>{delivery.dropoffAddress ?? "—"}</dd>
        {delivery.route && (
          <>
            <dt>Путь</dt>
            <dd>{kilometers(delivery.route.distanceMeters)} от ресторана по дорогам</dd>
          </>
        )}
        {delivery.contactPhone && (
          <>
            <dt>Телефон</dt>
            <dd>
              <a href={`tel:${delivery.contactPhone.replace(/[^\d+]/g, "")}`}>
                {delivery.contactPhone}
              </a>
            </dd>
          </>
        )}
        {!inTransit && delivery.readyAt && (
          <>
            <dt>Будет готов</dt>
            <dd>
              {new Date(delivery.readyAt).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </dd>
          </>
        )}
      </dl>

      <Suspense fallback={<p className="item__note">Загружаем карту…</p>}>
        <DeliveryMap
          pickup={delivery.pickup}
          dropoff={delivery.dropoff}
          courier={courier}
          courierLabel="вы"
          route={delivery.route?.path}
        />
      </Suspense>

      {inTransit ? (
        <button
          type="button"
          className="courier-delivery__action"
          onClick={() => void mark(delivered)}
          disabled={delivering.loading}
        >
          Доставил
        </button>
      ) : (
        <button
          type="button"
          className="courier-delivery__action"
          onClick={() => void mark(pickedUp)}
          disabled={picking.loading}
        >
          Забрал заказ
        </button>
      )}
      {(picking.error || delivering.error) && (
        <p className="notice notice--error">{errorText(picking.error ?? delivering.error)}</p>
      )}
    </section>
  );
}
