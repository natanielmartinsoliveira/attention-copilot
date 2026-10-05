import type { FeedbackSignal } from "../../../packages/core/src/learning.js";
export type LatencyMetric =
  | "transcriptionLatency"
  | "attentionDetectionLatency"
  | "notificationLatency";
const LATENCIES: LatencyMetric[] = [
  "transcriptionLatency",
  "attentionDetectionLatency",
  "notificationLatency",
];
/** §49 metrics, in memory, over a bounded window; nothing about content. */
export class Metrics {
  private samples = new Map<LatencyMetric, number[]>();
  private events: number[] = [];
  constructor(private window = 500) {}
  record(name: LatencyMetric, ms: number) {
    const list = this.samples.get(name) ?? [];
    list.push(Math.round(Math.max(0, ms) * 10) / 10);
    if (list.length > this.window) list.shift();
    this.samples.set(name, list);
  }
  event(at = Date.now()) {
    this.events.push(at);
    if (this.events.length > 5000) this.events.shift();
  }
  snapshot(
    ai: { calls: number; cost: number },
    feedback: readonly FeedbackSignal[],
    now = Date.now(),
  ) {
    const pct = (sorted: number[], p: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
    const latency = (name: LatencyMetric) => {
      const sorted = [...(this.samples.get(name) ?? [])].sort((a, b) => a - b);
      return sorted.length
        ? { count: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted.at(-1)! }
        : { count: 0, p50: null, p95: null, max: null };
    };
    const rated = feedback.filter((f) =>
      ["useful", "unimportant", "false-positive"].includes(f.rating),
    );
    return {
      ...(Object.fromEntries(LATENCIES.map((n) => [n, latency(n)])) as Record<
        LatencyMetric,
        ReturnType<typeof latency>
      >),
      eventsPerMinute:
        Math.round((this.events.filter((t) => now - t <= 600000).length / 10) * 100) / 100,
      aiCalls: ai.calls,
      aiCost: ai.cost,
      falsePositiveRate: rated.length
        ? rated.filter((f) => f.rating === "false-positive").length / rated.length
        : null,
    };
  }
}
