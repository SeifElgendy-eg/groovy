// The capture countdown: exact timing, cancelling, the button text, and which services have one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLabel, countdownCaption, startCountdown, type CountdownHooks } from "../../src/core/countdown";
import { SERVICES, type ServiceId } from "../../src/effects/registry";

function recorder() {
  const events: string[] = [];
  const hooks: CountdownHooks = {
    onTick: (n) => events.push(`tick ${n}`),
    onDone: () => events.push("done"),
    onCancel: () => events.push("cancel"),
  };
  return { events, hooks };
}

describe("startCountdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks N..1 once a second, then finishes after N seconds in all", () => {
    const { events, hooks } = recorder();
    const c = startCountdown(5, hooks);
    expect(events).toEqual(["tick 5"]); // the first number shows immediately
    expect(c.running).toBe(true);
    vi.advanceTimersByTime(999);
    expect(events).toEqual(["tick 5"]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["tick 5", "tick 4"]);
    vi.advanceTimersByTime(3000);
    expect(events).toEqual(["tick 5", "tick 4", "tick 3", "tick 2", "tick 1"]);
    vi.advanceTimersByTime(999);
    expect(events).not.toContain("done"); // the photo is not taken before the last second is over
    vi.advanceTimersByTime(1);
    expect(events.at(-1)).toBe("done");
    expect(events.filter((e) => e === "done")).toHaveLength(1);
    expect(c.running).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(6); // five ticks and the end: nothing after it is done
  });

  it("cancel stops the ticks and the photo, and reports it once", () => {
    const { events, hooks } = recorder();
    const c = startCountdown(5, hooks);
    vi.advanceTimersByTime(2000);
    c.cancel();
    c.cancel();
    vi.advanceTimersByTime(10_000);
    expect(events).toEqual(["tick 5", "tick 4", "tick 3", "cancel"]);
    expect(c.running).toBe(false);
  });

  it("cancel after it finished does nothing", () => {
    const { events, hooks } = recorder();
    const c = startCountdown(1, hooks);
    vi.advanceTimersByTime(1000);
    c.cancel();
    expect(events).toEqual(["tick 1", "done"]);
  });

  it("cancelling from inside a tick does not schedule another", () => {
    const events: string[] = [];
    let c: ReturnType<typeof startCountdown> | undefined;
    c = startCountdown(3, {
      onTick: (n) => {
        events.push(`tick ${n}`);
        if (n === 2) c!.cancel();
      },
      onDone: () => events.push("done"),
      onCancel: () => events.push("cancel"),
    });
    vi.advanceTimersByTime(10_000);
    expect(events).toEqual(["tick 3", "tick 2", "cancel"]);
  });

  it("less than a second is immediate, whole seconds are rounded down", () => {
    const now = recorder();
    const c = startCountdown(0, now.hooks);
    expect(now.events).toEqual(["done"]);
    expect(c.running).toBe(false);

    const frac = recorder();
    startCountdown(2.9, frac.hooks);
    vi.advanceTimersByTime(5000);
    expect(frac.events).toEqual(["tick 2", "tick 1", "done"]);
  });
});

describe("button and caption text", () => {
  it("a service with a timer offers it, then Cancel while it runs", () => {
    expect(captureLabel(5, null)).toBe("Start 5-second timer");
    expect(captureLabel(5, 3)).toBe("Cancel");
  });

  it("a service without a timer keeps Take photo", () => {
    expect(captureLabel(0, null)).toBe("Take photo");
  });

  it("the caption says to hold still on the last second", () => {
    expect(countdownCaption(5)).toBe("Get into position");
    expect(countdownCaption(2)).toBe("Get into position");
    expect(countdownCaption(1)).toBe("Hold still");
  });
});

describe("which services have a capture timer", () => {
  it("only the whole-body service does; the face services still take the photo at once", () => {
    const delays = Object.fromEntries(Object.values(SERVICES).map((m) => [m.id, m.captureDelaySeconds]));
    expect(delays.body).toBeGreaterThanOrEqual(3);
    for (const id of ["lips", "wrinkles", "acne", "skin"] as ServiceId[]) expect(delays[id]).toBe(0);
  });
});
