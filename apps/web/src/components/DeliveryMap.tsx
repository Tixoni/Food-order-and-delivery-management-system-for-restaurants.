import { useEffect } from "react";
import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { GeoPoint } from "../api/queries";

interface Props {
  pickup: GeoPoint;
  dropoff: GeoPoint;
  courier?: GeoPoint | null;
  /** Подпись к точке курьера: «вы» для курьера, «курьер» для клиента. */
  courierLabel?: string;
  /** Путь по дорогам; нет — пунктирная прямая (маршрутизатор недоступен). */
  route?: GeoPoint[] | null;
}

const toLatLng = (point: GeoPoint): [number, number] => [point.latitude, point.longitude];

/** Карта подстраивается под точки, но не дёргается на каждой новой позиции курьера. */
function FitBounds({ points }: { points: GeoPoint[] }) {
  const map = useMap();
  const key = points.map((p) => `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`).join("|");
  useEffect(() => {
    map.fitBounds(points.map(toLatLng), { padding: [32, 32], maxZoom: 16 });
    // Пересчитываем только при заметном сдвиге: ключ округлён до ~100 м.
  }, [key, map]);
  return null;
}

/**
 * Карта доставки: ресторан, адрес клиента и курьер (TRK-2).
 *
 * Отдельный модуль, загружаемый по требованию: библиотека карт весит
 * больше всего остального клиентского кода, а нужна только на экране
 * отслеживания и у курьера.
 */
export default function DeliveryMap({
  pickup,
  dropoff,
  courier,
  courierLabel = "курьер",
  route,
}: Props) {
  const line = route && route.length >= 2 ? route : null;
  const points = [pickup, dropoff, ...(courier ? [courier] : []), ...(line ?? [])];
  return (
    <MapContainer
      center={toLatLng(courier ?? pickup)}
      zoom={14}
      className="map map--delivery"
      scrollWheelZoom={false}
    >
      <TileLayer
        attribution='&copy; участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds points={points} />
      {line ? (
        <Polyline
          positions={line.map(toLatLng)}
          pathOptions={{ color: "#b4491f", weight: 4, opacity: 0.75 }}
        />
      ) : (
        <Polyline
          positions={[toLatLng(pickup), toLatLng(dropoff)]}
          pathOptions={{ color: "#6b6864", weight: 2, dashArray: "6 6" }}
        />
      )}
      <CircleMarker
        center={toLatLng(pickup)}
        radius={8}
        pathOptions={{ color: "#1c1b1a", fillColor: "#fdf1ec", fillOpacity: 1, weight: 2 }}
      >
        <Tooltip>ресторан</Tooltip>
      </CircleMarker>
      <CircleMarker
        center={toLatLng(dropoff)}
        radius={8}
        pathOptions={{ color: "#2f6b3a", fillColor: "#2f6b3a", fillOpacity: 1 }}
      >
        <Tooltip>адрес доставки</Tooltip>
      </CircleMarker>
      {courier && (
        <CircleMarker
          center={toLatLng(courier)}
          radius={10}
          pathOptions={{ color: "#ffffff", fillColor: "#b4491f", fillOpacity: 1, weight: 3 }}
        >
          <Tooltip permanent direction="top">
            {courierLabel}
          </Tooltip>
        </CircleMarker>
      )}
    </MapContainer>
  );
}
