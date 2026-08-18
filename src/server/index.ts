import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize as normalizePath } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { wireRoom } from "./roomSocket.ts";
import { createArchive } from "./archive.ts";
import { galleryApi } from "./galleryApi.ts";

// The production host: serves the built client over HTTP and mounts the room
// WebSocket at /ws. All realtime behavior lives in the shared `wireRoom` (so it
// is byte-for-byte identical under `npm run dev` and `npm start`); this file is
// just the HTTP server + static file serving.

// Load .env from the working directory so OPENROUTER_API_KEY can live in a file
// rather than the launch command. Node 22 has this built in — no dotenv needed.
// A real environment (systemd, a container) sets the variables directly and has
// no .env, which is why a missing file is not an error.
try {
  process.loadEnvFile();
} catch {
  // no .env — the process environment is the only source.
}

const PORT = Number(process.env.PORT ?? 3000);
// At runtime the server lives at dist/server/index.js, so the built client is a
// sibling at dist/client.
const CLIENT_DIR = fileURLToPath(new URL("../client", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

async function serveStatic(
  urlPath: string,
): Promise<{ status: number; type: string; body: Buffer | string }> {
  // /api/poems is matched before this by the request handler; /gallery and
  // /poem/:id are client routes and fall through to the SPA below on purpose.
  let rel = normalizePath(decodeURIComponent(urlPath.split("?")[0]));
  rel = rel.replace(/^([./\\])+/, ""); // strip leading traversal / slashes
  if (rel === "" || urlPath === "/") rel = "index.html";
  const filePath = join(CLIENT_DIR, rel);
  if (!filePath.startsWith(CLIENT_DIR)) {
    return { status: 403, type: "text/plain", body: "forbidden" };
  }
  try {
    const body = await readFile(filePath);
    return {
      status: 200,
      type: MIME[extname(filePath)] ?? "application/octet-stream",
      body,
    };
  } catch {
    // SPA fallback: hand back index.html so client-side routing can take over.
    try {
      const body = await readFile(join(CLIENT_DIR, "index.html"));
      return { status: 200, type: "text/html; charset=utf-8", body };
    } catch {
      return { status: 404, type: "text/plain", body: "not found" };
    }
  }
}

// One archive per process, shared by the writer (the room, on reveal) and the
// reader (the gallery API) — though nothing depends on it being the same
// object: the file on disk is the state, which is exactly why the dev server
// can serve the poems this one wrote.
const archive = createArchive();
const gallery = galleryApi(archive);

const httpServer = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  // The gallery API first; it answers null for anything that isn't /api/poems,
  // which then falls through to the static/SPA path below.
  void gallery(req.method ?? "GET", url).then((reply) => {
    if (reply) {
      res.writeHead(reply.status, {
        "content-type": reply.type,
        "cache-control": reply.cache,
      });
      res.end(reply.body);
      return;
    }
    return serveStatic(url).then(({ status, type, body }) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    });
  });
});

// Room socket at /ws; the HTTP handler above owns every other path.
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wireRoom(wss, { archive });

httpServer.listen(PORT, () => {
  console.log(`lets-make-a-poem listening on :${PORT}`);
});
