/**
 * Color Palette — Revamped with high-contrast, readable colors.
 *
 * Key changes from the original:
 * - Primary changed from purple (#7C3AED) to a vibrant cyan (#06B6D4)
 *   which is much more visible against dark backgrounds.
 * - Added dedicated colors for diffs, code highlights.
 * - Labels ("You", "Qode Agent") use bold, distinct colors.
 * - Dim text uses a softer gray that's still readable.
 */

import type { ColorPalette } from "../types.js";

/**
 * Dark theme palette — optimized for readability on dark terminals.
 */
export const DARK_PALETTE: ColorPalette = {
  // Primary accent — vibrant cyan, very readable on dark backgrounds
  primary: "#06B6D4",
  secondary: "#8B5CF6",
  success: "#22C55E",
  warning: "#F59E0B",
  error: "#EF4444",
  info: "#3B82F6",

  // Text colors
  text: "#E2E8F0",
  textDim: "#94A3B8",
  textBright: "#F8FAFC",

  // UI chrome
  border: "#334155",
  background: "#0F172A",
  surface: "#1E293B",
  accent: "#A78BFA",

  // Role-specific
  roleUser: "#22D3EE",
  roleAssistant: "#A78BFA",
  roleTool: "#F59E0B",

  // Diff colors
  diffAdded: "#4ADE80",
  diffAddedStrong: "#22C55E",
  diffRemoved: "#FB7185",
  diffRemovedStrong: "#EF4444",
  diffGutter: "#475569",
  diffMeta: "#64748B",

  // Code
  codeHighlight: "#2D3748",
  codeText: "#E2E8F0",

  // Status
  statusInfo: "#38BDF8",
  statusSuccess: "#4ADE80",
  statusWarning: "#FBBF24",
  statusError: "#F87171",
};

/**
 * Light theme palette — optimized for readability on light terminals.
 */
export const LIGHT_PALETTE: ColorPalette = {
  primary: "#0891B2",
  secondary: "#7C3AED",
  success: "#16A34A",
  warning: "#D97706",
  error: "#DC2626",
  info: "#2563EB",

  text: "#1E293B",
  textDim: "#64748B",
  textBright: "#0F172A",

  border: "#CBD5E1",
  background: "#F8FAFC",
  surface: "#F1F5F9",
  accent: "#8B5CF6",

  roleUser: "#0891B2",
  roleAssistant: "#7C3AED",
  roleTool: "#D97706",

  diffAdded: "#16A34A",
  diffAddedStrong: "#15803D",
  diffRemoved: "#DC2626",
  diffRemovedStrong: "#B91C1C",
  diffGutter: "#94A3B8",
  diffMeta: "#94A3B8",

  codeHighlight: "#E2E8F0",
  codeText: "#1E293B",

  statusInfo: "#0284C7",
  statusSuccess: "#16A34A",
  statusWarning: "#D97706",
  statusError: "#DC2626",
};

/**
 * Get the palette for a given theme.
 */
export function getPalette(theme: "dark" | "light"): ColorPalette {
  return theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}