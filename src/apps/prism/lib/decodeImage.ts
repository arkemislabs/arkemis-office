// Any raster picture the browser can open (JPEG, GIF, WebP, BMP...) as straight RGBA, for the host's
// `decodeImage`: Picture Format > Remove Background and Artistic Effects work on pixels, and the
// command module reads PNG itself (core/prism/lib/raster.mjs).

/** The pixels of `bytes`, or null when the browser can't decode them. */
export async function decodeImage(bytes: Uint8Array): Promise<{width: number; height: number; data: Uint8ClampedArray} | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return {width: d.width, height: d.height, data: d.data};
  } catch { return null; }
}

/** Straight RGBA encoded as `type` (JPEG or PNG) bytes, or null when the browser can't. */
export async function encodeImage(img: {width: number; height: number; data: Uint8ClampedArray}, type: string, quality = 0.85): Promise<Uint8Array | null> {
  try {
    const canvas = new OffscreenCanvas(img.width, img.height);
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const blob = await canvas.convertToBlob({type, quality});
    return blob.type === type ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; }
}
