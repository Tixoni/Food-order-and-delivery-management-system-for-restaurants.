#!/usr/bin/env node
/**
 * Сквозная проверка регистрации с подтверждением e-mail (AUTH-1)
 * на живых шлюзе, провайдере входа и почтовом сервере-ловушке.
 *
 *   node infra/verification/auth-register-e2e.mjs
 *
 * Что проверяется:
 *   1. слабый пароль отклоняется, учётная запись не создаётся;
 *   2. регистрация отвечает «письмо отправлено», письмо приходит в Mailpit;
 *   3. до перехода по ссылке войти нельзя, причина — EMAIL_NOT_VERIFIED,
 *      а неверный пароль по-прежнему даёт общий ответ;
 *   4. повторная регистрация на тот же адрес отвечает так же и шлёт письмо заново;
 *   5. после перехода по ссылке вход проходит, роль — client;
 *   6. повторная отправка письма для подтверждённого адреса ничего не шлёт.
 *
 * Адреса: GATEWAY_URL (по умолчанию http://localhost:13080 — прокси),
 *         MAILPIT_URL (по умолчанию http://localhost:18025).
 */

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:13080";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:18025";

const email = `e2e-${Date.now()}@example.com`;
const password = "e2e-password-1";
let failures = 0;

function check(condition, label, extra) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`, extra ?? "");
  }
}

async function post(path, body) {
  const response = await fetch(`${GATEWAY}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function messagesTo(address) {
  const query = new URLSearchParams({ query: `to:"${address}"` });
  const response = await fetch(`${MAILPIT}/api/v1/search?${query}`);
  const body = await response.json();
  return body.messages ?? [];
}

async function waitForMessages(address, count) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const messages = await messagesTo(address);
    if (messages.length >= count) return messages;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return messagesTo(address);
}

/** Ссылка подтверждения из текста письма. */
async function verificationLink(messageId) {
  const response = await fetch(`${MAILPIT}/api/v1/message/${messageId}`);
  const message = await response.json();
  const text = `${message.Text ?? ""}\n${message.HTML ?? ""}`;
  const match = text.match(/https?:\/\/[^\s"'<>]*action-token[^\s"'<>]*/);
  return match ? match[0].replaceAll("&amp;", "&") : null;
}

/**
 * Переход по ссылке так, как это сделал бы браузер: с куками и переходами.
 * Если ссылку открыли не в том браузере, где регистрировались, провайдер
 * сначала показывает страницу «подтвердите переход» со второй ссылкой.
 */
async function openLikeBrowser(startUrl) {
  const cookies = new Map();
  let url = startUrl;
  for (let hop = 0; hop < 10; hop += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const [pair] = header.split(";");
      const [key, ...value] = pair.split("=");
      cookies.set(key.trim(), value.join("="));
    }

    const location = response.headers.get("location");
    if (location) {
      url = new URL(location, url).toString();
      if (!url.includes("/realms/")) return { finalUrl: url, page: "" };
      continue;
    }

    const page = await response.text();
    const next = page.match(/href="([^"]*action-token[^"]*)"/);
    if (next && hop < 9) {
      url = new URL(next[1].replaceAll("&amp;", "&"), url).toString();
      continue;
    }
    return { finalUrl: url, page };
  }
  return { finalUrl: url, page: "" };
}

console.log(`Регистрация ${email}\n`);

console.log("1. Слабый пароль");
const weak = await post("/auth/register", { email, password: "short" });
check(weak.status === 400, "отказ 400", weak);

console.log("2. Регистрация и письмо");
const registered = await post("/auth/register", { email, password, name: "Проверка" });
check(registered.status === 202, "ответ 202 «письмо отправлено»", registered);
let messages = await waitForMessages(email, 1);
check(messages.length === 1, "письмо пришло в Mailpit", messages.length);

console.log("3. Вход до подтверждения");
const early = await post("/auth/login", { username: email, password });
check(early.status === 403, "вход закрыт (403)", early.status);
check(
  early.body.details?.reason === "EMAIL_NOT_VERIFIED",
  "причина EMAIL_NOT_VERIFIED",
  early.body,
);
const wrong = await post("/auth/login", { username: email, password: "wrong-password" });
check(
  wrong.status === 401 && !wrong.body.details?.reason,
  "неверный пароль — общий ответ 401 без причины",
  wrong,
);

console.log("4. Повторная регистрация на тот же адрес");
const again = await post("/auth/register", { email, password: "another-password" });
check(
  again.status === 202 && JSON.stringify(again.body) === JSON.stringify(registered.body),
  "ответ не отличается от первой регистрации",
  again,
);
messages = await waitForMessages(email, 2);
check(messages.length === 2, "письмо отправлено повторно", messages.length);

console.log("5. Переход по ссылке и вход");
const link = await verificationLink(messages[0].ID);
check(!!link, "в письме есть ссылка подтверждения");
const opened = link ? await openLikeBrowser(link) : { finalUrl: "" };
// Провайдер завершает переход своей страницей «учётная запись обновлена»
// с кнопкой возврата в приложение — на вход с отметкой о подтверждении.
check(
  opened.finalUrl.includes("/login?verified=1") ||
    /href="[^"]*\/login\?verified=1"/.test(opened.page ?? ""),
  "провайдер ведёт обратно в приложение, на вход",
  opened.finalUrl,
);
const login = await post("/auth/login", { username: email, password });
check(login.status === 200, "вход проходит", login.status);
check(login.body.user?.roles?.includes("client"), "роль client", login.body.user?.roles);
const staffRoles = ["manager", "kitchen", "courier", "operator", "admin"];
check(
  (login.body.user?.roles ?? []).every((role) => !staffRoles.includes(role)),
  "ролей сотрудников нет",
  login.body.user?.roles,
);

console.log("6. Повторное письмо для подтверждённого адреса");
const resend = await post("/auth/verification/resend", { email });
check(resend.status === 202, "ответ 202", resend);
await new Promise((resolve) => setTimeout(resolve, 1500));
check((await messagesTo(email)).length === 2, "новое письмо не отправлено");

console.log(failures === 0 ? "\nВсе проверки пройдены" : `\nНе пройдено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
