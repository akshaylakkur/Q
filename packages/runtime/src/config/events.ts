/**
 * Config — Event emitter for config change notifications.
 *
 * Lightweight typed event emitter used by ConfigStore
 * to notify listeners of config changes at runtime.
 */

export type ConfigChangeEvent = {
  /** Which tier(s) changed */
  tier: string;
  /** Keys that changed (dot notation) */
  changedKeys: string[];
  /** The full resolved config after the change */
  config: Record<string, unknown>;
};

export type ConfigChangeListener = (event: ConfigChangeEvent) => void;

/**
 * Minimal typed event emitter for config changes.
 */
export class ConfigEventEmitter {
  private listeners: Map<string, Set<ConfigChangeListener>> = new Map();

  on(event: string, listener: ConfigChangeListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  off(event: string, listener: ConfigChangeListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: ConfigChangeEvent): void {
    this.listeners.get(event)?.forEach((listener) => {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors to prevent cascading failures
      }
    });
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
