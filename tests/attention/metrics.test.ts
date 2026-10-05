import { describe, expect, it, vi } from "vitest";
import { Metrics } from "../../apps/api/src/metrics";
import { State } from "../../apps/api/src/state";
describe("Metrics §49", () => {
  it("percentiles over a bounded window", () => {
    const m = new Metrics(5);
    for (const v of [10, 20, 30, 40, 50, 1000]) m.record("transcriptionLatency", v);
    const s = m.snapshot({ calls: 0, cost: 0 }, []).transcriptionLatency;
    expect(s.count).toBe(5);
    expect(s.p50).toBe(40);
    expect(s.p95).toBe(1000);
  });
  it("events per minute over the last 10 minutes", () => {
    const m = new Metrics(),
      now = Date.now();
    for (let i = 0; i < 5; i++) m.event(now - i * 60000);
    m.event(now - 11 * 60000);
    expect(m.snapshot({ calls: 0, cost: 0 }, [], now).eventsPerMinute).toBe(0.5);
  });
  it("false-positive rate counts explicit ratings only", () => {
    const r = new Metrics().snapshot({ calls: 3, cost: 0.01 }, [
      { eventId: "a", type: "MENTION", rating: "false-positive", at: 1 },
      { eventId: "b", type: "MENTION", rating: "useful", at: 1 },
      { eventId: "c", type: "MENTION", rating: "unimportant", at: 1 },
      { eventId: "d", type: "MENTION", rating: "dismissed", at: 1 },
    ]);
    expect(r.falsePositiveRate).toBeCloseTo(1 / 3);
    expect(r.aiCalls).toBe(3);
    expect(r.aiCost).toBe(0.01);
  });
  it("no ratings → null rate, not a fake zero", () =>
    expect(new Metrics().snapshot({ calls: 0, cost: 0 }, []).falsePositiveRate).toBeNull());
});
describe("State instrumentation", () => {
  it("records pipeline, detection and notification latency and logs events with correlationId", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((x) => void logs.push(String(x)));
    const s = new State(),
      end = Date.now() - 1500;
    s.ingest({ id: "seg-1", meetingId: "backend", speakerId: "Maria", text: "Nataniel, consegue verificar o endpoint?", startTime: end - 500, endTime: end, confidence: 1 });
    spy.mockRestore();
    const m = s.metricsSnapshot();
    expect(m.transcriptionLatency.count).toBe(1);
    expect(m.transcriptionLatency.p50).toBeGreaterThanOrEqual(1500);
    expect(m.attentionDetectionLatency.count).toBe(1);
    expect(m.notificationLatency.count).toBe(1);
    const line = JSON.parse(logs.find((l) => l.includes('"attention_event"'))!);
    expect(line).toMatchObject({ type: "attention_event", meetingId: "backend", correlationId: "seg-1", status: "NOTIFIED" });
    expect(line.eventId).toBeTruthy();
    expect(JSON.stringify(line)).not.toContain("endpoint");
  });
});
