import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type PluginOption } from "vite";
// Type-only (erased at build): `ssrLoadModule` hands back `any`, and the dev
// middleware below should still be checked against the real handler's shape.
import type { HttpReply } from "./src/server/galleryApi.ts";

// Dev-only: run the room WebSocket backend *inside* Vite's dev server so
// `npm run dev` is a working full-stack app, not just static screens. Without
// it the client's socket never connects and actions like "Launch poem" silently
// no-op. Mounted at /ws (and only /ws) so it never collides with Vite's own HMR
// WebSocket; production serves the same /ws from src/server/index.ts via the
// same shared `wireRoom`.
function roomDevServer(): PluginOption {
  const roomSocket = fileURLToPath(
    new URL("./src/server/roomSocket.ts", import.meta.url),
  );
  const archiveModule = fileURLToPath(
    new URL("./src/server/archive.ts", import.meta.url),
  );
  const galleryApiModule = fileURLToPath(
    new URL("./src/server/galleryApi.ts", import.meta.url),
  );
  // Everything the dev-server-hosted backend is built from. The engine is in
  // here too: the composer now runs server-side (it holds the OpenRouter key),
  // so editing it must restart the room rather than hot-reload the browser.
  const backendSources = ["./src/room/", "./src/engine/", "./src/server/"].map(
    (dir) => fileURLToPath(new URL(dir, import.meta.url)),
  );
  return {
    name: "room-dev-server",
    apply: "serve",
    async configureServer(server) {
      // Vite only exposes VITE_-prefixed vars to the client, and OPENROUTER_API_KEY
      // is deliberately unprefixed so it can never be inlined into the browser
      // bundle. Loading it into process.env here — where only the dev server's
      // Node context can read it — is what makes `npm run dev` behave like
      // production without putting the key anywhere near the client.
      const env = loadEnv(server.config.mode, process.cwd(), "");
      for (const key of [
        "DATA_DIR",
        "OPENROUTER_API_KEY",
        "OPENROUTER_MODEL",
        "OPENROUTER_CLUE_MODEL",
        "OPENROUTER_TIMEOUT_MS",
        "OPENROUTER_CLUE_TIMEOUT_MS",
        "PUBLIC_URL",
      ]) {
        if (env[key] && !process.env[key]) process.env[key] = env[key];
      }

      const { WebSocketServer } = await import("ws");
      // Load the shared wiring through Vite so its TS + engine deps transform
      // exactly as they do in the client/prod builds.
      const { wireRoom } = await server.ssrLoadModule(roomSocket);
      // Same for the gallery's REST surface: `npm run dev` serves /api/poems
      // from the same handler and the same DATA_DIR that production uses, so a
      // poem made in dev is browsable in dev.
      const { createArchive } = await server.ssrLoadModule(archiveModule);
      const { galleryApi } = await server.ssrLoadModule(galleryApiModule);
      const archive = createArchive();
      const gallery = galleryApi(archive);
      server.middlewares.use((req, res, next) => {
        void gallery(req.method ?? "GET", req.url ?? "/").then((reply: HttpReply | null) => {
          if (!reply) return next(); // not ours — Vite serves the SPA
          res.statusCode = reply.status;
          res.setHeader("content-type", reply.type);
          res.setHeader("cache-control", reply.cache);
          res.end(reply.body);
        });
      });
      const wss = new WebSocketServer({ noServer: true });
      const stopRoom = wireRoom(wss, { archive }) as () => void;
      server.httpServer?.once("close", stopRoom);
      server.httpServer?.on("upgrade", (req, socket, head) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname !== "/ws") return; // let Vite HMR handle its own upgrades
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      });
    },
    async handleHotUpdate(ctx) {
      // Vite hot-reloads browser modules but keeps this in-memory room alive.
      // Restart the dev server for backend changes so its WS protocol cannot
      // drift from the client protocol during development.
      if (backendSources.some((dir) => ctx.file.startsWith(dir))) {
        await ctx.server.restart();
        return [];
      }
    },
  };
}

// The client lives in src/client and builds into dist/client. The single Node
// process (Phase 2+) serves this built output alongside the WS + REST endpoints.
export default defineConfig({
  root: "src/client",
  plugins: [roomDevServer()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
