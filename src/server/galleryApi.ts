import type { PoemArchive } from "./archive.ts";

// The gallery's read-only REST surface, mounted at /api/poems by BOTH the
// production server (src/server/index.ts) and the Vite dev plugin — the same
// shared-handler discipline `wireRoom` uses for the socket, so the gallery
// cannot behave differently under `npm run dev` and `npm start`.
//
// Read-only on purpose: poems are written by the room, on reveal, and nothing
// a browser can send may create or delete one. That is why there is no auth
// here — there is no mutation to protect.

export interface HttpReply {
  status: number;
  type: string;
  cache: string;
  body: string;
}

const JSON_TYPE = "application/json; charset=utf-8";

// A poem written seconds ago must appear on a browse right now, and a phone
// that saw an empty gallery must not keep showing one.
const NO_STORE = "no-store";

export interface GalleryHandler {
  /** Returns null when the path is not ours, so the caller can fall through. */
  (method: string, url: string): Promise<HttpReply | null>;
}

function json(status: number, value: unknown): HttpReply {
  return {
    status,
    type: JSON_TYPE,
    body: JSON.stringify(value),
    cache: NO_STORE,
  };
}

export function galleryApi(archive: PoemArchive): GalleryHandler {
  return async function handle(method: string, url: string) {
    // A base is required to parse a request-target path; the host is never read.
    const parsed = new URL(url, "http://localhost");
    const path = parsed.pathname.replace(/\/+$/, ""); // tolerate a trailing slash

    if (path !== "/api/poems" && !path.startsWith("/api/poems/")) return null;

    // The path is ours from here on — every exit below is a real reply, never
    // a fall-through to the SPA (which would answer a fetch with HTML).
    if (method !== "GET" && method !== "HEAD") {
      return json(405, { error: "method-not-allowed" });
    }

    if (path === "/api/poems") {
      const rawLimit = parsed.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      const page = await archive.list({
        // A junk `?limit=abc` falls back to the default rather than NaN-ing
        // its way into an empty page.
        limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
        before: parsed.searchParams.get("before"),
      });
      return json(200, page);
    }

    const id = decodeURIComponent(path.slice("/api/poems/".length));
    if (id === "") return json(404, { error: "not-found" });
    const detail = await archive.get(id);
    // The same answer for a malformed id and an id that never existed: the
    // gallery is public, so there is nothing to learn from the difference.
    if (!detail) return json(404, { error: "not-found" });
    return json(200, detail);
  };
}
