import type { PoemDetail, PoemPage } from "../../shared/gallery.ts";

// The gallery's read side. Like capabilities.ts, nothing here throws: a venue's
// flaky wifi is an expected condition, so every failure comes back as a value
// the screens render as a retryable message.

export type Fetched<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

async function getJson<T>(url: string): Promise<Fetched<T>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    // Offline, DNS, connection refused — indistinguishable from here and all
    // the same to a reader: try again.
    return { ok: false, status: 0, message: "Couldn't reach the poems." };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, message: "That poem isn't here." };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, message: "Couldn't load the poems." };
  }
  try {
    return { ok: true, value: (await res.json()) as T };
  } catch {
    // A 200 that isn't JSON means something answered for the API that isn't
    // the API (a captive portal, the SPA fallback on a misconfigured host).
    return { ok: false, status: res.status, message: "Couldn't read the poems." };
  }
}

export function fetchPage(before: string | null): Promise<Fetched<PoemPage>> {
  const q = before ? `?before=${encodeURIComponent(before)}` : "";
  return getJson<PoemPage>(`/api/poems${q}`);
}

export function fetchPoem(id: string): Promise<Fetched<PoemDetail>> {
  return getJson<PoemDetail>(`/api/poems/${encodeURIComponent(id)}`);
}
