/** Параметры подбора курьеров. */
export interface DispatchSettings {
  /** DLV-3: радиус поиска от точки выдачи, метры. */
  radiusMeters: number;
  /** DLV-4: срок отклика на предложение, секунды. */
  offerTtlSeconds: number;
  /**
   * Позиция старше этого — курьер считается потерявшим связь и в подбор
   * не попадает: предлагать заказ тому, кто не на связи, значит терять
   * 90 секунд на каждом таком предложении.
   */
  freshSeconds: number;
}

export const DISPATCH_SETTINGS = Symbol("DispatchSettings");
