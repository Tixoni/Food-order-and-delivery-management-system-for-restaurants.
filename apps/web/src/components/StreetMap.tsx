import { useEffect, type ReactNode } from "react";
import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import type { GeoPoint } from "../api/queries";

export const toLatLng = (point: GeoPoint): [number, number] => [point.latitude, point.longitude];

function FitContainer() {
  const map = useMap();
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

export function StreetMap({
  center,
  variant,
  children,
}: {
  center: GeoPoint;
  variant: "address" | "delivery";
  children: ReactNode;
}) {
  return (
    <MapContainer
      center={toLatLng(center)}
      zoom={14}
      className={`map map--${variant}`}
      scrollWheelZoom={variant === "address"}
    >
      <TileLayer
        attribution='&copy; участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitContainer />
      {children}
    </MapContainer>
  );
}
