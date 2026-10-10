import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@apollo/client";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapContainer, Marker, Polygon, TileLayer, useMapEvents } from "react-leaflet";
import { errorText } from "../../api/client";
import { DELIVERY_ZONES, SAVE_ZONE, type DeliveryZone, type ZonePoint } from "../../api/queries";
import { formatMoney, moneyInput, parseMoney } from "../../components/money";
import { useManagedRestaurant } from "./useManagedRestaurant";

const MOSCOW: [number, number] = [55.7558, 37.6176];

/** Вершина контура — маленькая точка, которую можно перетащить. */
const vertexIcon = L.divIcon({ className: "vertex", iconSize: [14, 14] });

interface Draft {
  id?: string;
  name: string;
  ring: ZonePoint[];
  deliveryFee: string;
  minOrderAmount: string;
  isActive: boolean;
}

const emptyDraft = (): Draft => ({
  name: "Новая зона",
  ring: [],
  deliveryFee: "150",
  minOrderAmount: "500",
  isActive: true,
});

const toDraft = (zone: DeliveryZone): Draft => ({
  id: zone.id,
  name: zone.name,
  ring: zone.ring,
  deliveryFee: moneyInput(zone.deliveryFee),
  minOrderAmount: moneyInput(zone.minOrderAmount),
  isActive: zone.isActive,
});

/** Щелчок по карте добавляет вершину в конец контура. */
function ClickToAdd({ onAdd }: { onAdd: (point: ZonePoint) => void }) {
  useMapEvents({
    click: (event) => onAdd({ latitude: event.latlng.lat, longitude: event.latlng.lng }),
  });
  return null;
}

const center = (zones: DeliveryZone[]): [number, number] => {
  const points = zones.flatMap((zone) => zone.ring);
  if (points.length === 0) return MOSCOW;
  const sum = points.reduce(
    (acc, point) => [acc[0] + point.latitude, acc[1] + point.longitude],
    [0, 0],
  );
  return [sum[0] / points.length, sum[1] / points.length];
};

/**
 * Редактор зоны доставки на карте (ADM-1).
 *
 * Контур рисуется щелчками по карте; вершины можно перетаскивать.
 * У каждой зоны свои стоимость доставки и минимальная сумма — клиент
 * видит условия той зоны, в которую попал его адрес (CAT-1).
 *
 * Зону нельзя удалить, только отключить: по ней уже могли оформляться
 * заказы, и разбор старого заказа не должен натыкаться на пустоту.
 */
