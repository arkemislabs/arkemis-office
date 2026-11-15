// Insert › Icons: Lucide stroke icons as custom geometry. The paths are Lucide 1.56.0 centerlines
// (24×24, fill none), converted to DeckCraft's `M`/`L`/`C`/`Q`/`Z` syntax when inserted, so the
// shape is a stroked outline rather than a filled silhouette or an SVG picture.
// Translated from deckcraft crates/engine/src/icons.rs and icon_data.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf (SVG path parsing as kurbo's `BezPath::from_svg`, arcs
// as cubic Béziers). MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Icon data: Lucide 1.56.0 (commit 440a1e1dfb1e712505308da46bead3c28b1f1398), ISC; Feather-derived
// icons MIT. U:prism/insert. No DOM, no Node built-ins.

/** Design size of every icon, in path units (Lucide's viewBox is `0 0 24 24`). */
export const VIEW = 24;

const ic = (name, label, category, stroke, d) => Object.freeze({name, label, category, stroke, d});
/** Every icon, in gallery order. Independent subpaths (separate SVG elements) are separated by ` | `. */
export const ICONS = Object.freeze([
  ic("arrow-up", "Arrow up", "Arrows", 2, "m5 12 7-7 7 7 | M12 19V5"),
  ic("arrow-down", "Arrow down", "Arrows", 2, "M12 5v14 | m19 12-7 7-7-7"),
  ic("arrow-left", "Arrow left", "Arrows", 2, "m12 19-7-7 7-7 | M19 12H5"),
  ic("arrow-right", "Arrow right", "Arrows", 2, "M5 12h14 | m12 5 7 7-7 7"),
  ic("chevron-right", "Chevron", "Arrows", 2, "m9 18 6-6-6-6"),
  ic("undo-2", "Undo", "Arrows", 2, "M9 14 4 9l5-5 | M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"),
  ic("refresh-cw", "Refresh", "Arrows", 2, "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 | M21 3v5h-5 | M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 | M8 16H3v5"),
  ic("move", "Move", "Arrows", 2, "M12 2v20 | m15 19-3 3-3-3 | m19 9 3 3-3 3 | M2 12h20 | m5 9-3 3 3 3 | m9 5 3-3 3 3"),
  ic("check", "Check", "Marks", 2, "M20 6 9 17l-5-5"),
  ic("x", "X", "Marks", 2, "M18 6 6 18 | m6 6 12 12"),
  ic("plus", "Plus", "Marks", 2, "M5 12h14 | M12 5v14"),
  ic("minus", "Minus", "Marks", 2, "M5 12h14"),
  ic("star", "Star", "Marks", 2, "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"),
  ic("heart", "Heart", "Marks", 2, "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"),
  ic("flag", "Flag", "Marks", 2, "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"),
  ic("bookmark", "Bookmark", "Marks", 2, "M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"),
  ic("award", "Award", "Marks", 2, "m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526 | M 6 8 A 6 6 0 0 1 12 2 A 6 6 0 0 1 18 8 A 6 6 0 0 1 12 14 A 6 6 0 0 1 6 8 Z"),
  ic("thumbs-up", "Thumbs up", "Marks", 2, "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z | M7 10v12"),
  ic("circle-check", "Check circle", "Marks", 2, "M 2 12 A 10 10 0 0 1 12 2 A 10 10 0 0 1 22 12 A 10 10 0 0 1 12 22 A 10 10 0 0 1 2 12 Z | m16 9-5.5 5.5L8 12"),
  ic("triangle-alert", "Warning", "Marks", 2, "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3 | M12 9v4 | M12 17h.01"),
  ic("user", "User", "People", 2, "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 | M 8 7 A 4 4 0 0 1 12 3 A 4 4 0 0 1 16 7 A 4 4 0 0 1 12 11 A 4 4 0 0 1 8 7 Z"),
  ic("users", "Users", "People", 2, "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 | M16 3.128a4 4 0 0 1 0 7.744 | M22 21v-2a4 4 0 0 0-3-3.87 | M 5 7 A 4 4 0 0 1 9 3 A 4 4 0 0 1 13 7 A 4 4 0 0 1 9 11 A 4 4 0 0 1 5 7 Z"),
  ic("circle-user", "Account", "People", 2, "M 2 12 A 10 10 0 0 1 12 2 A 10 10 0 0 1 22 12 A 10 10 0 0 1 12 22 A 10 10 0 0 1 2 12 Z | M 9 10 A 3 3 0 0 1 12 7 A 3 3 0 0 1 15 10 A 3 3 0 0 1 12 13 A 3 3 0 0 1 9 10 Z | M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"),
  ic("hand", "Hand", "People", 2, "M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2 | M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2 | M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8 | M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"),
  ic("calendar", "Calendar", "Time", 2, "M8 2v3 | M16 2v3 | M 5 3 H 19 A 2 2 0 0 1 21 5 V 19 A 2 2 0 0 1 19 21 H 5 A 2 2 0 0 1 3 19 V 5 A 2 2 0 0 1 5 3 Z | M3 9h18"),
  ic("clock", "Clock", "Time", 2, "M 2 12 A 10 10 0 0 1 12 2 A 10 10 0 0 1 22 12 A 10 10 0 0 1 12 22 A 10 10 0 0 1 2 12 Z | M12 6v6l4 2"),
  ic("hourglass", "Hourglass", "Time", 2, "M5 22h14 | M5 2h14 | M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22 | M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"),
  ic("timer", "Timer", "Time", 2, "M 10 2 L 14 2 | M 12 14 L 15 11 | M 4 14 A 8 8 0 0 1 12 6 A 8 8 0 0 1 20 14 A 8 8 0 0 1 12 22 A 8 8 0 0 1 4 14 Z"),
  ic("mail", "Mail", "Communication", 2, "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7 | M 4 4 H 20 A 2 2 0 0 1 22 6 V 18 A 2 2 0 0 1 20 20 H 4 A 2 2 0 0 1 2 18 V 6 A 2 2 0 0 1 4 4 Z"),
  ic("phone", "Phone", "Communication", 2, "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"),
  ic("message-circle", "Message", "Communication", 2, "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"),
  ic("bell", "Bell", "Communication", 2, "M10.268 21a2 2 0 0 0 3.464 0 | M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"),
  ic("megaphone", "Megaphone", "Communication", 2, "M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z | M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14 | M8 6v8"),
  ic("at-sign", "Mention", "Communication", 2, "M 8 12 A 4 4 0 0 1 12 8 A 4 4 0 0 1 16 12 A 4 4 0 0 1 12 16 A 4 4 0 0 1 8 12 Z | M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"),
  ic("chart-column", "Column chart", "Charts", 2, "M3 3v16a2 2 0 0 0 2 2h16 | M18 17V9 | M13 17V5 | M8 17v-3"),
  ic("chart-bar", "Bar chart", "Charts", 2, "M3 3v16a2 2 0 0 0 2 2h16 | M7 16h8 | M7 11h12 | M7 6h3"),
  ic("chart-pie", "Pie chart", "Charts", 2, "M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z | M21.21 15.89A10 10 0 1 1 8 2.83"),
  ic("trending-up", "Trend", "Charts", 2, "M16 7h6v6 | m22 7-8.5 8.5-5-5L2 17"),
  ic("target", "Target", "Charts", 2, "M 2 12 A 10 10 0 0 1 12 2 A 10 10 0 0 1 22 12 A 10 10 0 0 1 12 22 A 10 10 0 0 1 2 12 Z | M 6 12 A 6 6 0 0 1 12 6 A 6 6 0 0 1 18 12 A 6 6 0 0 1 12 18 A 6 6 0 0 1 6 12 Z | M 10 12 A 2 2 0 0 1 12 10 A 2 2 0 0 1 14 12 A 2 2 0 0 1 12 14 A 2 2 0 0 1 10 12 Z"),
  ic("lightbulb", "Idea", "Charts", 2, "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5 | M9 18h6 | M10 22h4"),
  ic("presentation", "Presentation", "Charts", 2, "M2 3h20 | M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3 | m7 21 5-5 5 5"),
  ic("file", "File", "Files", 2, "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z | M14 2v5a1 1 0 0 0 1 1h5"),
  ic("folder", "Folder", "Files", 2, "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"),
  ic("file-text", "Document", "Files", 2, "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z | M14 2v5a1 1 0 0 0 1 1h5 | M10 9H8 | M16 13H8 | M16 17H8"),
  ic("paperclip", "Attachment", "Files", 2, "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"),
  ic("clipboard", "Clipboard", "Files", 2, "M 9 2 H 15 A 1 1 0 0 1 16 3 V 5 A 1 1 0 0 1 15 6 H 9 A 1 1 0 0 1 8 5 V 3 A 1 1 0 0 1 9 2 Z | M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"),
  ic("link", "Link", "Files", 2, "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 | M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"),
  ic("download", "Download", "Files", 2, "M12 15V3 | M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 | m7 10 5 5 5-5"),
  ic("share-2", "Share", "Files", 2, "M 15 5 A 3 3 0 0 1 18 2 A 3 3 0 0 1 21 5 A 3 3 0 0 1 18 8 A 3 3 0 0 1 15 5 Z | M 3 12 A 3 3 0 0 1 6 9 A 3 3 0 0 1 9 12 A 3 3 0 0 1 6 15 A 3 3 0 0 1 3 12 Z | M 15 19 A 3 3 0 0 1 18 16 A 3 3 0 0 1 21 19 A 3 3 0 0 1 18 22 A 3 3 0 0 1 15 19 Z | M 8.59 13.51 L 15.42 17.49 | M 15.41 6.51 L 8.59 10.49"),
  ic("house", "Home", "Places", 2, "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8 | M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"),
  ic("map-pin", "Pin", "Places", 2, "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0 | M 9 10 A 3 3 0 0 1 12 7 A 3 3 0 0 1 15 10 A 3 3 0 0 1 12 13 A 3 3 0 0 1 9 10 Z"),
  ic("globe", "Globe", "Places", 2, "M 2 12 A 10 10 0 0 1 12 2 A 10 10 0 0 1 22 12 A 10 10 0 0 1 12 22 A 10 10 0 0 1 2 12 Z | M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20 | M2 12h20"),
  ic("building", "Building", "Places", 2, "M12 10h.01 | M12 14h.01 | M12 6h.01 | M16 10h.01 | M16 14h.01 | M16 6h.01 | M8 10h.01 | M8 14h.01 | M8 6h.01 | M9 22v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3 | M 6 2 H 18 A 2 2 0 0 1 20 4 V 20 A 2 2 0 0 1 18 22 H 6 A 2 2 0 0 1 4 20 V 4 A 2 2 0 0 1 6 2 Z"),
  ic("compass", "Compass", "Places", 2, "M 2 12 A 10 10 0 0 1 12 2 A 10 10 0 0 1 22 12 A 10 10 0 0 1 12 22 A 10 10 0 0 1 2 12 Z | m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"),
  ic("briefcase", "Briefcase", "Places", 2, "M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16 | M 4 6 H 20 A 2 2 0 0 1 22 8 V 18 A 2 2 0 0 1 20 20 H 4 A 2 2 0 0 1 2 18 V 8 A 2 2 0 0 1 4 6 Z"),
  ic("image", "Picture", "Media", 2, "M 5 3 H 19 A 2 2 0 0 1 21 5 V 19 A 2 2 0 0 1 19 21 H 5 A 2 2 0 0 1 3 19 V 5 A 2 2 0 0 1 5 3 Z | M 7 9 A 2 2 0 0 1 9 7 A 2 2 0 0 1 11 9 A 2 2 0 0 1 9 11 A 2 2 0 0 1 7 9 Z | m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"),
  ic("camera", "Camera", "Media", 2, "M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z | M 9 13 A 3 3 0 0 1 12 10 A 3 3 0 0 1 15 13 A 3 3 0 0 1 12 16 A 3 3 0 0 1 9 13 Z"),
  ic("play", "Play", "Media", 2, "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"),
  ic("clapperboard", "Clapperboard", "Media", 2, "m12.296 3.464 3.02 3.956 | M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z | M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z | m6.18 5.276 3.1 3.899"),
  ic("music", "Music", "Media", 2, "M9 18V5l12-2v13 | M 3 18 A 3 3 0 0 1 6 15 A 3 3 0 0 1 9 18 A 3 3 0 0 1 6 21 A 3 3 0 0 1 3 18 Z | M 15 16 A 3 3 0 0 1 18 13 A 3 3 0 0 1 21 16 A 3 3 0 0 1 18 19 A 3 3 0 0 1 15 16 Z"),
  ic("settings", "Settings", "Objects", 2, "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915 | M 9 12 A 3 3 0 0 1 12 9 A 3 3 0 0 1 15 12 A 3 3 0 0 1 12 15 A 3 3 0 0 1 9 12 Z"),
  ic("search", "Search", "Objects", 2, "m21 21-4.34-4.34 | M 3 11 A 8 8 0 0 1 11 3 A 8 8 0 0 1 19 11 A 8 8 0 0 1 11 19 A 8 8 0 0 1 3 11 Z"),
  ic("info", "Info", "Objects", 2, "M 2 12 A 10 10 0 0 1 12 2 A 10 10 0 0 1 22 12 A 10 10 0 0 1 12 22 A 10 10 0 0 1 2 12 Z | M12 16v-4 | M12 8h.01"),
  ic("circle-alert", "Alert", "Objects", 2, "M 2 12 A 10 10 0 0 1 12 2 A 10 10 0 0 1 22 12 A 10 10 0 0 1 12 22 A 10 10 0 0 1 2 12 Z | M 12 8 L 12 12 | M 12 16 L 12.01 16"),
  ic("lock", "Lock", "Objects", 2, "M 5 11 H 19 A 2 2 0 0 1 21 13 V 20 A 2 2 0 0 1 19 22 H 5 A 2 2 0 0 1 3 20 V 13 A 2 2 0 0 1 5 11 Z | M7 11V7a5 5 0 0 1 10 0v4"),
  ic("key", "Key", "Objects", 2, "m2 21 9.6-9.6 | m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19 | M 10 7.5 A 5.5 5.5 0 0 1 15.5 2 A 5.5 5.5 0 0 1 21 7.5 A 5.5 5.5 0 0 1 15.5 13 A 5.5 5.5 0 0 1 10 7.5 Z"),
  ic("zap", "Bolt", "Objects", 2, "M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"),
  ic("sun", "Sun", "Objects", 2, "M 8 12 A 4 4 0 0 1 12 8 A 4 4 0 0 1 16 12 A 4 4 0 0 1 12 16 A 4 4 0 0 1 8 12 Z | M12 2v2 | M12 20v2 | m4.93 4.93 1.41 1.41 | m17.66 17.66 1.41 1.41 | M2 12h2 | M20 12h2 | m6.34 17.66-1.41 1.41 | m19.07 4.93-1.41 1.41"),
  ic("moon", "Moon", "Objects", 2, "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"),
  ic("cloud", "Cloud", "Objects", 2, "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"),
]);

