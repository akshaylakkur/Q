import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/main.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  dts: false,
  sourcemap: false,
  minify: true,
  platform: "node",
  target: "node22",
  // Bundle everything — no external deps.
  // @xenova/transformers is dynamically imported and will be excluded
  // at runtime with a graceful fallback.
});
