import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { SessionProvider } from "./auth/session";
import { ApolloProviderWithSession } from "./api/provider";
import { App } from "./App";
import "leaflet/dist/leaflet.css";
import "./styles.css";

/**
 * Порядок обёрток важен: сведения о сеансе нужны клиенту GraphQL,
 * чтобы подставлять токен, поэтому провайдер сеанса стоит снаружи.
 */
const root = document.getElementById("root");
if (!root) {
  throw new Error("в разметке страницы нет элемента с идентификатором root");
}

createRoot(root).render(
  <StrictMode>
    <SessionProvider>
      <ApolloProviderWithSession>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ApolloProviderWithSession>
    </SessionProvider>
  </StrictMode>,
);
