/**
 * Lookahead scheduler — the only clock in the product.
 * Chris Wilson two-clock pattern (cwilso/metronome, MIT),
 * generalized for multiple transports. The pump math is PURE (injectable now());
 * the setInterval pump and rAF UI drain are thin bindings.
 *
 * Rules: pullEventsAt/advance are pure; throttled-tab backlogs are dropped, not
 * burst-scheduled; tempo changes take effect from the next event boundary;
 * gate-off events are scheduled, not timed out.
 */

export interface TransportEvent {
  time: number; // audio-clock seconds
  type: string;
  data?: Record<string, unknown>;
}

export interface Transport {
  readonly id: string;
  running: boolean;
  /** Audio-clock time of the next event boundary. */
  nextEventTime: number;
  /**
   * OPTIONAL: called once per pump (with the pump's now) BEFORE nextEventTime is read,
   * so a transport that follows EXTERNAL state — e.g. the sampler loop clock reading the
   * Monarch master phase — can refresh nextEventTime from the latest tempo/run state instead
   * of the snapshot taken at its last UI tap. PURE given now() (no Date/Math.random).
   */
  onPump?(now: number): void;
  /** PURE: events for the boundary at `time` (may include later times, e.g. gate-offs). */
  pullEventsAt(time: number): TransportEvent[];
  /** PURE: advance to the next boundary. */
  advance(): void;
}

export type EventBinder = (e: TransportEvent) => void;

export const LOOKAHEAD_TICK_MS = 25;
export const SCHEDULE_AHEAD_S = 0.1;

export class Scheduler {
  private readonly transports = new Map<string, { transport: Transport; bind: EventBinder }>();
  readonly uiQueue: TransportEvent[] = [];
  /** Counts pump passes that found an already-stale boundary. Must stay 0 in the soak. */
  starvationCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly now: () => number,
    private readonly scheduleAheadS: number = SCHEDULE_AHEAD_S,
  ) {}

  add(transport: Transport, bind: EventBinder): void {
    this.transports.set(transport.id, { transport, bind });
  }

  remove(id: string): void {
    this.transports.delete(id);
  }

  /** One lookahead pass. Pure given now() — unit-testable with fake time. */
  pump(): void {
    const now = this.now();
    for (const { transport, bind } of this.transports.values()) {
      if (!transport.running) continue;
      // refresh transports that follow external state (loop clock ← Monarch phase) before we
      // read nextEventTime, so a live tempo/run-state change is honored from THIS pump on.
      transport.onPump?.(now);
      // throttled tab: fast-forward without scheduling stale audio (drop, don't burst)
      if (transport.nextEventTime < now) {
        this.starvationCount++;
        while (transport.nextEventTime < now) transport.advance();
      }
      while (transport.nextEventTime < now + this.scheduleAheadS) {
        const boundary = transport.nextEventTime;
        for (const e of transport.pullEventsAt(boundary)) {
          bind(e);
          this.uiQueue.push(e);
        }
        transport.advance();
        if (transport.nextEventTime <= boundary) {
          throw new Error(`transport ${transport.id} did not advance`);
        }
      }
    }
  }

  /** Pop UI events due at or before `upTo` (rAF loop calls this for LED chasing). */
  drainUi(upTo: number): TransportEvent[] {
    // Single-pass partition (order-preserving) — avoids the O(n²) splice-in-loop churn this
    // runs 60×/s on. uiQueue is readonly (mutate in place, never reassign).
    const due: TransportEvent[] = [];
    const keep: TransportEvent[] = [];
    for (const e of this.uiQueue) (e.time <= upTo ? due : keep).push(e);
    this.uiQueue.length = 0;
    for (const e of keep) this.uiQueue.push(e);
    return due;
  }

  start(tickMs: number = LOOKAHEAD_TICK_MS): void {
    if (this.timer) return;
    this.pump();
    this.timer = setInterval(() => this.pump(), tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
