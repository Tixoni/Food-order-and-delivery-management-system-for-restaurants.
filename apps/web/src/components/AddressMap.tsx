import { useEffect } from "react";
import L from "leaflet";
import { Marker, useMap, useMapEvents } from "react-leaflet";
import type { GeoPoint } from "../api/queries";
import { StreetMap, toLatLng } from "./StreetMap";

const pin = L.divIcon({
  className: "address-pin",
  html: "<span></span>",
  iconSize: [32, 42],
  iconAnchor: [16, 42],
});

export default function AddressMap({
  center,
  point,
  onPoint,
}: {
  center: GeoPoint;
  point: GeoPoint | null;
  onPoint: (point: GeoPoint) => void;
}) {
  return (
    <StreetMap center={center} variant="address">
      <PointSelector point={point} onPoint={onPoint} />
      {point && (
        <Marker
          position={toLatLng(point)}
          icon={pin}
          draggable
          eventHandlers={{
            dragend(event) {
              const { lat, lng } = (event.target as L.Marker).getLatLng().wrap();
              onPoint({ latitude: lat, longitude: lng });
            },
          }}
        />
      )}
    </StreetMap>
  );
}

function PointSelector({
  point,
  onPoint,
}: {
  point: GeoPoint | null;
  onPoint: (point: GeoPoint) => void;
}) {
  const map = useMap();
  useEffect(() => {
    if (point) map.setView(toLatLng(point), Math.max(map.getZoom(), 16));
  }, [map, point]);
  useMapEvents({
    click({ latlng }) {
      const { lat, lng } = latlng.wrap();
      onPoint({ latitude: lat, longitude: lng });
    },
  });
  return null;
}
