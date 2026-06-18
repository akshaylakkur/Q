/**
 * Config — File watcher for hot-reload.
 *
 * Uses fs.watch to monitor config files and trigger
 * config reload when they change.
 */
import { watch, type FSWatcher } from "node:fs";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * Callback invoked when a config file changes.
 */
export type ConfigChangeCallback = (changedFile: string) => void;

/**
 * Debounce helper to coalesce rapid file change events.
 */
function debounce(
  fn: (...args: any[]) => void,
  delay: number,
): (...args: any[]) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}

/**
 * ConfigWatcher — watches config files for changes and fires callbacks.
 *
 * Watches up to three config files:
 * - User-global: $HOME/.Q/config.toml
 * - Project-level: <cwd>/.q/config.toml
 * - Session-level: <cwd>/.q/session.toml (if exists)
 */
export class ConfigWatcher {
  private watchers: FSWatcher[] = [];
  private onChange: ConfigChangeCallback | null = null;
  private debouncedNotify: (...args: any[]) => void;

  constructor(
    private userConfigPath?: string | null,
    private projectDir?: string | null,
  ) {
    this.debouncedNotify = debounce(this.notify.bind(this), 300);
  }

  /**
   * Start watching config files.
   *
   * @param onChange Callback fired when a config file changes (debounced at 300ms).
   */
  start(onChange: ConfigChangeCallback): void {
    this.stop();
    this.onChange = onChange;

    const filesToWatch: string[] = [];

    // User-global config
    if (this.userConfigPath && existsSync(this.userConfigPath)) {
      filesToWatch.push(this.userConfigPath);
    }

    // Project-level config
    if (this.projectDir) {
      const projectConfig = resolve(this.projectDir, "config.toml");
      if (existsSync(projectConfig)) {
        filesToWatch.push(projectConfig);
      }

      // Session-level config
      const sessionConfig = resolve(this.projectDir, "session.toml");
      if (existsSync(sessionConfig)) {
        filesToWatch.push(sessionConfig);
      }
    }

    for (const filePath of filesToWatch) {
      // Watch the directory containing the file for more reliable
      // cross-platform behavior (fs.watch on individual files is
      // unreliable on macOS with some editors).
      const dir = dirname(filePath);
      if (!existsSync(dir)) continue;

      try {
        const w = watch(dir, (eventType: string | null, filename: string | null) => {
          if (!filename) return;
          const changedFile = resolve(dir, filename.toString());
          // Only respond to changes in our target files
          if (filesToWatch.includes(changedFile)) {
            this.debouncedNotify(changedFile);
          }
        });
        this.watchers.push(w);
      } catch {
        // Ignore watch failures (e.g., permission denied)
      }
    }
  }

  /**
   * Stop all watchers.
   */
  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore close errors
      }
    }
    this.watchers = [];
  }

  private notify(changedFile: string): void {
    if (this.onChange) {
      this.onChange(changedFile);
    }
  }
}
