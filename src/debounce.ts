/**
 * Debounce por clave (chat). Junta ráfagas: cada `schedule` reinicia la espera y, al vencer,
 * ejecuta `run(key)` una sola vez. Nunca corre dos `run` a la vez para la misma clave: si llegan
 * mensajes durante una ejecución, se reprograma al terminar.
 */
export class KeyedDebouncer {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private readonly pendingRerun = new Set<string>();

  constructor(
    private readonly delayMs: number,
    private readonly run: (key: string) => Promise<void>,
    private readonly onError: (err: unknown, key: string) => void = () => undefined,
  ) {}

  schedule(key: string): void {
    if (this.inFlight.has(key)) {
      this.pendingRerun.add(key);
      return;
    }
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.flush(key);
      }, this.delayMs),
    );
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.pendingRerun.delete(key);
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pendingRerun.clear();
  }

  private async flush(key: string): Promise<void> {
    this.inFlight.add(key);
    try {
      await this.run(key);
    } catch (err) {
      this.onError(err, key);
    } finally {
      this.inFlight.delete(key);
      if (this.pendingRerun.delete(key)) this.schedule(key);
    }
  }
}
