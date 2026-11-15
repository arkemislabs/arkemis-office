// Screen Clipping (Insert › Screen Clipping): the app's own window is captured by the main process
// (studio:capture-window, webContents.capturePage), the window dims, the person drags a rectangle and
// the clip is cropped from the capture. Esc or a click without a drag cancels. The overlay is the
// only thing drawn over the capture, and it is added after it, so it is not in the clip.

/** Crop a rectangle (CSS px of the window) from a capture; the capture may be at another pixel ratio. */
export function cropRect(capture: {width: number; height: number}, view: {width: number; height: number}, r: {x: number; y: number; w: number; h: number}) {
  const sx = capture.width / view.width, sy = capture.height / view.height;
  const x = Math.max(0, Math.round(r.x * sx)), y = Math.max(0, Math.round(r.y * sy));
  return {x, y, w: Math.max(1, Math.min(capture.width - x, Math.round(r.w * sx))), h: Math.max(1, Math.min(capture.height - y, Math.round(r.h * sy)))};
}

const load = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('The window could not be captured'));
  img.src = url;
});

/** Ask for a rectangle on a dimmed overlay; null when cancelled. */
function pickRect(): Promise<{x: number; y: number; w: number; h: number} | null> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'screen-clip-overlay';
    overlay.tabIndex = -1;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Screen Clipping: drag to select an area, Esc cancels');
    const box = document.createElement('div');
    box.className = 'screen-clip-box';
    const hint = document.createElement('div');
    hint.className = 'screen-clip-hint';
    hint.textContent = 'Drag to clip an area of this window. Esc cancels.';
    overlay.append(box, hint);
    document.body.append(overlay);
    overlay.focus();
    let start: {x: number; y: number} | null = null;
    const end = (r: {x: number; y: number; w: number; h: number} | null) => {
      window.removeEventListener('keydown', key, true);
      overlay.remove();
      resolve(r);
    };
    const rectOf = (e: PointerEvent) => ({x: Math.min(start!.x, e.clientX), y: Math.min(start!.y, e.clientY), w: Math.abs(e.clientX - start!.x), h: Math.abs(e.clientY - start!.y)});
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(null); } };
    window.addEventListener('keydown', key, true);
    overlay.addEventListener('pointerdown', e => {
      start = {x: e.clientX, y: e.clientY};
      hint.remove();
      try { overlay.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      Object.assign(box.style, {display: 'block', left: `${e.clientX}px`, top: `${e.clientY}px`, width: '0px', height: '0px'});
    });
    overlay.addEventListener('pointermove', e => {
      if (!start) return;
      const r = rectOf(e);
      Object.assign(box.style, {left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`});
    });
    overlay.addEventListener('pointerup', e => {
      if (!start) return;
      const r = rectOf(e);
      end(r.w >= 4 && r.h >= 4 ? r : null);
    });
  });
}

/** The clip as a PNG data URL, or null when cancelled. */
export async function captureClip(): Promise<string | null> {
  const studio = (window as any).studio;
  if (typeof studio?.captureWindow !== 'function') throw new Error('Clipping the window is not available here');
  const shot = await load(await studio.captureWindow());
  const rect = await pickRect();
  if (!rect) return null;
  const c = cropRect({width: shot.naturalWidth, height: shot.naturalHeight}, {width: window.innerWidth, height: window.innerHeight}, rect);
  const canvas = document.createElement('canvas');
  canvas.width = c.w;
  canvas.height = c.h;
  canvas.getContext('2d')!.drawImage(shot, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
  return canvas.toDataURL('image/png');
}
