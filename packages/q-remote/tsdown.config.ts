import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/main.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  // No banner — the source file already has the shebang and tsdown preserves it.
  dts: false,
  sourcemap: false,
  minify: true,
  platform: "node",
  target: "node22",
  // Bundle all workspace dependencies into a single self-contained file
  // so the tarball can be npm install -g'd on a bare remote without
  // needing the monorepo's node_modules.
  deps: {
    alwaysBundle: [
      "@qode-agent/runtime",
      "@qode-agent/agent-core",
      "@qode-agent/qprovs",
      "@qode-agent/qmain",
      "@qode-agent/protocol",
    ],
  },
});