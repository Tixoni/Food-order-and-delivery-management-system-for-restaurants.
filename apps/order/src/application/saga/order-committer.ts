import type {
  InboxMarker,
  LoadedOrder,
  OrderRepository,
  SagaStepRecord,
  ScheduledEntry,
} from "../ports/order.repository";
import type { OrderWorkflow, PlanOptions, WorkflowPlan } from "./order-workflow";

export interface CommitOptions {
  schedule?: readonly ScheduledEntry[];
  cancel?: readonly string[];
  completeEntryId?: string;
  steps?: readonly SagaStepRecord[];
  inbox?: InboxMarker;
  plan?: PlanOptions;
}

/**
 * Сохранение изменений заказа вместе со всем, что из них следует.
 *
 * Забирает у агрегата накопленные переходы, получает от процесса заказа
 * события, сроки и компенсации и отдаёт всё хранилищу одним изменением —
 * одной транзакцией. Общий путь для команд пользователя, шагов саги
 * и событий участников.
 */
export class OrderCommitter {
  constructor(
    private readonly repository: OrderRepository,
    private readonly workflow: OrderWorkflow,
  ) {}

  async commit(
    { order, saga }: LoadedOrder,
    now: Date,
    options: CommitOptions = {},
  ): Promise<WorkflowPlan> {
    const changes = order.pullChanges();
    const plan = this.workflow.plan(order, saga, changes, now, options.plan);
    await this.repository.save({
      order,
      saga,
      history: changes,
      events: plan.events,
      schedule: [...plan.schedule, ...(options.schedule ?? [])],
      cancel: [...plan.cancel, ...(options.cancel ?? [])],
      ...(options.completeEntryId ? { completeEntryId: options.completeEntryId } : {}),
      ...(options.steps ? { steps: options.steps } : {}),
      ...(options.inbox ? { inbox: options.inbox } : {}),
    });
    return plan;
  }
}

export const ORDER_COMMITTER = Symbol("OrderCommitter");
