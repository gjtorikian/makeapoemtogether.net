import type { SavedPoem } from "../../shared/gallery.ts";
import type { Capabilities } from "../lib/capabilities.ts";
import { clear } from "../lib/dom.ts";
import { fetchPage, fetchPoem } from "./api.ts";
import { parseGalleryRoute } from "./route.ts";
import { ErrorScreen, GalleryList, LoadingScreen, PoemView } from "./screens.ts";

// The gallery's little runtime: routing, fetching, and the one piece of state
// the room's reducer would otherwise own (the accumulated page). It is
// deliberately its own boot path — no socket, no `AppState`, no reducer — so a
// reader browsing poems is invisible to the room and can never take a seat.

export function mountGallery(root: HTMLElement, caps: Capabilities): void {
  // The list, accumulated across "Show older" — the gallery's only state.
  let poems: SavedPoem[] = [];
  let nextBefore: string | null = null;
  let loadingMore = false;
  // Bumped on every navigation so a slow response for a screen the reader has
  // already left can never paint over the screen they are on.
  let token = 0;

  function paint(node: HTMLElement): void {
    clear(root);
    root.append(node);
  }

  function navigate(path: string): void {
    if (path === location.pathname) return;
    history.pushState({}, "", path);
    void show();
  }

  async function show(): Promise<void> {
    const route = parseGalleryRoute(location.pathname);
    // Only reachable by going BACK out of the gallery into a page this runtime
    // never rendered (the room). Hand it to the browser rather than guess.
    if (!route) {
      location.reload();
      return;
    }
    const mine = ++token;
    // Only the very first paint gets a loading screen. Later navigations keep
    // the current poem on screen until its replacement is ready — a browse
    // shouldn't strobe.
    if (!root.firstChild) paint(LoadingScreen());

    if (route.kind === "list") {
      poems = [];
      nextBefore = null;
      loadingMore = false;
      const res = await fetchPage(null);
      if (mine !== token) return;
      if (!res.ok) {
        paint(ErrorScreen(res.message, () => void show()));
        return;
      }
      poems = res.value.poems;
      nextBefore = res.value.nextBefore;
      paintList();
      return;
    }

    const res = await fetchPoem(route.id);
    if (mine !== token) return;
    if (!res.ok) {
      paint(ErrorScreen(res.message, () => void show()));
      return;
    }
    paint(PoemView({ detail: res.value, caps, navigate }));
    // A permalink opened cold starts at the top, not wherever the last screen
    // was scrolled to.
    window.scrollTo(0, 0);
  }

  function paintList(): void {
    paint(
      GalleryList({ poems, nextBefore, loadingMore, onOlder, navigate }),
    );
  }

  function onOlder(): void {
    if (loadingMore || !nextBefore) return;
    loadingMore = true;
    paintList(); // the button reads "Loading…" and stops accepting taps
    const cursor = nextBefore;
    const mine = token;
    void fetchPage(cursor).then((res) => {
      // A reader who navigated into a poem while the page was in flight keeps
      // that poem; the older page is simply dropped.
      if (mine !== token) return;
      loadingMore = false;
      if (res.ok) {
        poems = [...poems, ...res.value.poems];
        nextBefore = res.value.nextBefore;
      }
      // A failed "show older" leaves what is already on screen alone — the
      // button just comes back, which is the retry.
      paintList();
    });
  }

  window.addEventListener("popstate", () => void show());
  void show();
}
