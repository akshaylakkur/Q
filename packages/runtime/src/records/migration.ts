/**
 * Schema migration system for the JSONL wire format.
 *
 * The wire format is versioned (starting at version 1).
 * Each migration transforms old-style records to the current format.
 * All pending migrations are run on session resume, and the file is
 * rewritten if any migration was applied.
 */

import type { SessionRecord } from "./types.js";
import { readRecords, rewriteRecords } from "./wire.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A migration function that transforms an array of session records
 * from the previous version to the current version.
 */
export type Migration = (records: SessionRecord[]) => SessionRecord[];

/**
 * Migration registry: maps from wire format version number to a migration
 * function that upgrades records FROM that version TO the next version.
 *
 * Example: { 1: migration1to2 } means "records at version 1 are upgraded
 * to version 2 by running migration1to2".
 */
export type MigrationMap = Record<number, Migration>;

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

/**
 * Empty migration registry.  At version 1 the wire format is initial,
 * so there are no migrations yet.  As the schema evolves, register
 * new migrations here.
 *
 * The key matches the `protocolVersion` stored in the metadata record
 * of the session being loaded.  Each migration function receives records
 * at that version and must return records at version + 1.
 */
const migrations: MigrationMap = {
  // Example future migration (uncomment when schema evolves):
  // 1: upgradeV1ToV2,
};

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Get the maximum (latest) version supported by the migration registry.
 */
export function getLatestVersion(): number {
  const keys = Object.keys(migrations).map(Number);
  if (keys.length === 0) return 1; // initial version
  return Math.max(...keys) + 1;
}

/**
 * Resolve the current protocol version from a list of session records.
 * Looks for the metadata record and reads `protocolVersion`.
 * Falls back to 1 if no metadata record is found.
 */
export function resolveProtocolVersion(records: SessionRecord[]): number {
  for (const r of records) {
    if (r.type === "metadata" && "protocolVersion" in r) {
      return (r as { protocolVersion: number }).protocolVersion;
    }
  }
  return 1;
}

/**
 * Run all pending migrations on a set of records.
 * Returns the migrated records and a boolean indicating whether
 * the wire file needs to be rewritten.
 */
export function runMigrations(
  records: SessionRecord[],
  currentVersion?: number,
): { migrated: SessionRecord[]; didMigrate: boolean; targetVersion: number } {
  const fromVersion = currentVersion ?? resolveProtocolVersion(records);
  const maxVersion = getLatestVersion();

  if (fromVersion >= maxVersion) {
    return { migrated: records, didMigrate: false, targetVersion: fromVersion };
  }

  let result = records;

  // Run migrations sequentially: fromVersion -> fromVersion+1 -> ... -> maxVersion
  for (let v = fromVersion; v < maxVersion; v++) {
    const migration = migrations[v];
    if (migration) {
      result = migration(result);
    }
  }

  return { migrated: result, didMigrate: true, targetVersion: maxVersion };
}

/**
 * Migrate a wire file in-place.
 * Reads records, runs pending migrations, rewrites the file if needed.
 * Returns the number of records after migration, or 0 if the file was empty.
 */
export async function migrateWireFile(wirePath: string, currentVersion?: number): Promise<{
  recordCount: number;
  didMigrate: boolean;
  targetVersion: number;
}> {
  const records = await readRecords(wirePath);
  if (records.length === 0) {
    return { recordCount: 0, didMigrate: false, targetVersion: currentVersion ?? 1 };
  }

  const { migrated, didMigrate, targetVersion } = runMigrations(records, currentVersion);

  if (didMigrate) {
    rewriteRecords(wirePath, migrated);
  }

  return {
    recordCount: migrated.length,
    didMigrate,
    targetVersion,
  };
}