import { Suspense, lazy, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GeoPoint } from "../api/queries";
import type { Address } from "../pages/address";

const AddressMap = lazy(() => import("./AddressMap"));
const CENTER = { latitude: 55.7615, longitude: 37.6094 };
const cache = new Map<string, unknown>();
let queue = Promise.resolve();
let requestedAt = 0;

async function lookup(path: string) {
  if (cache.has(path)) return cache.get(path);
  const request = queue.then(async () => {
    await new Promise((resolve) =>
      window.setTimeout(resolve, Math.max(0, 1100 - (Date.now() - requestedAt))),
    );
    requestedAt = Date.now();
    const response = await fetch("https://nominatim.openstreetmap.org/" + path, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error("Поиск недоступен");
    const data: unknown = await response.json();
    cache.set(path, data);
    return data;
  });
  queue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

export function AddressMapPicker({
  address,
  onChoose,
}: {
  address: Address | null;
  onChoose: (address: Address) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const version = useRef(0);
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<GeoPoint | null>(address);
  const [label, setLabel] = useState(address?.label ?? "");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  function close() {
    version.current += 1;
    setOpen(false);
    setBusy(false);
    setLocating(false);
  }
  async function selectPoint(next: GeoPoint) {
    const revision = ++version.current;
    setPoint(next);
    setLabel("");
    setBusy(true);
    setError("");
    try {
      const found = (await lookup(
        "reverse?format=jsonv2&accept-language=ru&zoom=18&lat=" +
          next.latitude +
          "&lon=" +
          next.longitude,
      )) as {
        display_name?: string;
        address?: { road?: string; house_number?: string; city?: string; town?: string };
      };
      if (revision !== version.current) return;
      const parts = found.address;
      setLabel(
        parts?.road
          ? [parts.city ?? parts.town, parts.road, parts.house_number].filter(Boolean).join(", ")
          : (found.display_name?.split(",").slice(0, 3).join(", ") ?? ""),
      );
      if (!parts?.house_number) setError("Уточните номер дома в адресе.");
    } catch {
      if (revision === version.current)
        setError("Не удалось определить адрес. Введите улицу и дом для выбранной точки.");
    } finally {
      if (revision === version.current) setBusy(false);
    }
  }
  async function search() {
    if (query.trim().length < 3) {
      setError("Введите улицу и номер дома.");
      return;
    }
    const revision = ++version.current;
    setBusy(true);
    setError("");
    try {
      const found = (await lookup(
        "search?format=json&limit=1&accept-language=ru&q=" + encodeURIComponent(query.trim()),
      )) as Array<{ lat: string; lon: string; display_name: string }>;
      if (revision !== version.current) return;
      if (!found[0]) {
        setError("Адрес не найден. Отметьте место на карте.");
        return;
      }
      setPoint({ latitude: Number(found[0].lat), longitude: Number(found[0].lon) });
      setLabel(found[0].display_name.split(",").slice(0, 4).join(", "));
    } catch {
      if (revision === version.current) setError("Поиск недоступен. Выберите место на карте.");
    } finally {
      if (revision === version.current) setBusy(false);
    }
  }
  function locate() {
    if (!navigator.geolocation) {
      setError("Геопозиция недоступна в браузере.");
      return;
    }
    setLocating(true);
    const revision = ++version.current;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (revision !== version.current) return;
        setLocating(false);
        void selectPoint({ latitude: coords.latitude, longitude: coords.longitude });
      },
      () => {
        if (revision === version.current) {
          setLocating(false);
          setError("Разрешите геопозицию или выберите точку вручную.");
        }
      },
      { timeout: 8000, maximumAge: 60000 },
    );
  }
  function choose() {
    const text = label.trim();
    if (!point || !/\p{L}/u.test(text) || !/\d/.test(text)) {
      setError(point ? "Укажите улицу и дом для курьера." : "Отметьте точку на карте.");
      return;
    }
    onChoose({ ...point, label: text });
    close();
  }

  return (
    <div className="address-picker">
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setPoint(address);
          setLabel(address?.label ?? "");
          setQuery("");
          setError("");
          setOpen(true);
        }}
      >
        Выбрать на карте
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className="address-dialog"
            aria-labelledby={id}
            onCancel={(event) => {
              event.preventDefault();
              close();
            }}
          >
            <div className="address-dialog__header">
              <div>
                <h2 id={id}>Куда доставить?</h2>
                <p>Найдите дом или переместите метку.</p>
              </div>
              <button
                type="button"
                className="secondary small"
                onClick={close}
                aria-label="Закрыть карту"
              >
                ✕
              </button>
            </div>
            <div className="address-dialog__search">
              <input
                aria-label="Найти адрес на карте"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Улица и дом"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void search();
                  }
                }}
              />
              <button type="button" disabled={busy} onClick={() => void search()}>
                Найти
              </button>
              <button type="button" className="secondary" disabled={locating} onClick={locate}>
                {locating ? "Определяем…" : "Моё место"}
              </button>
            </div>
            <Suspense fallback={<p className="notice notice--quiet">Загружаем карту…</p>}>
              <AddressMap
                center={address ?? CENTER}
                point={point}
                onPoint={(next) => void selectPoint(next)}
              />
            </Suspense>
            <div className="address-dialog__footer">
              <div className="field">
                <label className="field__label" htmlFor={id + "-label"}>
                  {busy ? "Определяем адрес…" : "Адрес для курьера"}
                </label>
                <input
                  id={id + "-label"}
                  value={label}
                  maxLength={200}
                  onChange={(event) => {
                    version.current += 1;
                    setBusy(false);
                    setLabel(event.target.value);
                  }}
                  placeholder="Город, улица, дом"
                />
              </div>
              {error && (
                <p className="notice notice--error" role="alert">
                  {error}
                </p>
              )}
              <button type="button" disabled={busy || !point} onClick={choose}>
                Доставить сюда
              </button>
            </div>
          </dialog>,
          document.body,
        )}
    </div>
  );
}
