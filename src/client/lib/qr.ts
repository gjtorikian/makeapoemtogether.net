import QRCode from "qrcode";

// A join QR, rendered client-side, for whatever address the caller passes: the
// origin on the stage's idle screen, this room's join link everywhere else.
// There is no env var to deliver and no server round-trip to make — the QR is
// only ever as good as the address bar the page was opened at, which is also
// the only address this device can honestly promise works.
//
// Drawn at a fixed, generous pixel size and scaled by CSS: QR modules are
// binary, so `image-rendering: pixelated` keeps the edges crisp at any size —
// a projector's or a phone's — without re-rendering.
const RENDER_PX = 1024;

// Rendering never throws (the client convention: failures become quieter UI,
// not exceptions). `qrcode` draws asynchronously; if the draw fails — canvas
// unavailable, an unencodable origin — the canvas removes itself and the
// printed URL beneath it (rendered unconditionally by the caller) carries the
// join path alone.
export function qrCanvas(text: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `QR code for ${text}`);
  QRCode.toCanvas(canvas, text, {
    // High error correction: a projector-washed or partially-glared code still
    // scans. Margin is the quiet zone (in modules) scanners rely on.
    errorCorrectionLevel: "H",
    margin: 2,
    width: RENDER_PX,
  })
    .then(() => {
      // `qrcode` writes `style="width:1024px;height:1024px"` onto the canvas as
      // it draws. An inline style beats every stylesheet rule, so leaving it
      // there means the QR renders at its full bitmap size and overflows
      // whatever it was placed in — none of the `--big` / `--corner` / invite
      // widths below ever take effect. Only the STYLE goes: the width/height
      // ATTRIBUTES are the bitmap resolution, and dropping those would leave a
      // 300px blur to scale up.
      canvas.removeAttribute("style");
    })
    .catch(() => canvas.remove());
  return canvas;
}
