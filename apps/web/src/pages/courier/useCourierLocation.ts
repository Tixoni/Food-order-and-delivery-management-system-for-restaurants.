import { useEffect, useRef, useState } from "react";
import { useMutation } from "@apollo/client";
import { UPDATE_COURIER_LOCATION, type GeoPoint } from "../../api/queries";

/** Как часто курьер сообщает позицию — DLV-2: раз в 5–10 секунд. */
export const SEND_INTERVAL_MS = 5_000;

/** Скорость имитации: велосипед в городе, метров за шаг отправки. */
const SIMULATED_STEP_M = (14_000 / 3600) * (SEND_INTERVAL_MS / 1000);

export type LocationSource = "gps" | "simulation" | "unavailable";

/** Шаг из `from` к `to` не длиннее `meters`. */
function stepTowards(from: GeoPoint, to: GeoPoint, meters: number): GeoPoint {
  const dLat = (to.latitude - from.latitude) * 111_195;
  const dLon =
    (to.longitude - from.longitude) * 111_195 * Math.cos((from.latitude * Math.PI) / 180);
  const distance = Math.hypot(dLat, dLon);
  if (distance <= meters) return to;
  const k = meters / distance;
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * k,
    longitude: from.longitude + (to.longitude - from.longitude) * k,
  };
}

/**
 * Отправка позиции курьера, пока он на смене (DLV-2).
 *
 * Источник — геолокация браузера. Для демонстрации без выхода на улицу
 * есть имитация: курьер «едет» со скоростью велосипеда к ресторану,
 * а после «забрал» — к клиенту. Отправка — не чаще раза в 5 секунд:
 * чаще клиенту не нужно, а батарея курьера не бесконечна.
 */
export function useCourierLocation(options: {
  onShift: boolean;
  simulate: boolean;
  /** Куда ехать в режиме имитации. */
  target: GeoPoint | null;
  start: GeoPoint | null;
}) {
  const [send] = useMutation(UPDATE_COURIER_LOCATION);
  const [position, setPosition] = useState<GeoPoint | null>(options.start);
  const [source, setSource] = useState<LocationSource>("unavailable");
  const [sentAt, setSentAt] = useState<number | null>(null);
  const latest = useRef<GeoPoint | null>(null);
  const target = useRef(options.target);
  target.current = options.target;
  // Начальная точка — последняя известная позиция с сервера; ссылкой,
  // чтобы перечитывание экрана не перезапускало отправку.
  const start = useRef(options.start);
  start.current = options.start;

  useEffect(() => {
    if (!options.onShift) return;

    let watch: number | null = null;
    if (options.simulate) {
      setSource("simulation");
    } else if ("geolocation" in navigator) {
      watch = navigator.geolocation.watchPosition(
        (fix) => {
          latest.current = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
          setSource("gps");
        },
        () => setSource("unavailable"),
        { enableHighAccuracy: true, maximumAge: 5_000 },
      );
    }

    const tick = () => {
      // Последняя известная точка — только как начало имитации. Без GPS
      // её нельзя переотправлять: сервер принял бы старую позицию за свежую,
      // и курьер, давно потерявший связь, попал бы в подбор.
      if (options.simulate && !latest.current && start.current) latest.current = start.current;
      if (options.simulate && latest.current && target.current) {
        latest.current = stepTowards(latest.current, target.current, SIMULATED_STEP_M);
      }
      const point = latest.current;
      if (!point) return;
      setPosition(point);
      void send({ variables: { ...point } })
        .then(() => setSentAt(Date.now()))
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, SEND_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      if (watch !== null) navigator.geolocation.clearWatch(watch);
    };
  }, [options.onShift, options.simulate, send]);

  return { position, source, sentAt };
}
