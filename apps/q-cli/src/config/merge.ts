/**
 * Config — Deep merge utilities for tiered config resolution.
 *
 * Provides proper deep-merge semantics:
 * - Scalars override (last writer wins)
 * - Lists replace entirely
 * - Dicts merge recursively
 * - `undefined` in source leaves target unchanged
 * - `null` in source overrides target
 */
export function deepMerge<T>(target: T, source: unknown): T {
  // undefined source → no change
  if (source === undefined) {
    return target;
  }

  // null source → override with null
  if (source === null) {
    return null as unknown as T;
  }

  // null/undefined target → use source
  if (target === null || target === undefined) {
    return source as T;
  }

  // Both are plain objects → recursive merge
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target as Record<string, unknown> };
    for (const key of Object.keys(source as Record<string, unknown>)) {
      const srcVal = (source as Record<string, unknown>)[key];
      const tgtVal = (result as Record<string, unknown>)[key];
      if (srcVal === undefined) {
        continue;
      }
      (result as Record<string, unknown>)[key] = deepMerge(tgtVal, srcVal);
    }
    return result as unknown as T;
  }

  // Source is array → replace target entirely
  if (Array.isArray(source)) {
    return source as unknown as T;
  }

  // Source is scalar → override
  return source as unknown as T;
}

/**
 * Check if a value is a plain object (not array, not null, not special).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return false;
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-clone a value, handling plain objects and arrays.
 */
export function deepClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(deepClone) as unknown as T;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = deepClone((value as Record<string, unknown>)[key]);
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * Set a nested value by dot-notation path.
 * Creates intermediate objects as needed.
 */
export function setByDotPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastPart = parts[parts.length - 1]!;
  current[lastPart] = value;
}

/**
 * Get a nested value by dot-notation path.
 * Returns `undefined` if the path doesn't exist.
 */
export function getByDotPath(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
