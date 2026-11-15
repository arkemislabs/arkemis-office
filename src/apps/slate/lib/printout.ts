// File Printout (Insert › Files › File Printout): the pages of a PDF drawn as pictures, one per page,
// the way OneNote prints a file onto the page. pdf.js draws them (the same engine the PDF app
// paints with); a page picture is a PNG about 800 px wide. At most 100 pages are printed.

export const PRINTOUT_PAGE_WIDTH = 800;
export const PRINTOUT_MAX_PAGES = 100;

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));

export async function printoutPages(file: {name: string; data: string; mime: string}): Promise<string[]> {
  if (file.mime !== 'application/pdf') throw new Error(`${file.name} cannot be printed to a page here`);
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', document.baseURI).href;
  const task = pdfjs.getDocument({data: bytesOf(file.data), enableXfa: false, maxImageSize: 16_777_216, canvasMaxAreaInBytes: 64 * 1024 * 1024});
  try {
    const doc = await task.promise;
    const out: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, PRINTOUT_MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({scale: 1});
      const viewport = page.getViewport({scale: PRINTOUT_PAGE_WIDTH / base.width});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({canvas, viewport, background: '#ffffff'}).promise;
      out.push(canvas.toDataURL('image/png'));
      page.cleanup();
    }
    return out;
  } finally {
    void task.destroy();
  }
}
