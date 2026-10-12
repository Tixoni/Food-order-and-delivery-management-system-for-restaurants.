import { ApolloClient, HttpLink, InMemoryCache, from, split } from "@apollo/client";
import { setContext } from "@apollo/client/link/context";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";

/**
 * Клиент GraphQL.
 *
 * Кэш клиента служит хранилищем серверного состояния: отдельная библиотека
 * управления глобальным состоянием в приложении не заводится — при таком
 * разделении она не нужна (см. заметку «20 — Клиентские приложения»).
 *
 * Токен подставляется на каждый запрос функцией, а не берётся один раз
 * при создании клиента: он меняется при продлении сеанса, и клиент,
 * запомнивший первый токен, через пятнадцать минут начал бы получать
 * отказы.
 *
 * Запросы идут по HTTP, подписки — по WebSocket (graphql-ws) тем же
 * адресом `/graphql`. Соединение открывается при первой подписке и
 * закрывается, когда подписок не осталось; токен передаётся при каждом
 * подключении — после продления сеанса новое соединение получит новый.
 */
export function createApolloClient(accessToken: () => string | null): ApolloClient<unknown> {
  const auth = setContext((_operation, { headers }) => {
    const token = accessToken();
    return { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } };
  });

  const http = new HttpLink({
    uri: "/graphql",
    // Нужно для куки с refresh-token при обращении через общий источник.
    credentials: "same-origin",
  });

  const ws = new GraphQLWsLink(
    createClient({
      url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/graphql`,
      lazy: true,
      connectionParams: () => {
        const token = accessToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
      // Связь пропала (метро, смена сети) — переподключение с нарастающей паузой.
      retryAttempts: Infinity,
      shouldRetry: () => true,
    }),
  );

  const link = split(
    ({ query }) => {
      const definition = getMainDefinition(query);
      return definition.kind === "OperationDefinition" && definition.operation === "subscription";
    },
    ws,
    from([auth, http]),
  );

  return new ApolloClient({
    link,
    cache: new InMemoryCache(),
    defaultOptions: {
      watchQuery: {
        // Меню и списки меняются на сервере, и показывать их из кэша
        // бесконечно нельзя: кэш отдаётся сразу, а следом приходит
        // свежий ответ.
        fetchPolicy: "cache-and-network",
        nextFetchPolicy: "cache-first",
      },
    },
  });
}

/** Читаемая причина отказа: у ошибок GraphQL текст лежит в первом элементе списка. */
export function errorText(error: unknown): string {
  if (!error) return "";

  const graphQLErrors = (error as { graphQLErrors?: Array<{ message: string }> }).graphQLErrors;
  if (graphQLErrors?.length) return graphQLErrors[0].message;

  return error instanceof Error ? error.message : String(error);
}
