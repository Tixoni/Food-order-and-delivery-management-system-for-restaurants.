import { Module } from "@nestjs/common";
import { ServiceKitModule } from "@food-delivery/service-kit";

/**
 * Создано по образцу сервиса catalog.
 *
 * У шлюза нет собственной базы: он не владеет данными, а перенаправляет
 * и агрегирует запросы к сервисам. Поэтому и проверок готовности пока нет —
 * добавлять сюда зависимость от доступности соседей не следует: иначе
 * отказ одного сервиса выведет из строя вход в систему целиком (REL-2).
 */
@Module({
  imports: [
    ServiceKitModule.forRoot({
      serviceName: "gateway",
    }),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
