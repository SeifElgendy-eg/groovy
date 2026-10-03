// Draws the lip warp in one WebGL2 pass: each output pixel reads the frame at p + offset(p), with
// the offset grid (see warpField.ts) and the frame both sampled bilinearly by the GPU. Only the
// warp's ROI is uploaded and drawn. Falls back to the CPU when WebGL2 is unavailable or lost.
import {
  STRETCH_FULL_AT as FULL_AT,
  STRETCH_GRAIN as GRAIN,
  STRETCH_LOD as LOD,
  STRETCH_RELAX as RELAX,
  warpPixelsCpu,
  type WarpGrid,
} from "./warpField";

const VERTEX = `#version 300 es
void main() {
  // One triangle covering the viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Where the warp stretches the lips (area grows), the photo's fine detail is magnified into long,
// soft streaks that read as "pulled". There, the detail is relaxed in proportion to the stretch and
// a fine grain at the photo's own scale is added back, so filled lips look smooth and full (as in
// the clinic ladder) rather than smeared. Unstretched pixels are untouched. Mirrored on the CPU in
// warpField.ts (warpPixelsCpu) with the same constants and the same integer hash.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uFrame;
uniform sampler2D uGrid;
uniform vec2 uSize;     // ROI size in pixels
uniform vec2 uStep;     // grid node spacing in pixels
uniform vec2 uGridDim;  // grid nodes (cols, rows)
uniform vec2 uOrigin;   // ROI origin in the frame (keeps the grain fixed to the photo)
out vec4 outColor;
vec2 offsetAt(vec2 p) { return texture(uGrid, (p / uStep + 0.5) / uGridDim).rg; }
vec3 frameAt(vec2 s) { return texture(uFrame, clamp(s, vec2(0.5), uSize - 0.5) / uSize).rgb; }
float grain(vec2 p) {
  uvec2 q = uvec2(p + uOrigin);
  uint h = q.x * 374761393u + q.y * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return float(h & 1023u) / 1023.0 - 0.5;
}
void main() {
  // ROI-local position, y down (the canvas is read top row first).
  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  vec2 o = offsetAt(p);
  vec2 s = p + o;
  vec3 c = frameAt(s);
  // Area magnification of the warp here (1 = none).
  vec2 dx = (offsetAt(p + vec2(1.0, 0.0)) - offsetAt(p - vec2(1.0, 0.0))) * 0.5;
  vec2 dy = (offsetAt(p + vec2(0.0, 1.0)) - offsetAt(p - vec2(0.0, 1.0))) * 0.5;
  float det = (1.0 + dx.x) * (1.0 + dy.y) - dx.y * dy.x;
  float k = clamp((1.0 / max(det, 0.05) - 1.0) / ${FULL_AT.toFixed(2)}, 0.0, 1.0);
  if (k > 0.0) {
    // Lip-line scale low-pass (~4 px) from the frame's mipmaps.
    vec3 base = textureLod(uFrame, clamp(s, vec2(0.5), uSize - 0.5) / uSize, ${LOD.toFixed(2)}).rgb;
    c = base + (c - base) * (1.0 - ${RELAX.toFixed(4)} * k) + vec3(grain(p) * ${GRAIN.toFixed(4)} * k);
  }
  outColor = vec4(c, 1.0);
}`;

export class GlWarp {
  readonly canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private frameTex: WebGLTexture;
  private gridTex: WebGLTexture;
  private loc: Record<"uFrame" | "uGrid" | "uSize" | "uStep" | "uGridDim" | "uOrigin", WebGLUniformLocation | null>;

  /** Returns null when WebGL2 (or a needed feature) is missing. */
  static create(): GlWarp | null {
    try {
      return new GlWarp();
    } catch (err) {
      console.warn("lip warp: WebGL2 unavailable, using the CPU", err);
      return null;
    }
  }

  private constructor() {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("no webgl2 context");
    this.gl = gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
    this.program = program;
    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.frameTex = texture();
    this.gridTex = texture();
    const u = (n: string) => gl.getUniformLocation(program, n);
    this.loc = { uFrame: u("uFrame"), uGrid: u("uGrid"), uSize: u("uSize"), uStep: u("uStep"), uGridDim: u("uGridDim"), uOrigin: u("uOrigin") };
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  /** Warp `roiFrame` (the frame's ROI, at ROI size) with the grid; returns the canvas holding it. */
  render(roiFrame: HTMLCanvasElement, g: WarpGrid): HTMLCanvasElement {
    const { gl, canvas } = this;
    const { w, h } = g.roi;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, roiFrame);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gridTex);
    // Half floats are filterable in WebGL2 core; offsets of tens of pixels keep ~1/64 px precision.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, g.cols, g.rows, 0, gl.RG, gl.FLOAT, g.data);

    gl.uniform1i(this.loc.uFrame, 0);
    gl.uniform1i(this.loc.uGrid, 1);
    gl.uniform2f(this.loc.uSize, w, h);
    gl.uniform2f(this.loc.uStep, g.sx, g.sy);
    gl.uniform2f(this.loc.uGridDim, g.cols, g.rows);
    gl.uniform2f(this.loc.uOrigin, g.roi.x, g.roi.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }
}

/** The same warp on the CPU. `roiFrame` is the frame's ROI; `out` receives the result. */
export function cpuWarp(roiFrame: HTMLCanvasElement, g: WarpGrid, out: HTMLCanvasElement): HTMLCanvasElement {
  const { w, h } = g.roi;
  const src = roiFrame.getContext("2d")!.getImageData(0, 0, w, h);
  out.width = w;
  out.height = h;
  src.data.set(warpPixelsCpu(src.data, g));
  out.getContext("2d")!.putImageData(src, 0, 0);
  return out;
}
