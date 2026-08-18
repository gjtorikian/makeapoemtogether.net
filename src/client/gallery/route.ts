// The gallery's two client routes, decided from `location.pathname` exactly
// like /stage: a startup-time fact, never reducer state. Both fall through the
// server's SPA fallback (dev and prod), so a deep link into a poem is a real,
// pasteable URL rather than a fragment.
//
//   /gallery      the collection, newest first
//   /poem/:id     one poem's permalink
//
// A gallery visitor is NOT a room visitor: main.ts opens no socket on these
// routes, so browsing last night's poems can never claim a seat in tonight's.

export type GalleryRoute = { kind: "list" } | { kind: "poem"; id: string };

export const GALLERY_PATH = "/gallery";

export function poemPath(id: string): string {
  return `/poem/${encodeURIComponent(id)}`;
}

// Ids we mint are 12 hex chars, but this stays permissive about length and
// alphabet — the server is the authority on what exists, and a wrong-looking
// id should reach it and come back a clean "no such poem", not be silently
// rerouted to the room.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseGalleryRoute(pathname: string): GalleryRoute | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === GALLERY_PATH) return { kind: "list" };
  if (path.startsWith("/poem/")) {
    let id: string;
    try {
      id = decodeURIComponent(path.slice("/poem/".length));
    } catch {
      return null; // a malformed escape is not a poem link
    }
    // Nested paths (/poem/a/b) are not permalinks.
    if (ID.test(id)) return { kind: "poem", id };
  }
  return null;
}
