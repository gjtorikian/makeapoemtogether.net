// Bundles the TypeScript WS+HTTP server (src/server/index.ts) into a single
// runnable ESM file at dist/server/index.js, a sibling of the Vite-built client
// (dist/client). Node cannot run the source tree directly because its relative
// imports are extensionless; this step produces the artifact `npm start` runs.
// Dependencies (ws, compromise, pluralize) stay external and resolve from
// node_modules at runtime.
import { build } from "vite";

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    ssr: "src/server/index.ts",
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: { output: { entryFileNames: "index.js" } },
  },
});