export function ZoneEditorPage() {
  const { restaurantId, picker, missing } = useManagedRestaurant();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const zones = useQuery<{ deliveryZones: DeliveryZone[] }>(DELIVERY_ZONES, {
    variables: { restaurantId },
    skip: !restaurantId,
  });
  const [save, saving] = useMutation(SAVE_ZONE, {
    refetchQueries: [{ query: DELIVERY_ZONES, variables: { restaurantId } }],
  });

  const list = useMemo(() => zones.data?.deliveryZones ?? [], [zones.data]);
  const mapCenter = useMemo(() => center(list), [list]);

  if (missing) return <main className="page">{missing}</main>;

  const updateVertex = (index: number, point: ZonePoint) =>
    setDraft((current) =>
      current
        ? { ...current, ring: current.ring.map((old, i) => (i === index ? point : old)) }
        : current,
    );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !restaurantId) return;
    setMessage(null);
    const deliveryFee = parseMoney(draft.deliveryFee);
    const minOrderAmount = parseMoney(draft.minOrderAmount);
    if (draft.ring.length < 3) {
      return setMessage({ ok: false, text: "Контур зоны — не меньше трёх точек на карте" });
    }
    if (deliveryFee === null || minOrderAmount === null) {
      return setMessage({ ok: false, text: "Суммы — числа в рублях, например 150 или 99,90" });
    }
    try {
      await save({
        variables: {
          input: {
            ...(draft.id ? { id: draft.id } : {}),
            restaurantId,
            name: draft.name.trim() || "Зона доставки",
            ring: draft.ring.map(({ latitude, longitude }) => ({ latitude, longitude })),
            deliveryFee,
            minOrderAmount,
            isActive: draft.isActive,
          },
        },
      });
      setMessage({ ok: true, text: `Зона «${draft.name}» сохранена` });
      setDraft(null);
    } catch (failure) {
      setMessage({ ok: false, text: errorText(failure) });
    }
  };

  return (
    <main className="page page--wide">
      <h1 className="page__title">Зоны доставки</h1>
      <p className="page__hint">
        Выберите зону или создайте новую, затем щёлкайте по карте, чтобы нарисовать контур. Вершины
        можно перетаскивать.
      </p>
      {picker}
      {message && (
        <p className={`notice ${message.ok ? "notice--ok" : "notice--error"}`} role="status">
          {message.text}
        </p>
      )}

      <div className="zone-layout">
        <div className="zone-layout__map">
          <MapContainer key={mapCenter.join(",")} center={mapCenter} zoom={12} className="map">
            <TileLayer
              attribution='&copy; участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {list
              .filter((zone) => zone.id !== draft?.id)
              .map((zone) => (
                <Polygon
                  key={zone.id}
                  positions={zone.ring.map((p) => [p.latitude, p.longitude])}
                  pathOptions={{
                    color: zone.isActive ? "#b4491f" : "#6b6864",
                    dashArray: zone.isActive ? undefined : "6 6",
                    weight: 2,
                  }}
                  eventHandlers={{ click: () => setDraft(toDraft(zone)) }}
                />
              ))}
            {draft && draft.ring.length > 0 && (
              <Polygon
                positions={draft.ring.map((p) => [p.latitude, p.longitude])}
                pathOptions={{ color: "#2f6b3a", weight: 3 }}
              />
            )}
            {draft?.ring.map((point, index) => (
              <Marker
                key={index}
                position={[point.latitude, point.longitude]}
                icon={vertexIcon}
                draggable
                eventHandlers={{
                  dragend: (event) => {
                    const { lat, lng } = (event.target as L.Marker).getLatLng();
                    updateVertex(index, { latitude: lat, longitude: lng });
                  },
                }}
              />
            ))}
            {draft && (
              <ClickToAdd
                onAdd={(point) =>
                  setDraft((current) =>
                    current ? { ...current, ring: [...current.ring, point] } : current,
                  )
                }
              />
            )}
          </MapContainer>
          <p className="map__hint">
            {draft
              ? `Точек в контуре: ${draft.ring.length}. Контур замыкается автоматически.`
              : "Щёлкните по зоне на карте или выберите её в списке."}
          </p>
        </div>

        <div className="zone-layout__side">
          {!draft && (
            <>
              <button type="button" onClick={() => setDraft(emptyDraft())} disabled={!restaurantId}>
                + Новая зона
              </button>
              {zones.loading && <p className="notice notice--quiet">Загружаем зоны…</p>}
              {zones.error && <p className="notice notice--error">{errorText(zones.error)}</p>}
              {list.length === 0 && zones.data && (
                <p className="notice notice--quiet">
                  Зон пока нет — ресторан не появится в выдаче ни по одному адресу.
                </p>
              )}
              <ul className="zone-list">
                {list.map((zone) => (
                  <li key={zone.id}>
                    <button
                      type="button"
                      className="secondary zone-list__item"
                      onClick={() => setDraft(toDraft(zone))}
                    >
                      <span>{zone.name}</span>
                      <span className="item__note">
                        доставка {formatMoney(zone.deliveryFee)} · от{" "}
                        {formatMoney(zone.minOrderAmount)}
                        {zone.isActive ? "" : " · отключена"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {draft && (
            <form className="card form" onSubmit={submit}>
              <div className="field">
                <label className="field__label" htmlFor="zone-name">
                  Название зоны
                </label>
                <input
                  id="zone-name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </div>
              <div className="row">
                <div className="field">
                  <label className="field__label" htmlFor="zone-fee">
                    Доставка, ₽
                  </label>
                  <input
                    id="zone-fee"
                    inputMode="decimal"
                    value={draft.deliveryFee}
                    onChange={(event) => setDraft({ ...draft, deliveryFee: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="zone-min">
                    Заказ от, ₽
                  </label>
                  <input
                    id="zone-min"
                    inputMode="decimal"
                    value={draft.minOrderAmount}
                    onChange={(event) => setDraft({ ...draft, minOrderAmount: event.target.value })}
                  />
                </div>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
                />
                Зона действует
              </label>
              <div className="row">
                <button
                  type="button"
                  className="secondary small"
                  disabled={draft.ring.length === 0}
                  onClick={() => setDraft({ ...draft, ring: draft.ring.slice(0, -1) })}
                >
                  Убрать последнюю точку
                </button>
                <button
                  type="button"
                  className="secondary small"
                  disabled={draft.ring.length === 0}
                  onClick={() => setDraft({ ...draft, ring: [] })}
                >
                  Нарисовать заново
                </button>
              </div>
              <div className="row">
                <button type="submit" disabled={saving.loading}>
                  {saving.loading ? "Сохраняем…" : "Сохранить зону"}
                </button>
                <button type="button" className="secondary" onClick={() => setDraft(null)}>
                  Отмена
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
