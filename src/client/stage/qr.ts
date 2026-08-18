import QRCode from "qrcode";

// The join QR, rendered client-side. The encoded string is exactly
// `location.origin` (contract decision): the stage laptop is already sitting on
// the URL guests should join, so there is no env var to deliver and no server
// round-trip to make — the QR is only ever as good as the address bar.
//
// Drawn at a fixed, generous pixel size and scaled by CSS: QR modules are
// binary, so `image-rendering: pixelated` keeps the edges crisp at any
// projector size without re-rendering.
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
  }).catch(() => canvas.remove());
  return canvas;
}
