import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Настройка сборки клиентского приложения.
 *
 * Обращения к шлюзу проходят через перенаправление сервера разработки,
 * а не идут напрямую на другой порт. Причина — кука с refresh-token:
 * она привязана к источнику, и при обращении с одного порта на другой
 * браузер её не отправит. Перенаправление делает шлюз частью того же
 * источника, и поведение совпадает с рабочим окружением, где перед
 * приложением и шлюзом стоит общий обратный прокси.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/graphql": { target: "http://localhost:3000", changeOrigin: false },
      "/auth": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
