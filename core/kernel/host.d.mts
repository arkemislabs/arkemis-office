// Types for core/kernel/host.mjs (docs/architecture.md section 4.4).
export interface FontInfo { family: string; [key: string]: unknown }
export interface FontSpec { family: string; size: number; weight?: number | string; style?: string }
export interface Host {
  kind: 'renderer' | 'headless' | 'test';
  fonts(): Promise<FontInfo[]>;
  measureText?(font: FontSpec, text: string): {width: number; [key: string]: unknown};   // renderer only
  worker(op: {operation: string; [key: string]: unknown}): Promise<unknown>;
  pickFile?(opts: object): Promise<string | null>;                                        // renderer only
  pickImage?(): Promise<string | null>;
  /** Renderer only: the local profile name, the author of edits (History); nothing else about the person is read. */
  profileName?(): string | null;
  /** Recording and playback (Slate's Audio & Video): the renderer's media service, a stub in tests (src/shell/engine/mediaService.ts). */
  media?: {record(kind: 'audio' | 'video'): Promise<any>; play(id: string, o: any): Promise<void>; pause(id: string): Promise<void>; stop(id: string): Promise<void>; seek(id: string, t: number, o?: any): Promise<void>; position(id: string): Promise<{t: number} | null>};
  /** Renderer only: the system Open dialog for any file (all: no type filter); null on Cancel. */
  pickDocument?(opts?: {all?: boolean}): Promise<{name: string; format: string; data: string} | null>;
  /** Renderer only: drag a rectangle over this window; a PNG data URL of it, or null on Esc (Insert > Screen Clipping). */
  captureClip?(): Promise<string | null>;
  /** Renderer only: the pages of a PDF drawn as PNG data URLs (Insert > File Printout). */
  printoutPages?(file: {name: string; data: string; mime: string}): Promise<string[]>;
  /** Read the text in a picture (data URL or base64) offline: Slate's Scanned Image. */
  ocrImage?(image: string): Promise<{text: string; confidence: number}>;
  /** Renderer only: slides of a presentation drawn as PNG data URLs, each `width` pixels wide (Prism's Insert > Zoom pictures). */
  renderSlides?(doc: unknown, indices: number[], width: number): Promise<string[]>;
  /** Renderer only: slides of a presentation recorded as one video from a canvas the app draws itself (Prism's Export to Video): MP4 or WebM bytes. */
  renderVideo?(doc: unknown, req: {slides: number[]; seconds: number[]; width: number; fps?: number}): Promise<{bytes: Uint8Array; mime: string; ext: string; frames: number; seconds: number; width: number; height: number}>;
  /** Renderer only: a range of a worksheet drawn as a PNG data URL, `scale` times its size on screen (Grid's Copy as Picture). */
  /** Renderer only: the workbooks the app holds and the custom cell styles of one (Grid's Merge Styles). */
  peerStyles?: {list(): Promise<{id: string; title: string; current: boolean}[]>; get(id: string): Promise<{name: string; style?: object; includes?: string[]}[]>};
  renderRange?(doc: unknown, sheet: number, range: {start: {row: number; col: number}; end: {row: number; col: number}}, scale?: number): Promise<{dataUrl: string; width: number; height: number}>;
  /** Renderer only: any raster picture the browser opens (JPEG, GIF, WebP, BMP...) as straight RGBA, or null (Prism's Remove Background and Artistic Effects). */
  decodeImage?(bytes: Uint8Array): Promise<{width: number; height: number; data: Uint8ClampedArray} | null>;
  /** Renderer only: straight RGBA encoded as `image/jpeg` (or `image/png`) bytes, or null (Prism's Compress Pictures). */
  encodeImage?(img: {width: number; height: number; data: Uint8ClampedArray}, type: string, quality?: number): Promise<Uint8Array | null>;
  /** Other Sound… (Prism's Transitions › Sound): the system Open dialog; the sound's name and base64 bytes, or null when cancelled. */
  pickSound?(): Promise<{name: string; data: string} | null>;
  pickMedia?(req?: {video?: boolean}): Promise<{name: string; data: string} | null>;
  /** `picture`: a copied picture as a data URL (PNG, JPEG, GIF or WebP), when the clipboard holds one. */
  clipboardRead(): Promise<{text: string; html: string; picture?: string}>;
  clipboardWrite(data: {text?: string; html?: string}): Promise<void>;
  openDialog?(id: string, init: object): Promise<object | null>;                          // renderer only
  view?: unknown;                                                                          // renderer only
  /** Library persistence (Slate's notebooks; hosts without a file service). */
  save?(file: object, opts?: {path?: string; format?: string; password?: string; markup?: boolean}): Promise<{revision?: number; path?: string | null}>;
  /** The document file service: real files on disk (renderer: window.studio.files; headless: main). */
  files?: FileService;
  /** Renderer only: Slate notebooks as folders on disk (electron/notebook-folders.cjs through the preload). */
  notebooks?: NotebookService;
  close?(docId: string, opts?: {discard?: boolean}): Promise<void>;
  savePrefs?(prefs: object): Promise<void>;
  now(): number;
  uid(): string;
}
/** A document's tie to its file on disk (the main process keeps it; renderer reads a synchronous cache). */
export interface FileBinding {
  doc: string;
  kind?: string;
  /** Absolute path of the document's own file; null for a new document never saved. */
  path: string | null;
  /** Format the file is written in (docx, xlsx, pptx, pdf, csv, txt...). */
  format: string | null;
  /** What Office shows: the file's name without extension, or Document1 / Book1 / Presentation1. */
  name: string;
  /** AutoSave is switched on for this document. */
  autosave: boolean;
  /** The person saved this file in this session (AutoSave rewrites only such a file). */
  savedHere: boolean;
  /** Content differs from the file on disk (main's view; the live session's dirty flag wins). */
  modified?: boolean;
}
export interface RecentFile { path: string; name: string; folder?: string; kind: string; pinned: boolean; missing?: boolean; openedAt?: string }
export interface MessageBoxRequest { doc?: string | null; title?: string; type?: 'none' | 'info' | 'warning' | 'error' | 'question'; message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number }
export interface FileService {
  binding(doc: string): FileBinding | null;
  /** Is `path` a file the person chose in a dialog this session, an open file or a recent one? Opening any other path over the bridge needs approval. */
  known?(path: string): boolean;
  write(doc: string, file: object, opts: {path: string; format: string; bind: boolean; mode: 'save' | 'saveAs' | 'copy'}): Promise<{path: string; format: string; revision?: number; binding?: FileBinding}>;
  open(path: string, opts?: {kind?: string; show?: boolean}): Promise<{doc: string; path?: string; name?: string; alreadyOpen?: boolean}>;
  create(kind: string, opts?: {show?: boolean; title?: string; content?: object}): Promise<{doc: string; name: string}>;
  setAutosave(doc: string, on: boolean): Promise<FileBinding | null>;
  rename(doc: string, name: string): Promise<FileBinding | null>;
  recent(kind?: string): Promise<RecentFile[]>;
  clearRecent(kind?: string): Promise<RecentFile[]>;
  closed?(doc: string, opts: {discard: boolean}): Promise<void>;
  closeAll?(): Promise<unknown>;
  unsaved?(kind?: string): Promise<unknown[]>;
  recover?(doc: string, opts?: {show?: boolean}): Promise<unknown>;
  print?(doc: string, opts: object): Promise<unknown>;
  /** Renderer only: the system Save As / Open dialogs, a message box, a File page. */
  pickSave?(req: {doc: string; kind: string; mode: string; name: string; format: string}): Promise<{path: string; format: string} | null>;
  pickOpen?(req: {kind: string; doc?: string | null}): Promise<string | null>;
  messageBox?(req: MessageBoxRequest): Promise<number>;
  show?(page: string, doc?: string | null): void;
}
/** The folder IO core/slate/lib/notebook-folder.mjs needs (paths joined with '/'), inside a notebook folder only. */
export interface NotebookFolderFs {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  list(path: string): Promise<{name: string; dir: boolean}[]>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export interface RecentNotebook { path: string; name: string; folder: string; kind: 'slate'; missing: boolean; openedAt: string | null }
export interface NotebookService extends NotebookFolderFs {
  /** The system folder dialog: 'new' (titled New Notebook; the folder is created) or 'open'. Null when cancelled. */
  pick(mode: 'new' | 'open', suggestedName?: string): Promise<string | null>;
  /** New Notebook / Open Notebook (`path`: a folder from the recent list): the notebook's document, shown in a window unless `show` is false. */
  create(mode: 'new' | 'open', opts?: {path?: string; name?: string; show?: boolean}): Promise<{doc: string; path: string; name: string; alreadyOpen: boolean; warnings: string[]} | null>;
  recent(): Promise<RecentNotebook[]>;
}
export interface MemoryFiles extends Required<Omit<FileService, 'show'>> {
  show(page: string, doc?: string | null): void;
  asked: ({type: 'save' | 'open' | 'message'} & Record<string, unknown>)[];
  written: {doc: string; path: string; format: string; bind: boolean; mode: string}[];
  shown: {page: string; doc?: string | null}[];
  printed: {doc: string; opts: object}[];
  closedDocs: {doc: string; discard: boolean}[];
  disk: Map<string, {format: string; file: any}>;
  recentList: RecentFile[];
  bind(doc: string, binding: Partial<FileBinding>): FileBinding;
  script(...answers: unknown[]): void;
}
export declare function createMemoryFiles(opts?: {script?: unknown[]; disk?: Record<string, {format: string; file: object}>}): MemoryFiles;
export declare const HOST_KINDS: readonly Host['kind'][];
export declare function shortId(): string;
export declare function createHost(kind: Host['kind'], services?: Partial<Host>): Host;
export declare function createTestHost(overrides?: Partial<Host>): Host & {
  advance(ms: number): void; saved: {file: object; opts: object}[]; closed: {docId: string; opts: object}[]; readonly savedPrefs: object | null;
};
