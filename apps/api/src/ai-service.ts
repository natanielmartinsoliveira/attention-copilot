import {
  AIRouter,
  PROMPTS,
  VALIDATORS,
  applyAssessment,
  type AIUsage,
} from "../../../packages/core/src/ai.js";
import { isOpen } from "../../../packages/core/src/engine.js";
import type {
  AttentionEvent,
  Meeting,
  UserProfile,
} from "../../../packages/core/src/types.js";
const WINDOW_MS = 120000;
/** Per-meeting budget: the LLM is a refinement, never the hot path (§47). */
const MAX_CALLS_PER_MINUTE = 10;
export class AIService {
  readonly usage: AIUsage[] = [];
  private inflight = new Set<string>();
  private calls = new Map<string, number[]>();
  readonly router: AIRouter;
  constructor(routerFactory: (report: (u: AIUsage) => void) => AIRouter) {
    this.router = routerFactory((u) => this.record(u));
  }
  private record(u: AIUsage) {
    this.usage.push(u);
    if (this.usage.length > 500) this.usage.shift();
    // §49: structured log without transcript content.
    console.log(
      JSON.stringify({
        timestamp: u.timestamp,
        type: "ai_call",
        meetingId: u.meetingId,
        eventId: u.eventId,
        provider: u.provider,
        model: u.model,
        task: u.task,
        tier: u.tier,
        latency: u.latency,
        tokens: u.tokens,
        ok: u.ok,
        error: u.error,
      }),
    );
  }
  summary() {
    const by: Record<
      string,
      { calls: number; failures: number; inputTokens: number; outputTokens: number; cost: number }
    > = {};
    for (const u of this.usage) {
      const s = (by[u.provider] ??= { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, cost: 0 });
      s.calls++;
      if (!u.ok) s.failures++;
      s.inputTokens += u.inputTokens ?? 0;
      s.outputTokens += u.outputTokens ?? 0;
      s.cost += u.estimatedCost ?? 0;
    }
    return {
      configured: this.router.configured,
      providers: this.router.providers(),
      calls: this.usage.length,
      cost: Object.values(by).reduce((n, s) => n + s.cost, 0),
      byProvider: by,
      recent: this.usage.slice(-20),
    };
  }
  private allow(meetingId: string) {
    const now = Date.now(),
      recent = (this.calls.get(meetingId) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= MAX_CALLS_PER_MINUTE) return false;
    recent.push(now);
    this.calls.set(meetingId, recent);
    return true;
  }
  /** Only uncertain or mid-range events are worth a model call. */
  shouldRefine(e: AttentionEvent) {
    return (
      isOpen(e) &&
      (e.requiresResponse || e.score > 40) &&
      (e.confidence < 0.8 || e.score <= 80) &&
      !(e.ai && e.ai.refinedAt >= e.updatedAt) &&
      !this.inflight.has(e.id)
    );
  }
  /** Re-scores an event in place; resolves true when it changed. */
  async refine(m: Meeting, e: AttentionEvent, profile: UserProfile, sttConfidence: number) {
    if (!this.allow(m.id)) return false;
    this.inflight.add(e.id);
    const started = e.updatedAt;
    try {
      const context = m.transcript.filter(
        (s) => s.endTime >= e.updatedAt - WINDOW_MS && s.endTime <= e.updatedAt,
      );
      const outcome = await this.router.run({
        meetingId: m.id,
        eventId: e.id,
        task: "detectAttention",
        request: PROMPTS.detectAttention(context, profile),
        valid: VALIDATORS.detectAttention,
        escalate: (a) => a.confidence < 0.8,
      });
      // Skip stale answers: the event moved on while the model was thinking.
      if (!outcome || !isOpen(e) || e.updatedAt !== started) return false;
      applyAssessment(e, outcome.value, {
        provider: outcome.provider,
        model: outcome.model,
        at: Date.now(),
        sttConfidence,
      });
      return true;
    } finally {
      this.inflight.delete(e.id);
    }
  }
  async response(m: Meeting, e: AttentionEvent, profile: UserProfile) {
    const context = m.transcript.filter(
      (s) => s.endTime >= e.detectedAt - WINDOW_MS && s.endTime <= e.updatedAt + 15000,
    );
    const outcome = await this.router.run({
      meetingId: m.id,
      eventId: e.id,
      task: "generateResponse",
      request: PROMPTS.generateResponse(context, e.quote, profile),
      valid: VALIDATORS.generateResponse,
      prefer: "strong",
    });
    return outcome && { ...outcome.value, source: `${outcome.provider}:${outcome.model}` };
  }
  async summarize(m: Meeting, profile: UserProfile) {
    const [summary, tasks] = await Promise.all([
      this.router.run({
        meetingId: m.id,
        task: "summarizeMeeting",
        request: PROMPTS.summarizeMeeting(m.transcript, profile),
        valid: VALIDATORS.summarizeMeeting,
        prefer: "strong",
      }),
      this.router.run({
        meetingId: m.id,
        task: "extractTasks",
        request: PROMPTS.extractTasks(m.transcript, profile),
        valid: VALIDATORS.extractTasks,
        prefer: "strong",
      }),
    ]);
    if (!summary && !tasks) return null;
    return {
      summary: summary?.value.summary ?? [],
      tasks: tasks?.value.tasks ?? [],
      source: [summary, tasks]
        .filter((x) => x)
        .map((x) => `${x!.provider}:${x!.model}`)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(", "),
    };
  }
}
