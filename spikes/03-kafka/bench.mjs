/**
 * Спайк 3. Замер брокера сообщений.
 *
 * 1. Пропускная способность записи событий заказа.
 * 2. Пропускная способность чтения.
 * 3. ГЛАВНОЕ: сохраняется ли порядок событий внутри одного заказа.
 *    На этом держится корректность конечного автомата: событие «доставлен»
 *    не должно прийти раньше события «забран».
 */
import { Kafka, logLevel } from "kafkajs";

const BROKER = process.env.BROKER ?? "localhost:9092";
const TOPIC = "order.events";
const ORDERS = 500; // различных заказов
const EVENTS_PER_ORDER = 40; // событий на заказ
const TOTAL = ORDERS * EVENTS_PER_ORDER;
const PARTITIONS = 3;

const STAGES = [
  "OrderPlaced",
  "OrderPaid",
  "OrderConfirmed",
  "OrderCooking",
  "OrderReady",
  "CourierAssigned",
  "OrderPickedUp",
  "OrderDelivered",
];

const head = (s) => console.log(`\n${"=".repeat(62)}\n${s}\n${"=".repeat(62)}`);

const kafka = new Kafka({
  clientId: "spike",
  brokers: [BROKER],
  logLevel: logLevel.ERROR,
  retry: { retries: 10, initialRetryTime: 500 },
});

async function main() {
  head("ПОДГОТОВКА");
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  if (existing.includes(TOPIC)) {
    await admin.deleteTopics({ topics: [TOPIC] });
    await new Promise((r) => setTimeout(r, 2000));
  }
  await admin.createTopics({
    topics: [{ topic: TOPIC, numPartitions: PARTITIONS, replicationFactor: 1 }],
  });
  console.log(`  топик ${TOPIC} создан, партиций: ${PARTITIONS}`);
  await admin.disconnect();

  head(`ЗАПИСЬ. ${TOTAL.toLocaleString("ru")} событий по ${ORDERS} заказам`);
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();

  const t0 = performance.now();
  const BATCH = 500;
  let sent = 0;
  for (let i = 0; i < TOTAL; i += BATCH) {
    const messages = [];
    for (let j = 0; j < BATCH && i + j < TOTAL; j++) {
      const n = i + j;
      const orderId = `order-${n % ORDERS}`;
      const seq = Math.floor(n / ORDERS);
      messages.push({
        key: orderId, // ключ определяет партицию — от него зависит порядок
        value: JSON.stringify({
          messageId: `${orderId}-${seq}`,
          eventType: STAGES[seq % STAGES.length],
          aggregateId: orderId,
          seq,
          occurredAt: new Date().toISOString(),
          payload: { amount: 1000 + seq, comment: "проверка порядка событий" },
        }),
      });
    }
    await producer.send({ topic: TOPIC, messages });
    sent += messages.length;
  }
  const writeMs = performance.now() - t0;
  await producer.disconnect();
  console.log(
    `  записано: ${sent.toLocaleString("ru")} событий за ${(writeMs / 1000).toFixed(1)} с`,
  );
  console.log(
    `  пропускная способность: ${Math.round(sent / (writeMs / 1000)).toLocaleString("ru")} событий/с`,
  );

  head("ЧТЕНИЕ И ПРОВЕРКА ПОРЯДКА");
  const consumer = kafka.consumer({ groupId: `spike-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  const lastSeq = new Map(); // orderId -> последний увиденный номер
  const violations = [];
  let received = 0;
  const t1 = performance.now();

  await new Promise((resolve) => {
    consumer.run({
      eachMessage: async ({ message }) => {
        const e = JSON.parse(message.value.toString());
        const prev = lastSeq.get(e.aggregateId);
        if (prev !== undefined && e.seq < prev) {
          violations.push({ order: e.aggregateId, prev, got: e.seq });
        }
        lastSeq.set(e.aggregateId, e.seq);
        if (++received >= TOTAL) resolve();
      },
    });
  });

  const readMs = performance.now() - t1;
  await consumer.disconnect();

  console.log(
    `  прочитано: ${received.toLocaleString("ru")} событий за ${(readMs / 1000).toFixed(1)} с`,
  );
  console.log(
    `  пропускная способность: ${Math.round(received / (readMs / 1000)).toLocaleString("ru")} событий/с`,
  );
  console.log(`  различных заказов в потоке: ${lastSeq.size}`);
  if (violations.length === 0) {
    console.log(`  ✓ порядок событий внутри заказа НЕ нарушен ни разу`);
  } else {
    console.log(`  ✗ нарушений порядка: ${violations.length}`);
    console.log("   ", violations.slice(0, 5));
  }

  head("ИТОГ");
  console.log(`  запись:  ${Math.round(TOTAL / (writeMs / 1000)).toLocaleString("ru")} событий/с`);
  console.log(`  чтение:  ${Math.round(TOTAL / (readMs / 1000)).toLocaleString("ru")} событий/с`);
  console.log(`  порядок: ${violations.length === 0 ? "сохраняется" : "НАРУШАЕТСЯ"}`);
}

main().catch((e) => {
  console.error("\nОШИБКА:", e.message);
  process.exit(1);
});
