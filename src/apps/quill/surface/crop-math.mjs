// The arithmetic of dragging a crop handle (Picture Format › Size › Crop), apart from the handles themselves.
//
// Translated from wordcraft crates/ui-egui/src/crop.rs (the fractions of the source, the 5% kept between two sides) at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

/** The crop fractions and frame size after dragging `handle` by (dx, dy) points (in the picture's own, unturned directions). */
export function dragCrop(handle, dx, dy, w, h, crop) {
  const c = [...crop];
  const fullW = w / Math.max(1 - c[0] - c[2], 0.05), fullH = h / Math.max(1 - c[1] - c[3], 0.05);
  let nw = w, nh = h;
  if (handle.includes('w')) { c[0] = clamp(c[0] + dx / fullW, 0, 0.95 - c[2]); nw = fullW * Math.max(1 - c[0] - c[2], 0.05); }
  if (handle.includes('e')) { c[2] = clamp(c[2] - dx / fullW, 0, 0.95 - c[0]); nw = fullW * Math.max(1 - c[0] - c[2], 0.05); }
  if (handle.includes('n')) { c[1] = clamp(c[1] + dy / fullH, 0, 0.95 - c[3]); nh = fullH * Math.max(1 - c[1] - c[3], 0.05); }
  if (handle.includes('s')) { c[3] = clamp(c[3] - dy / fullH, 0, 0.95 - c[1]); nh = fullH * Math.max(1 - c[1] - c[3], 0.05); }
  return {crop: c, width: nw, height: nh};
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

