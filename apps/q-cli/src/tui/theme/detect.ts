/**
 * Terminal theme detection — detects if the terminal uses a dark or light theme.
 */

import { execSync } from "node:child_process";

/**
 * Detect the terminal theme (dark or light).
 * Uses various heuristics to determine the terminal's color scheme.
 */
export async function detectTerminalTheme(): Promise<"dark" | "light"> {
  // Try macOS dark mode detection
  if (process.platform === "darwin") {
    try {
      const result = execSync(
        "defaults read -g AppleInterfaceStyle 2>/dev/null || echo 'Light'",
        { encoding: "utf-8", timeout: 1000 },
      ).trim();
      if (result.toLowerCase().includes("dark")) {
        return "dark";
      }
      return "light";
    } catch {
      // Fall through to other methods
    }
  }

  // Check COLORFGBG environment variable (used by many terminals)
  const colorFgBg = process.env.COLORFGBG;
  if (colorFgBg) {
    const parts = colorFgBg.split(";");
    const bg = parts[parts.length - 1];
    if (bg === "0" || bg === "default") {
      return "light"; // Light background
    }
    return "dark";
  }

  // Check terminal theme via OSC 4/10/11 queries (iTerm2, kitty, etc.)
  try {
    // We can't easily query the terminal in a non-blocking way,
    // so we fall back to a reasonable default
    return "dark";
  } catch {
    return "dark";
  }
}
