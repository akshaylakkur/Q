import { defineConfig } from "tsdown";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  entry: ["./src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
  // Copy the bundled agent profiles (YAML files) into dist/profiles so the
  // built single-file bundle can still resolve them at runtime. The loader
  // walks up from `import.meta.url` looking for a `profiles/` directory
  // containing `rewriter.yaml` — when run from the dist output it lands
  // exactly here.
  copy: [
    {
      from: resolve(__dirname, "src/agent/profiles/*.yaml"),
      to: resolve(__dirname, "dist/profiles"),
    },
  ],
});
