/**
 * Адрес доставки клиента — общий для витрины и меню.
 *
 * Запоминается в браузере между заходами: спрашивать его каждый раз —
 * значит заставлять клиента делать лишнюю работу. Это не персональные
 * данные в смысле учётной записи: адрес остаётся на устройстве клиента
 * и уходит на сервер только координатами при поиске ресторанов.
 */
export interface Address {
  label: string;
  latitude: number;
  longitude: number;
}

const STORAGE_KEY = "fd:address";

export function loadAddress(): Address | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as Address) : null;
  } catch {
    // Запрет на хранение в браузере не должен ломать витрину
    return null;
  }
}

export function saveAddress(address: Address): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(address));
  } catch {
    // см. loadAddress
  }
}

export function clearAddress(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // см. loadAddress
  }
}
