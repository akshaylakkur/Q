import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
  // Keep workspace + external packages external — they resolve at runtime.
  external: [
    "@qode-agent/agent-core",
    "@qode-agent/qollab",
    "@qode-agent/qprovs",
    "@qode-agent/qmain",
    "@qode-agent/telemetry",
    "@qode-agent/oauth",
  ],
});