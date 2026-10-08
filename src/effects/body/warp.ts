// Draws the slimmed photo in one WebGL2 pass: each output pixel reads the photo at p + movement(p),
// where movement is the three unit fields (arms, waist & hips, legs; small, smooth) weighted by the
// sliders. Moving a slider only changes three numbers, so it is instant. CPU fallback without WebGL2.
//
// With an empty backdrop (backdrop.ts): outside the person the photo is left exactly as it is (no
// background is pulled along), and where the slimmed body no longer covers the old body, the
// backdrop (colour-matched to the photo) shows instead of stretched background.

import type { Gain, Map1 } from "./backdrop";

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform sampler2D uArms;
uniform sampler2D uTorso;
uniform sampler2D uLegs;
uniform vec2 uSize;   // photo size in pixels
uniform vec2 uScale;  // photo pixels per field pixel
uniform vec3 uS;      // strengths: arms, torso, legs
uniform sampler2D uPlate; // the empty backdrop (photo size)
uniform sampler2D uCover; // r: where the person is, grown a little; g: the same, grown more (0..1)
uniform sampler2D uGain;  // backdrop -> photo colour gain
uniform float uUsePlate;
out vec4 outColor;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y); // y down, like the photo
  vec2 uv = p / uSize;
  vec2 d = uS.x * texture(uArms, uv).rg + uS.y * texture(uTorso, uv).rg + uS.z * texture(uLegs, uv).rg;
  vec2 s = clamp(p + d * uScale, vec2(0.5), uSize - 0.5);
  vec3 warped = texture(uFrame, s / uSize).rgb;
  if (uUsePlate < 0.5) {
    outColor = vec4(warped, 1.0);
    return;
  }
  float was = texture(uCover, uv).r;        // the person was here
  // the slimmed person is here (generous: the person mask can miss a few pixels of an edge, and
  // those must still show the moved body, not the photo or the backdrop)
  float now = texture(uCover, s / uSize).g;
  vec3 base = mix(texture(uFrame, uv).rgb, warped, max(was, now));
  vec3 plate = texture(uPlate, uv).rgb * texture(uGain, uv).rgb;
  outColor = vec4(mix(base, plate, clamp(was - now, 0.0, 1.0)), 1.0);
}`;

export interface Strengths {
  arms: number;
  torso: number;
  legs: number;
}

export interface FieldSet {
  w: number;
  h: number;
  arms: Float32Array;
  torso: Float32Array;
  legs: Float32Array;
}

/** The empty backdrop, how to blend it in, and its colour gain (see backdrop.ts). */
export interface BackdropSet {
  plate: HTMLCanvasElement;
  /** Where the person was (grown a little). */
  cover: Map1;
  /** The same, grown more: where moved body pixels are kept (same size as `cover`). */
  keep: Map1;
  gain: Gain;
}

export class BodyWarp {
  readonly canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private tex: Record<"frame" | "arms" | "torso" | "legs" | "plate" | "cover" | "gain", WebGLTexture> | null = null;
  private backdrop: BackdropSet | null = null;
  private cpuPlate: ImageData | null = null;
  private frame: HTMLCanvasElement | null = null;
  private fields: FieldSet | null = null;
  private cpuFrame: ImageData | null = null;
  /** The CPU fallback draws here (the WebGL canvas cannot also have a 2D context). */
  private cpuCanvas = document.createElement("canvas");

  constructor() {
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.gl = null;
      this.tex = null;
    });
  }

  private init(): WebGL2RenderingContext | null {
    if (this.gl) return this.gl;
    const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return null;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
      this.program = p;
    } catch (err) {
      console.warn("body warp: WebGL2 unavailable, using the CPU", err);
      return null;
    }
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tex = { frame: tex(), arms: tex(), torso: tex(), legs: tex(), plate: tex(), cover: tex(), gain: tex() };
    this.gl = gl;
    if (this.frame) this.uploadFrame();
    if (this.fields) this.uploadFields();
    if (this.backdrop) this.uploadBackdrop();
    return gl;
  }

  private uploadFrame(): void {
    const gl = this.gl, f = this.frame;
    if (!gl || !this.tex || !f) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.frame);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, f);
  }

  private uploadFields(): void {
    const gl = this.gl, f = this.fields;
    if (!gl || !this.tex || !f) return;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const k of ["arms", "torso", "legs"] as const) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[k]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, f.w, f.h, 0, gl.RG, gl.FLOAT, f[k]);
    }
  }

  private uploadBackdrop(): void {
    const gl = this.gl, b = this.backdrop;
    if (!gl || !this.tex || !b) return;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.plate);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, b.plate);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const rg = new Float32Array(b.cover.data.length * 2);
    for (let i = 0; i < b.cover.data.length; i++) {
      rg[2 * i] = b.cover.data[i];
      rg[2 * i + 1] = b.keep.data[i];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex.cover);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, b.cover.w, b.cover.h, 0, gl.RG, gl.FLOAT, rg);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.gain);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, b.gain.w, b.gain.h, 0, gl.RGB, gl.FLOAT, b.gain.data);
  }

  /** Use an empty backdrop for the current photo (same size), or none (null). Call after `set`. */
  setBackdrop(b: BackdropSet | null): void {
    this.backdrop = b;
    this.cpuPlate = null;
    if (b && this.init()) this.uploadBackdrop();
  }

  /** The photo to warp (copied) and its fields. */
  set(frame: HTMLCanvasElement, fields: FieldSet): void {
    const copy = document.createElement("canvas");
    copy.width = frame.width;
    copy.height = frame.height;
    copy.getContext("2d")!.drawImage(frame, 0, 0);
    this.frame = copy;
    this.fields = fields;
    this.cpuFrame = null;
    this.canvas.width = frame.width;
    this.canvas.height = frame.height;
    if (this.init()) {
      this.uploadFrame();
      this.uploadFields();
    }
  }

  clear(): void {
    this.frame = null;
    this.fields = null;
    this.cpuFrame = null;
    this.backdrop = null;
    this.cpuPlate = null;
  }

  /** The slimmed photo (photo size), or null before `set`. */
  render(s: Strengths): HTMLCanvasElement | null {
    const f = this.fields, frame = this.frame;
    if (!f || !frame) return null;
    const gl = this.init();
    if (gl && this.program && this.tex) {
      gl.viewport(0, 0, frame.width, frame.height);
      gl.useProgram(this.program);
      const t = this.tex;
      const units = [t.frame, t.arms, t.torso, t.legs, t.plate, t.cover, t.gain];
      ["uFrame", "uArms", "uTorso", "uLegs", "uPlate", "uCover", "uGain"].forEach((name, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, units[i]);
        gl.uniform1i(gl.getUniformLocation(this.program!, name), i);
      });
      gl.uniform2f(gl.getUniformLocation(this.program, "uSize"), frame.width, frame.height);
      gl.uniform2f(gl.getUniformLocation(this.program, "uScale"), frame.width / f.w, frame.height / f.h);
      gl.uniform3f(gl.getUniformLocation(this.program, "uS"), s.arms, s.torso, s.legs);
      gl.uniform1f(gl.getUniformLocation(this.program, "uUsePlate"), this.backdrop ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return this.canvas;
    }
    return this.renderCpu(s);
  }

  private renderCpu(s: Strengths): HTMLCanvasElement {
    const f = this.fields!, frame = this.frame!;
    const W = frame.width, H = frame.height;
    this.cpuFrame ??= frame.getContext("2d")!.getImageData(0, 0, W, H);
    const src = this.cpuFrame.data;
    this.cpuCanvas.width = W;
    this.cpuCanvas.height = H;
    const ctx = this.cpuCanvas.getContext("2d")!;
    const out = ctx.createImageData(W, H);
    const kx = W / f.w, ky = H / f.h;
    const bd = this.backdrop;
    if (bd && !this.cpuPlate) this.cpuPlate = bd.plate.getContext("2d")!.getImageData(0, 0, W, H);
    const plate = bd ? this.cpuPlate!.data : null;
    const field = (x: number, y: number, c: 0 | 1) => {
      const fx = Math.min(Math.max(x / kx - 0.5, 0), f.w - 1), fy = Math.min(Math.max(y / ky - 0.5, 0), f.h - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, f.w - 1), y1 = Math.min(y0 + 1, f.h - 1);
      const tx = fx - x0, ty = fy - y0;
      let v = 0;
      for (const [arr, k] of [[f.arms, s.arms], [f.torso, s.torso], [f.legs, s.legs]] as const) {
        if (!k) continue;
        const a = arr[(y0 * f.w + x0) * 2 + c], b = arr[(y0 * f.w + x1) * 2 + c];
        const cc = arr[(y1 * f.w + x0) * 2 + c], d = arr[(y1 * f.w + x1) * 2 + c];
        v += k * ((a + (b - a) * tx) * (1 - ty) + (cc + (d - cc) * tx) * ty);
      }
      return v;
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const sx = Math.min(Math.max(x + field(x, y, 0) * kx, 0), W - 1);
        const sy = Math.min(Math.max(y + field(x, y, 1) * ky, 0), H - 1);
        const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
        const tx = sx - x0, ty = sy - y0, o = (y * W + x) * 4;
        let was = 0, now = 0;
        if (bd) {
          was = sampleMap(bd.cover, x / W, y / H);
          now = sampleMap(bd.keep, sx / W, sy / H);
        }
        for (let c = 0; c < 3; c++) {
          const a = src[(y0 * W + x0) * 4 + c], b = src[(y0 * W + x1) * 4 + c];
          const cc = src[(y1 * W + x0) * 4 + c], d = src[(y1 * W + x1) * 4 + c];
          const warped = (a + (b - a) * tx) * (1 - ty) + (cc + (d - cc) * tx) * ty;
          if (!bd || !plate) {
            out.data[o + c] = warped;
            continue;
          }
          const base = src[o + c] + (warped - src[o + c]) * Math.max(was, now);
          const g = sampleGain(bd.gain, x / W, y / H, c);
          const r = Math.min(1, Math.max(0, was - now));
          out.data[o + c] = base + (plate[o + c] * g - base) * r;
        }
        out.data[o + 3] = 255;
      }
    ctx.putImageData(out, 0, 0);
    return this.cpuCanvas;
  }
}

/** Bilinear sample of a single-channel map at (u, v) in 0..1. */
function sampleMap(m: Map1, u: number, v: number): number {
  const fx = Math.min(Math.max(u * m.w - 0.5, 0), m.w - 1), fy = Math.min(Math.max(v * m.h - 0.5, 0), m.h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, m.w - 1), y1 = Math.min(y0 + 1, m.h - 1);
  const tx = fx - x0, ty = fy - y0, d = m.data;
  return (d[y0 * m.w + x0] * (1 - tx) + d[y0 * m.w + x1] * tx) * (1 - ty) + (d[y1 * m.w + x0] * (1 - tx) + d[y1 * m.w + x1] * tx) * ty;
}

/** Nearest sample of one channel of the gain map (it is smooth). */
function sampleGain(g: Gain, u: number, v: number, c: number): number {
  const x = Math.min(g.w - 1, Math.max(0, Math.floor(u * g.w))), y = Math.min(g.h - 1, Math.max(0, Math.floor(v * g.h)));
  return g.data[(y * g.w + x) * 3 + c];
}
