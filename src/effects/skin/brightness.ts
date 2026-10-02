// Skin brightening: a brightened copy of the frame, clipped to the skin mask, drawn on top.

export class SkinBrightness {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;

  /**
   * @param amount 0..1 brightness strength
   * @param drawFrame draws the display-oriented frame with a CSS filter
   * @param mask edge-faded skin mask in model orientation
   */
  draw(
    target: CanvasRenderingContext2D,
    w: number,
    h: number,
    amount: number,
    mirrored: boolean,
    drawFrame: (ctx: CanvasRenderingContext2D, w: number, h: number, filter: string) => void,
    mask: HTMLCanvasElement,
  ): void {
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    drawFrame(c, w, h, `brightness(${1 + amount * 0.3})`);
    c.save();
    c.globalCompositeOperation = "destination-in";
    c.filter = "none";
    if (mirrored) {
      c.translate(w, 0);
      c.scale(-1, 1);
    }
    c.drawImage(mask, 0, 0, w, h);
    c.restore();
    target.drawImage(this.canvas, 0, 0);
  }
}
