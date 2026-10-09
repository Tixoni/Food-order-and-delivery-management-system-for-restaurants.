import { useMemo, type ReactNode } from "react";
import { ApolloProvider } from "@apollo/client";
import { useSession } from "../auth/session";
import { createApolloClient } from "./client";

/**
 * Клиент GraphQL создаётся один раз на всё время работы приложения.
 *
 * Пересоздавать его при входе и выходе нельзя: вместе с клиентом
 * пропадёт и кэш, а с ним — уже загруженное меню, которое придётся
 * запрашивать заново. Вместо этого клиент берёт токен функцией,
 * и смена пользователя на него не влияет.
 */
export function ApolloProviderWithSession({ children }: { children: ReactNode }) {
  const { accessToken } = useSession();
  const client = useMemo(() => createApolloClient(accessToken), [accessToken]);

  return <ApolloProvider client={client}>{children}</ApolloProvider>;
}
