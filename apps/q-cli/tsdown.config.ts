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
  sourcemap: true,
  minify: false,
  platform: "node",
  target: "node22",
  deps: {
    neverBundle: ["@xenova/transformers", "typescript"],
  },
});