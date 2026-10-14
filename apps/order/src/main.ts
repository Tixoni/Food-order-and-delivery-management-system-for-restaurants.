import "./tracing";
import "reflect-metadata";
import { bootstrapService } from "@food-delivery/service-kit";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";

const config = loadConfig();

void bootstrapService(AppModule, {
  serviceName: "order",
  port: config.port,
  logLevel: config.logLevel,
  nodeEnv: config.nodeEnv,
});
