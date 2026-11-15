// Where the slide canvas leaves its spelling squiggles for the surface's right-click handler (PrismSurface.contextMenu): per document, a function from window
// coordinates to the squiggled word under them (an issue of core/prism/lib/spelling-issues.mjs), or null.
type Hit = (clientX: number, clientY: number) => any | null;
const hits = new Map<string, Hit>();

export function setSquiggleHit(docId: string, hit: Hit | null): void { if (hit) hits.set(docId, hit); else hits.delete(docId); }
export const squiggleHit = (docId: string, clientX: number, clientY: number): any | null => hits.get(docId)?.(clientX, clientY) ?? null;