/** `find`: the Lucide id (`arrow-right`, `arrow_right`) or the gallery label (`Arrow right`). */
export function findIcon(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/_/g, '-');
  return ICONS.find(i => i.name === key || i.label.toLowerCase() === raw.toLowerCase()) ?? null;
}

/**
 * `stroke_width`: stroke width in points for a shape `w`×`h` points. Lucide's stroke is `stroke`
 * units on a 24-unit box, so a 72 pt icon is a 6 pt line.
 */
export function strokeWidth(icon, w, h) {
  const span = Math.min(Math.abs(Math.min(w, h)), 4000);
  const design = Number.isFinite(icon.stroke) && icon.stroke > 0 ? icon.stroke : 2;
  return Math.min(Math.max(span * design / VIEW, 0.25), 400);
}

// ---------------------------------------------------------------------------------------------
// SVG path data → absolute elements (kurbo `BezPath::from_svg`)

const NUM = /^[\s,]*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/;
const FLAG = /^[\s,]*([01])/;
const CMD = /^[\s,]*([MmLlHhVvCcSsQqTtAaZz])/;

/** Parse SVG path data into elements `{op:'M'|'L'|'Q'|'C'|'Z', pts}` in absolute coordinates. */
export function parseSvgPath(d) {
  let rest = String(d);
  const els = [];
  let cmd = null;
  let cur = {x: 0, y: 0}, start = {x: 0, y: 0}, lastCtrl = null, lastOp = null;
  const take = re => { const m = re.exec(rest); if (!m) return null; rest = rest.slice(m[0].length); return m[1]; };
  const n = () => { const v = take(NUM); if (v === null) throw new Error('bad path'); return Number(v); };
  const flag = () => { const v = take(FLAG); if (v === null) throw new Error('bad path'); return v === '1'; };
  const hasNum = () => NUM.test(rest);
  while (rest.trim()) {
    const c = take(CMD);
    if (c) cmd = c; else if (!cmd || !hasNum()) throw new Error('bad path');
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const pt = (x, y) => (rel ? {x: cur.x + x, y: cur.y + y} : {x, y});
    if (C === 'Z') { els.push({op: 'Z', pts: []}); cur = {...start}; lastCtrl = null; lastOp = 'Z'; continue; }
    if (C === 'M') {
      const p = pt(n(), n());
      els.push({op: 'M', pts: [p]});
      cur = p; start = p; lastCtrl = null; lastOp = 'M';
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') { const p = pt(n(), n()); els.push({op: 'L', pts: [p]}); cur = p; lastCtrl = null; lastOp = 'L'; }
    else if (C === 'H') { const x = n(); const p = {x: rel ? cur.x + x : x, y: cur.y}; els.push({op: 'L', pts: [p]}); cur = p; lastCtrl = null; lastOp = 'L'; }
    else if (C === 'V') { const y = n(); const p = {x: cur.x, y: rel ? cur.y + y : y}; els.push({op: 'L', pts: [p]}); cur = p; lastCtrl = null; lastOp = 'L'; }
    else if (C === 'C') {
      const a = pt(n(), n()), b = pt(n(), n()), p = pt(n(), n());
      els.push({op: 'C', pts: [a, b, p]}); cur = p; lastCtrl = b; lastOp = 'C';
    } else if (C === 'S') {
      const a = lastOp === 'C' && lastCtrl ? {x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y} : {...cur};
      const b = pt(n(), n()), p = pt(n(), n());
      els.push({op: 'C', pts: [a, b, p]}); cur = p; lastCtrl = b; lastOp = 'C';
    } else if (C === 'Q') {
      const a = pt(n(), n()), p = pt(n(), n());
      els.push({op: 'Q', pts: [a, p]}); cur = p; lastCtrl = a; lastOp = 'Q';
    } else if (C === 'T') {
      const a = lastOp === 'Q' && lastCtrl ? {x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y} : {...cur};
      const p = pt(n(), n());
      els.push({op: 'Q', pts: [a, p]}); cur = p; lastCtrl = a; lastOp = 'Q';
    } else if (C === 'A') {
      const rx = n(), ry = n(), rot = n(), large = flag(), sweep = flag();
      const p = pt(n(), n());
      for (const cc of arcToCubics(cur, p, rx, ry, rot, large, sweep)) els.push({op: 'C', pts: cc});
      cur = p; lastCtrl = null; lastOp = 'A';
    } else throw new Error('bad path');
  }
  return els;
}

/** An SVG elliptical arc from `p0` to `p1` as cubic Béziers (at most 90° each). */
function arcToCubics(p0, p1, rxIn, ryIn, rotDeg, large, sweep) {
  if (p0.x === p1.x && p0.y === p1.y) return [];
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (rx < 1e-12 || ry < 1e-12) return [[{...p0}, {...p1}, {...p1}]];
  const phi = rotDeg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cx1 = coef * (rx * y1 / ry), cy1 = coef * (-ry * x1 / rx);
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2, cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dth = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  else if (sweep && dth < 0) dth += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const delta = dth / segs;
  const t = 4 / 3 * Math.tan(delta / 4);
  const at = th => ({x: cx + rx * Math.cos(th) * cos - ry * Math.sin(th) * sin, y: cy + rx * Math.cos(th) * sin + ry * Math.sin(th) * cos});
  const deriv = th => ({x: -rx * Math.sin(th) * cos - ry * Math.cos(th) * sin, y: -rx * Math.sin(th) * sin + ry * Math.cos(th) * cos});
  const out = [];
  let th = th1;
  for (let k = 0; k < segs; k++) {
    const a = at(th), b = at(th + delta), da = deriv(th), db = deriv(th + delta);
    out.push([{x: a.x + t * da.x, y: a.y + t * da.y}, {x: b.x - t * db.x, y: b.y - t * db.y}, k === segs - 1 ? {...p1} : b]);
    th += delta;
  }
  return out;
}

/** `num`: at most four decimals, trailing zeros dropped, never `-0`. */
function num4(v) {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** `outline`: the icon's elements (` | ` resets the current point between independent subpaths). */
export function outline(name) {
  const icon = findIcon(name);
  if (!icon) return null;
  const els = [];
  try {
    for (const part of icon.d.split(' | ')) if (part.trim()) els.push(...parseSvgPath(part.trim()));
  } catch { return null; }
  return els.length ? els : null;
}

/** `path_data`: DeckCraft path syntax for `name`, in the 24×24 viewBox. */
export function pathData(name) {
  const els = outline(name);
  if (!els) return null;
  const out = [];
  let started = false;
  for (const e of els) {
    if (e.op === 'M') { out.push(`M ${num4(e.pts[0].x)} ${num4(e.pts[0].y)}`); started = true; }
    else if (!started) continue;
    else if (e.op === 'L') out.push(`L ${num4(e.pts[0].x)} ${num4(e.pts[0].y)}`);
    else if (e.op === 'Q') out.push(`Q ${num4(e.pts[0].x)} ${num4(e.pts[0].y)} ${num4(e.pts[1].x)} ${num4(e.pts[1].y)}`);
    else if (e.op === 'C') out.push(`C ${e.pts.map(q => `${num4(q.x)} ${num4(q.y)}`).join(' ')}`);
    else if (e.op === 'Z') out.push('Z');
  }
  return out.length ? out.join(' ') : null;
}
