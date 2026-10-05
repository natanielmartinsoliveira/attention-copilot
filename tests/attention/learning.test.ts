import { describe, expect, it } from "vitest";
import {
  leadType,
  suggestWeights,
  type FeedbackSignal,
} from "../../packages/core/src/learning";
import { defaultSettings } from "../../packages/core/src/types";
import { State } from "../../apps/api/src/state";
const now = Date.now();
const sig = (
  type: FeedbackSignal["type"],
  rating: FeedbackSignal["rating"],
  i: number,
  at = now - i * 1000,
): FeedbackSignal => ({ eventId: `${type}-${i}`, type, rating, at });
describe("leadType", () => {
  it("picks the most specific type, MENTION only when alone", () => {
    expect(leadType(["MENTION", "DIRECT_QUESTION", "DEADLINE"])).toBe("DIRECT_QUESTION");
    expect(leadType(["MENTION"])).toBe("MENTION");
    expect(leadType(["MENTION", "BLOCKER"])).toBe("BLOCKER");
  });
});
describe("suggestWeights §51", () => {
  it("casual mentions repeatedly dismissed → lower MENTION weight, with a reason", () => {
    const log = [0, 1, 2, 3].map((i) => sig("MENTION", "unimportant", i));
    const [s] = suggestWeights(log, defaultSettings.weights, now);
    expect(s.type).toBe("MENTION");
    expect(s.suggested).toBeLessThan(1);
    expect(s.reason).toContain("4 de 4");
  });
  it("useful direct questions → raise weight, capped at 2", () => {
    const log = [0, 1, 2].map((i) => sig("DIRECT_QUESTION", "useful", i));
    const [s] = suggestWeights(log, { ...defaultSettings.weights, DIRECT_QUESTION: 1.9 }, now);
    expect(s.suggested).toBe(2);
  });
  it("false positives weigh more than 'not important'", () => {
    const fp = suggestWeights([0, 1, 2].map((i) => sig("DEADLINE", "false-positive", i)), defaultSettings.weights, now)[0];
    const ni = suggestWeights([0, 1, 2].map((i) => sig("DEADLINE", "unimportant", i)), defaultSettings.weights, now)[0];
    expect(fp.suggested).toBeLessThan(ni.suggested);
  });
  it("needs at least 3 signals and a meaningful change", () => {
    expect(suggestWeights([sig("MENTION", "unimportant", 0), sig("MENTION", "unimportant", 1)], defaultSettings.weights, now)).toEqual([]);
    const mixed = [sig("BLOCKER", "useful", 0), sig("BLOCKER", "unimportant", 1), sig("BLOCKER", "responded", 2), sig("BLOCKER", "dismissed", 3)];
    expect(suggestWeights(mixed, defaultSettings.weights, now)).toEqual([]);
  });
  it("ignores signals older than 30 days", () => {
    const old = [0, 1, 2].map((i) => sig("MENTION", "unimportant", i, now - 31 * 86400000));
    expect(suggestWeights(old, defaultSettings.weights, now)).toEqual([]);
  });
  it("never suggests below 0.2", () => {
    const log = [0, 1, 2, 3, 4, 5].map((i) => sig("MENTION", "false-positive", i));
    const [s] = suggestWeights(log, { ...defaultSettings.weights, MENTION: 0.3 }, now);
    expect(s.suggested).toBe(0.2);
  });
});
describe("State feedback log", () => {
  /** Returns the event this segment created, or undefined. */
  const mention = (s: State, i: number) => {
    const before = s.meeting("backend").events.length;
    s.ingest({
      id: "m" + i,
      meetingId: "backend",
      speakerId: "Maria",
      text: "Obrigado Nataniel.",
      startTime: now + i * 200000,
      endTime: now + i * 200000 + 500,
      confidence: 1,
    });
    const events = s.meeting("backend").events;
    return events.length > before ? events.at(-1)! : undefined;
  };
  it("explicit ratings and dismissals feed suggestions; applying lowers future scores", () => {
    const s = new State();
    for (let i = 0; i < 3; i++) {
      const e = mention(s, i)!;
      s.feedback(e.id, "unimportant", "");
      s.transition(e.id, "DISMISSED");
    }
    expect(s.data.feedbackLog.filter((f) => f.type === "MENTION")).toHaveLength(6);
    const [suggestion] = s.weightSuggestions();
    expect(suggestion.type).toBe("MENTION");
    s.applyWeights(["MENTION"]);
    expect(s.data.settings.weights.MENTION).toBe(suggestion.suggested);
    expect(mention(s, 9)).toBeUndefined();
  });
  it("applied feedback is consumed: no repeated suggestion from the same signals", () => {
    const s = new State();
    for (let i = 0; i < 3; i++) s.feedback(mention(s, i)!.id, "unimportant", "");
    s.applyWeights(["MENTION"]);
    expect(s.weightSuggestions()).toEqual([]);
  });
  it("re-rating an event replaces its explicit signal", () => {
    const s = new State();
    const e = mention(s, 0)!;
    s.feedback(e.id, "useful", "");
    s.feedback(e.id, "false-positive", "");
    expect(s.data.feedbackLog.map((f) => f.rating)).toEqual(["false-positive"]);
  });
  it("feedback survives transcript retention", () => {
    const s = new State();
    const e = mention(s, 0)!;
    s.feedback(e.id, "unimportant", "");
    s.clearTranscript("backend");
    expect(s.data.feedbackLog).toHaveLength(1);
  });
});
