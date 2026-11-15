// Draws transition frames: the layers of core/prism/lib/transition-fx.mjs (textured quads and
// triangles of the old and new slide, their backgrounds and contents, black and white, with an
// opacity per corner) over black. WebGL when the window has it (per-vertex opacity, perspective
// kept straight by the meshes); Canvas2D triangles otherwise.
// deckcraft draws the same meshes with egui (crates/ui-egui/src/show/render.rs).

import {layerMesh, wholeSource} from '../../../../core/prism/lib/transition-fx.mjs';

type Any = any;
export type Textures = Partial<Record<'old' | 'new' | 'oldBack' | 'newBack' | 'oldContent' | 'newContent', HTMLCanvasElement>>;

const VERT = `attribute vec2 p; attribute vec2 u; attribute float a; varying vec2 vu; varying float va;
void main() { vu = u; va = a; gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0); }`;
const FRAG = `precision mediump float; varying vec2 vu; varying float va; uniform sampler2D tex; uniform vec3 flat_color; uniform float textured;
void main() { vec4 c = textured > 0.5 ? texture2D(tex, vu) : vec4(flat_color, 1.0); float k = c.a * va; gl_FragColor = vec4(c.rgb * va, k); }`;

export class LayerRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private g2: CanvasRenderingContext2D | null = null;
  private prog: WebGLProgram | null = null;
  private buf: WebGLBuffer | null = null;
  private tex = new Map<string, WebGLTexture>();
  private src: Textures = {};
  private loc: Any = {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    let gl: WebGLRenderingContext | null = null;
    try { gl = canvas.getContext('webgl', {premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true}) as WebGLRenderingContext | null; } catch { gl = null; }
    if (gl) { this.gl = gl; try { this.init(gl); } catch { this.gl = null; } }
    if (!this.gl) this.g2 = canvas.getContext('2d');
  }

  private init(gl: WebGLRenderingContext) {
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(s))); return s; };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(prog);
    this.prog = prog;
    this.buf = gl.createBuffer();
    this.loc = {p: gl.getAttribLocation(prog, 'p'), u: gl.getAttribLocation(prog, 'u'), a: gl.getAttribLocation(prog, 'a'),
      tex: gl.getUniformLocation(prog, 'tex'), color: gl.getUniformLocation(prog, 'flat_color'), textured: gl.getUniformLocation(prog, 'textured')};
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** The bitmaps layers draw from. */
  setTextures(t: Textures) {
    this.src = t;
    const gl = this.gl;
    if (!gl) return;
    for (const old of this.tex.values()) gl.deleteTexture(old);
    this.tex.clear();
    for (const [k, c] of Object.entries(t)) {
      if (!c) continue;
      const tx = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.tex.set(k, tx);
    }
  }

  resize(w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** A part source whose bitmap is missing is drawn as its whole slide, or not at all (content). */
  private resolve(source: string): string | null {
    if (source === 'black' || source === 'white') return source;
    if ((this.src as Any)[source]) return source;
    const whole = wholeSource(source);
    return whole && (this.src as Any)[whole] ? whole : null;
  }

  draw(layers: Any[]) {
    if (this.gl) this.drawGL(layers); else this.draw2d(layers);
  }

  private drawGL(layers: Any[]) {
    const gl = this.gl!;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    for (const l of layers) {
      const src = this.resolve(l.source);
      if (!src) continue;
      const mesh = layerMesh(l);
      const data = new Float32Array(mesh.triangles.length * 3 * 5);
      let o = 0;
      for (const tri of mesh.triangles) for (const i of tri) {
        const v = mesh.vertices[i];
        data[o++] = v.pos[0]; data[o++] = v.pos[1]; data[o++] = v.uv[0]; data[o++] = v.uv[1]; data[o++] = v.a;
      }
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      const stride = 20;
      gl.enableVertexAttribArray(this.loc.p); gl.vertexAttribPointer(this.loc.p, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.loc.u); gl.vertexAttribPointer(this.loc.u, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(this.loc.a); gl.vertexAttribPointer(this.loc.a, 1, gl.FLOAT, false, stride, 16);
      if (src === 'black' || src === 'white') {
        gl.uniform1f(this.loc.textured, 0);
        const c = src === 'white' ? 1 : 0;
        gl.uniform3f(this.loc.color, c, c, c);
      } else {
        gl.uniform1f(this.loc.textured, 1);
        gl.bindTexture(gl.TEXTURE_2D, this.tex.get(src)!);
        gl.uniform1i(this.loc.tex, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, mesh.triangles.length * 3);
    }
  }

  private draw2d(layers: Any[]) {
    const g = this.g2;
    if (!g) return;
    const W = this.canvas.width, H = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    for (const l of layers) {
      const src = this.resolve(l.source);
      if (!src) continue;
      const mesh = layerMesh(l);
      const img = src === 'black' || src === 'white' ? null : (this.src as Any)[src] as HTMLCanvasElement;
      for (const tri of mesh.triangles) {
        const [a, b, c] = tri.map(i => mesh.vertices[i]);
        const alpha = (a.a + b.a + c.a) / 3;
        if (alpha <= 0) continue;
        g.save();
        g.globalAlpha = Math.min(Math.max(alpha, 0), 1);
        g.beginPath();
        g.moveTo(a.pos[0] * W, a.pos[1] * H); g.lineTo(b.pos[0] * W, b.pos[1] * H); g.lineTo(c.pos[0] * W, c.pos[1] * H); g.closePath();
        g.clip();
        if (!img) { g.fillStyle = src === 'white' ? '#fff' : '#000'; g.fill(); g.restore(); continue; }
        // The affine map from texture pixels to screen that takes the triangle's uv to its positions.
        const iw = img.width, ih = img.height;
        const [x0, y0, x1, y1, x2, y2] = [a.uv[0] * iw, a.uv[1] * ih, b.uv[0] * iw, b.uv[1] * ih, c.uv[0] * iw, c.uv[1] * ih];
        const [X0, Y0, X1, Y1, X2, Y2] = [a.pos[0] * W, a.pos[1] * H, b.pos[0] * W, b.pos[1] * H, c.pos[0] * W, c.pos[1] * H];
        const d = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
        if (Math.abs(d) < 1e-9) { g.restore(); continue; }
        const m11 = (X0 * (y1 - y2) + X1 * (y2 - y0) + X2 * (y0 - y1)) / d;
        const m21 = (X0 * (x2 - x1) + X1 * (x0 - x2) + X2 * (x1 - x0)) / d;
        const m12 = (Y0 * (y1 - y2) + Y1 * (y2 - y0) + Y2 * (y0 - y1)) / d;
        const m22 = (Y0 * (x2 - x1) + Y1 * (x0 - x2) + Y2 * (x1 - x0)) / d;
        const dx = (X0 * (x1 * y2 - x2 * y1) + X1 * (x2 * y0 - x0 * y2) + X2 * (x0 * y1 - x1 * y0)) / d;
        const dy = (Y0 * (x1 * y2 - x2 * y1) + Y1 * (x2 * y0 - x0 * y2) + Y2 * (x0 * y1 - x1 * y0)) / d;
        g.setTransform(m11, m12, m21, m22, dx, dy);
        g.drawImage(img, 0, 0);
        g.restore();
      }
    }
  }

  dispose() {
    const gl = this.gl;
    if (gl) { for (const t of this.tex.values()) gl.deleteTexture(t); this.tex.clear(); if (this.buf) gl.deleteBuffer(this.buf); if (this.prog) gl.deleteProgram(this.prog); }
  }
}
