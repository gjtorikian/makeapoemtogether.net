import type { Capabilities } from "./capabilities.ts";
import type { RoomVisibility } from "../../shared/rooms.ts";
import { el } from "./dom.ts";
import { flash } from "./poemActions.ts";

// The room's code, and the one gesture that gets it to someone else. A private
// poem is unreachable without this — the code is not listed anywhere and never
// will be — so it is rendered large enough to read off a table and copied as a
// whole join link, because a link is what actually travels through a group
// chat.
//
// Public rooms show it too: the code is the room's name, and a link still beats
// telling someone to find you in the lobby.

const RESULT_MS = 1800;

// The address a guest should open. Built from the page's own origin for exactly
// the reason the stage QR is: whatever this device reached the app on is the
// only address it can honestly promise works.
export function joinUrl(code: string): string {
  const url = new URL(location.href);
  url.pathname = "/";
  url.search = `?room=${code}`;
  url.hash = "";
  return url.href;
}

export function roomInvite(
  caps: Capabilities,
  code: string,
  visibility: RoomVisibility,
): HTMLElement {
  const resting = caps.canShare ? "Share link" : "Copy link";
  const button = el(
    "button",
    {
      class: "btn btn--small invite__action",
      type: "button",
      on: { click: () => void run() },
    },
    [resting],
  );

  async function run(): Promise<void> {
    const url = joinUrl(code);
    // The native sheet where there is one, the clipboard where there isn’t —
    // and the clipboard again if the sheet refuses. A dismissed sheet says
    // nothing, because dismissing it was the point.
    const result = caps.canShare ? await caps.share(url) : await caps.copy(url);
    if (result === "shared") flash(button, resting, "Shared!", "copied", RESULT_MS);
    else if (result === "copied") flash(button, resting, "Copied!", "copied", RESULT_MS);
  }

  return el("div", { class: `invite invite--${visibility}` }, [
    el("p", {
      class: "invite__label",
      text:
        visibility === "private"
          ? "Private — only people with this code can join"
          : "Public — anyone in the lobby can join",
    }),
    // Spaced in the accessible name so a screen reader says the characters
    // rather than trying to pronounce them as a word.
    el("p", {
      class: "invite__code",
      ariaLabel: `Room code: ${[...code].join(" ")}`,
      text: code,
    }),
    button,
  ]);
}
