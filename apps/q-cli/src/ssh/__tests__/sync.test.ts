import { describe, it, expect } from "vitest";
import { computeSyncPlan } from "../sync.js";
import type { FileManifestEntry } from "@qode-agent/protocol";

function entry(path: string, sha: string, size = 100): FileManifestEntry {
  return { path, size, mtimeMs: 0, sha256: sha };
}

describe("computeSyncPlan", () => {
  it("returns empty plan for identical manifests", () => {
    const local = [entry("a.ts", "aaa"), entry("b.ts", "bbb")];
    const plan = computeSyncPlan(local, [...local]);
    expect(plan.pull).toHaveLength(0);
    expect(plan.push).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("classifies files only on local as push", () => {
    const local = [entry("a.ts", "aaa"), entry("b.ts", "bbb")];
    const remote = [entry("a.ts", "aaa")];
    const plan = computeSyncPlan(local, remote);
    expect(plan.push).toHaveLength(1);
    expect(plan.push[0]!.path).toBe("b.ts");
    expect(plan.pull).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("classifies files only on remote as pull", () => {
    const local = [entry("a.ts", "aaa")];
    const remote = [entry("a.ts", "aaa"), entry("c.ts", "ccc")];
    const plan = computeSyncPlan(local, remote);
    expect(plan.pull).toHaveLength(1);
    expect(plan.pull[0]!.path).toBe("c.ts");
    expect(plan.push).toHaveLength(0);
  });

  it("classifies differing files as conflicts (both pull and push)", () => {
    const local = [entry("a.ts", "aaa")];
    const remote = [entry("a.ts", "zzz")];
    const plan = computeSyncPlan(local, remote);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.push).toHaveLength(1);
    expect(plan.pull).toHaveLength(1);
  });

  it("handles a mix of all three cases", () => {
    const local = [
      entry("same.ts", "111"), // identical
      entry("local-only.ts", "222"), // push only
      entry("conflict.ts", "333"), // differs
    ];
    const remote = [
      entry("same.ts", "111"),
      entry("remote-only.ts", "444"), // pull only
      entry("conflict.ts", "999"), // differs
    ];
    const plan = computeSyncPlan(local, remote);
    expect(plan.pull).toHaveLength(2); // remote-only + conflict remote
    expect(plan.push).toHaveLength(2); // local-only + conflict local
    expect(plan.conflicts).toHaveLength(1);
  });
});