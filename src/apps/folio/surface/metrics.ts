// The live page view's state for the `surface.view` query (src/apps/folio/ui-commands/surface.ts):
// the current page, the pages mounted, the zoom and the paint timings the bridge benchmark reads.

export interface ViewState {
  current: number; first: number; last: number; pages: number; zoom: number; scrollTop: number; scrollHeight: number;
  mounted: number; firstPaintMs: number | null; renders: {count: number; total: number; last: number};
  panel: string | null; migrating: boolean;
  goToPage(i: number, record?: boolean): void;
  /** The viewport, and showing a page rectangle (view points: x, y, width, height) as large as the window allows. */
  zoomToRect(page: number, rect: number[]): number;
  scrollTo(top: number): void;
  pointer(p: unknown): Promise<unknown>;
}

const views = new Map<string, ViewState>();
export const publish = (docId: string, state: ViewState) => { views.set(docId, state); };
export const viewOf = (docId: string) => views.get(docId) ?? null;
export const forget = (docId: string) => { views.delete(docId); };
