// How a clip is heard while it plays: its volume, faded in and out over the trimmed length.
// Follows deckcraft crates/ui-egui/src/media.rs (fade and volume while playing) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

/** The volume a clip has `t` ms into its trimmed length of `length` ms: its own volume, faded in and out. */
export function fadedVolume(volume, t, length, fadeIn, fadeOut) {
  let k = 1;
  if (fadeIn > 0 && t < fadeIn) k = Math.min(k, Math.max(t, 0) / fadeIn);
  if (fadeOut > 0 && length > 0 && length - t < fadeOut) k = Math.min(k, Math.max(length - t, 0) / fadeOut);
  return Math.min(Math.max(volume * k, 0), 1);
}
