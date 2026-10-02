// Applies the software exposure lift: an SVG gamma filter (native, no per-pixel JavaScript) for
// the captured still, and an equivalent CSS brightness on the live preview so what the customer
// sees matches the photo they will get.
const FILTER_ID = "groovy-lift";
let funcs: SVGElement[] | null = null;

function ensureFilter(): SVGElement[] {
  if (funcs) return funcs;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  const filter = document.createElementNS(NS, "filter");
  filter.id = FILTER_ID;
  // Work on the stored sRGB values, not linearised ones.
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const transfer = document.createElementNS(NS, "feComponentTransfer");
  funcs = ["feFuncR", "feFuncG", "feFuncB"].map((tag) => {
    const f = document.createElementNS(NS, tag);
    f.setAttribute("type", "gamma");
    f.setAttribute("amplitude", "1");
    f.setAttribute("offset", "0");
    f.setAttribute("exponent", "1");
    transfer.append(f);
    return f;
  });
  filter.append(transfer);
  svg.append(filter);
  document.body.append(svg);
  return funcs;
}

/** Draw `src` into `ctx` with the gamma lift applied (gamma 1 = plain copy). */
export function drawLifted(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  w: number,
  h: number,
  gamma: number,
): void {
  if (gamma < 0.995) {
    for (const f of ensureFilter()) f.setAttribute("exponent", gamma.toFixed(3));
    ctx.filter = `url(#${FILTER_ID})`;
  }
  ctx.drawImage(src, 0, 0, w, h);
  ctx.filter = "none";
}

/** Preview: brightness that maps the face mean to the same value the gamma maps it to. */
export function previewFilter(gamma: number, mean: number): string {
  if (gamma >= 0.995 || mean <= 0) return "";
  const lifted = 255 * Math.pow(mean / 255, gamma);
  return `brightness(${(lifted / mean).toFixed(3)})`;
}
