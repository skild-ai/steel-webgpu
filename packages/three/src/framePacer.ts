const MAX_FRAMES_PER_TICK = 2;
const STALL_MS = 100;

/** Fixed-rate simulation paced by the wall clock with at most `maxInFlight` frames queued on the GPU. */
export class FramePacer {
  private wallT: number;
  private inFlight = 0;

  constructor(
    private readonly fps: number,
    now: number,
    private readonly maxInFlight = 2,
  ) {
    this.wallT = now;
  }

  /** Frames to simulate this tick; the caller reports each one with `started` and `finished`. */
  framesDue(now: number, running: boolean): number {
    const budget = Math.max(0, Math.min(MAX_FRAMES_PER_TICK, Math.floor(((now - this.wallT) * this.fps) / 1000)));
    this.wallT += (budget * 1000) / this.fps;
    if (now - this.wallT > STALL_MS) this.wallT = now;
    if (!running) {
      this.wallT = now;
      return 0;
    }
    return Math.min(budget, this.maxInFlight - this.inFlight);
  }

  started() {
    this.inFlight++;
  }

  finished() {
    this.inFlight--;
  }
}
