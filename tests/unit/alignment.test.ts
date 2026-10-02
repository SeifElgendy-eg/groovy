import { describe, expect, it } from "vitest";
import {
  INITIAL_ALIGNMENT,
  STABLE_FRAMES,
  evaluateAlignment,
  type AlignmentState,
} from "../../src/face/alignment";

// A centred, front-facing face that satisfies every check (normalised coordinates).
function goodFace(dx = 0, dy = 0) {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  pts[234] = { x: 0.5 - 0.15 + dx, y: 0.48 + dy }; // face left
  pts[454] = { x: 0.5 + 0.15 + dx, y: 0.48 + dy }; // face right
  pts[10] = { x: 0.5 + dx, y: 0.48 - 0.28 + dy }; // forehead top
  pts[152] = { x: 0.5 + dx, y: 0.48 + 0.28 + dy }; // chin
  pts[1] = { x: 0.5 + dx, y: 0.5 + dy }; // nose tip
  pts[33] = { x: 0.43 + dx, y: 0.45 + dy };
  pts[263] = { x: 0.57 + dx, y: 0.45 + dy };
  return pts;
}

describe("evaluateAlignment", () => {
  it("asks for a face when none is detected", () => {
    const r = evaluateAlignment(null, INITIAL_ALIGNMENT);
    expect(r.valid).toBe(false);
    expect(r.aligned).toBe(false);
    expect(r.label).toBe("Position your face inside the oval");
    expect(r.state).toEqual({ last: null, frames: 0 });
  });

  it("reports aligned only after enough stable frames", () => {
    let state: AlignmentState = INITIAL_ALIGNMENT;
    let aligned = false;
    for (let i = 1; i <= STABLE_FRAMES; i++) {
      const r = evaluateAlignment(goodFace(), state);
      state = r.state;
      aligned = r.aligned;
      expect(r.valid).toBe(true);
      expect(aligned).toBe(i >= STABLE_FRAMES);
      if (!aligned) expect(r.label).toBe("Hold still for a moment");
    }
    expect(aligned).toBe(true);
  });

  it("tells the user to centre, approach, back off or look ahead", () => {
    const off = evaluateAlignment(goodFace(0.2), INITIAL_ALIGNMENT);
    expect(off.label).toBe("Move to the center of the oval");

    const far = goodFace();
    far[10] = { x: 0.5, y: 0.48 - 0.1 };
    far[152] = { x: 0.5, y: 0.48 + 0.1 };
    expect(evaluateAlignment(far, INITIAL_ALIGNMENT).label).toBe("Move closer");

    const near = goodFace();
    near[10] = { x: 0.5, y: 0.48 - 0.5 };
    near[152] = { x: 0.5, y: 0.48 + 0.5 };
    expect(evaluateAlignment(near, INITIAL_ALIGNMENT).label).toBe("Move back slightly");

    const turned = goodFace();
    turned[1] = { x: 0.62, y: 0.5 };
    expect(evaluateAlignment(turned, INITIAL_ALIGNMENT).label).toBe("Look straight ahead");
  });

  it("resets the stable counter when the face moves", () => {
    const first = evaluateAlignment(goodFace(), INITIAL_ALIGNMENT);
    const moved = evaluateAlignment(goodFace(0.04), first.state);
    expect(moved.valid).toBe(false);
    expect(moved.state.frames).toBe(0);
    expect(moved.label).toBe("Hold still for a moment");
  });
});
