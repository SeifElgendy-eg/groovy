// Draws the slimmed photo in one WebGL2 pass: each output pixel reads the photo at p + movement(p),
// where movement is the three unit fields (arms, waist & hips, legs; small, smooth) weighted by the
// sliders. Moving a slider only changes three numbers, so it is instant. CPU fallback without WebGL2.

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
out vec4 outColor;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y); // y down, like the photo
  vec2 uv = p / uSize;
  vec2 d = uS.x * texture(uArms, uv).rg + uS.y * texture(uTorso, uv).rg + uS.z * texture(uLegs, uv).rg;
  vec2 s = clamp(p + d * uScale, vec2(0.5), uSize - 0.5);
  outColor = vec4(texture(uFrame, s / uSize).rgb, 1.0);
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

export class BodyWarp {
  readonly canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private tex: { frame: WebGLTexture; arms: WebGLTexture; torso: WebGLTexture; legs: WebGLTexture } | null = null;
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
    this.tex = { frame: tex(), arms: tex(), torso: tex(), legs: tex() };
    this.gl = gl;
    if (this.frame) this.uploadFrame();
    if (this.fields) this.uploadFields();
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
  }

  /** The slimmed photo (photo size), or null before `set`. */
  render(s: Strengths): HTMLCanvasElement | null {
    const f = this.fields, frame = this.frame;
    if (!f || !frame) return null;
    const gl = this.init();
    if (gl && this.program && this.tex) {
      gl.viewport(0, 0, frame.width, frame.height);
      gl.useProgram(this.program);
      const units = [this.tex.frame, this.tex.arms, this.tex.torso, this.tex.legs];
      ["uFrame", "uArms", "uTorso", "uLegs"].forEach((name, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, units[i]);
        gl.uniform1i(gl.getUniformLocation(this.program!, name), i);
      });
      gl.uniform2f(gl.getUniformLocation(this.program, "uSize"), frame.width, frame.height);
      gl.uniform2f(gl.getUniformLocation(this.program, "uScale"), frame.width / f.w, frame.height / f.h);
      gl.uniform3f(gl.getUniformLocation(this.program, "uS"), s.arms, s.torso, s.legs);
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
        for (let c = 0; c < 3; c++) {
          const a = src[(y0 * W + x0) * 4 + c], b = src[(y0 * W + x1) * 4 + c];
          const cc = src[(y1 * W + x0) * 4 + c], d = src[(y1 * W + x1) * 4 + c];
          out.data[o + c] = (a + (b - a) * tx) * (1 - ty) + (cc + (d - cc) * tx) * ty;
        }
        out.data[o + 3] = 255;
      }
    ctx.putImageData(out, 0, 0);
    return this.cpuCanvas;
  }
}
