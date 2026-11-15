// Scanned Image: the text in a picture, read offline. The picture (a data URL or base64 of a PNG,
// JPEG, GIF, WebP or BMP) is drawn onto a canvas, saved as a PNG no larger than OCR takes, and handed
// to the app's OCR worker in the main process (the engine of the PDF app's Recognize Text; English
// language data in assets/ocr, no network).

const MAX_SIDE = 3000;
const MAX_PIXELS = 20_000_000;

export async function ocrImage(image: string): Promise<{text: string; confidence: number}> {
  const url = /^data:/i.test(image) ? image : `data:image/png;base64,${image}`;
  const el = new Image();
  el.decoding = 'async';
  await new Promise<void>((resolve, reject) => { el.onload = () => resolve(); el.onerror = () => reject(new Error('The picture could not be read')); el.src = url; });
  const w0 = el.naturalWidth, h0 = el.naturalHeight;
  if (!w0 || !h0) throw new Error('The picture has no size');
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0), Math.sqrt(MAX_PIXELS / (w0 * h0)));
  const width = Math.max(1, Math.round(w0 * scale)), height = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('The picture could not be drawn');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, width, height);
  g.drawImage(el, 0, 0, width, height);
  const png = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  const studio = (window as any).studio;
  if (typeof studio?.ocrImage !== 'function') throw new Error('Text recognition is not available here');
  return studio.ocrImage(png, width, height);
}
