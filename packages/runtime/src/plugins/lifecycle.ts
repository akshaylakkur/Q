/**
 * PluginHookEngine — lightweight hook dispatch for plugin lifecycle events.
 *
 * Manages event subscriptions (hookEvent -> pluginId set) and fires events
 * to registered handlers in registration order. Supports blocking pre-use
 * hooks and transforming post-use hooks.
 *
 * Plugins subscribe hooks in two ways:
 * 1. Via context.hookEngine.on() inside their activate() function
 * 2. By declaring hook event names in the manifest (for cleanup tracking)
 *
 * This is consumed by the PluginManager and also made available to plugins
 * via PluginContext.hookEngine so plugins can subscribe hooks.
 */

import type { HookEvent, HookHandler, HookContextMap, ToolPreUseResult, ToolPostUseResult } from "./types.js";

// Handler entry tracking both handler and plugin ID for clean unsubscription.
interface HandlerEntry<E extends HookEvent> {
  readonly pluginId: string;
  readonly handler: HookHandler<E>;
}

export class PluginHookEngine {
  /** Event -> ordered list of handler entries. */
  private readonly subscriptions: Map<string, HandlerEntry<any>[]> = new Map();

  /** Events declared by each plugin (from manifest hooks array) — used for cleanup tracking. */
  private readonly declaredSubscriptions: Map<string, Set<string>> = new Map(); // pluginId -> Set<event>

  /**
   * Register a hook handler for a specific event.
   */
  on<E extends HookEvent>(event: E, pluginId: string, handler: HookHandler<E>): void {
    let handlers = this.subscriptions.get(event);
    if (!handlers) {
      handlers = [];
      this.subscriptions.set(event, handlers);
    }
    handlers.push({ pluginId, handler });

    // Track the subscription for cleanup
    let declared = this.declaredSubscriptions.get(pluginId);
    if (!declared) {
      declared = new Set();
      this.declaredSubscriptions.set(pluginId, declared);
    }
    declared.add(event);
  }

  /**
   * Track a hook event declaration from the manifest without registering a handler.
   * This ensures removeAllForPlugin() can clean up declarations even if the module
   * registered handlers via context.hookEngine.on() inside activate().
   */
  declareSubscription<E extends HookEvent>(event: E, pluginId: string): void {
    let declared = this.declaredSubscriptions.get(pluginId);
    if (!declared) {
      declared = new Set();
      this.declaredSubscriptions.set(pluginId, declared);
    }
    declared.add(event);
  }

  /**
   * Remove all handlers registered by a given plugin, and clear its declarations.
   */
  removeAllForPlugin(pluginId: string): void {
    for (const [event, handlers] of this.subscriptions.entries()) {
      const remaining = handlers.filter((h) => h.pluginId !== pluginId);
      if (remaining.length === 0) {
        this.subscriptions.delete(event);
      } else {
        this.subscriptions.set(event, remaining);
      }
    }
    this.declaredSubscriptions.delete(pluginId);
  }

  /**
   * Fire a hook event. All handlers are called in registration order.
   * For 'tool:preUse', the first handler that returns { block: true } stops
   * evaluation and returns the blocking result.
   * For 'tool:postUse', the first handler that returns { transformed: true }
   * wins (subsequent handlers are skipped).
   * For all other events, handlers are fire-and-forget.
   */
  async fire<E extends HookEvent>(
    event: E,
    context: HookContextMap[E],
  ): Promise<ToolPreUseResult | ToolPostUseResult | undefined> {
    const handlers = this.subscriptions.get(event);
    if (!handlers || handlers.length === 0) return undefined;

    if (event === 'tool:preUse') {
      // Blocking evaluation — first block wins
      for (const entry of handlers) {
        try {
          const result = await (entry.handler as HookHandler<'tool:preUse'>)(context as HookContextMap['tool:preUse']);
          if (result && result.block) {
            return result;
          }
        } catch {
          // Handler errors are non-fatal for pre-use — continue to next handler
        }
      }
      return { block: false };
    }

    if (event === 'tool:postUse') {
      // First transformation wins
      for (const entry of handlers) {
        try {
          const result = await (entry.handler as HookHandler<'tool:postUse'>)(context as HookContextMap['tool:postUse']);
          if (result && result.transformed) {
            return result;
          }
        } catch {
          // Handler errors are non-fatal
        }
      }
      return undefined;
    }

    // Fire-and-forget for all other events
    for (const entry of handlers) {
      try {
        await (entry.handler as (ctx: HookContextMap[E]) => void | Promise<void>)(context);
      } catch {
        // Handler errors are non-fatal
      }
    }
    return undefined;
  }

  /**
   * Check if any handlers are registered for a given event.
   * Checks both actual subscriptions and declared subscriptions (from manifest).
   */
  hasSubscribers(event: HookEvent): boolean {
    const handlers = this.subscriptions.get(event);
    if (handlers && handlers.length > 0) return true;
    // Also check if any plugin declared this event
    for (const events of this.declaredSubscriptions.values()) {
      if (events.has(event)) return true;
    }
    return false;
  }
}