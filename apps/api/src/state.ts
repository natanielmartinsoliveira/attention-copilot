import { randomUUID } from "node:crypto";
import {
  AttentionEngine,
  MeetingPriorityEngine,
  isOpen,
} from "../../../packages/core/src/engine.js";
import {
  defaultProfile,
  defaultSettings,
  type ActionItemStatus,
  type AppState,
  type AttentionEvent,
  type EventStatus,
  type Meeting,
  type TranscriptSegment,
  type UserProfile,
  type Settings,
  type EventType,
} from "../../../packages/core/src/types.js";
import { demoScript } from "../../../packages/core/src/demo.js";
import {
  catchUp,
  generateResponse,
  summarizeMeeting,
  timeline,
} from "../../../packages/core/src/assistant.js";
import type { AIService } from "./ai-service.js";
export class State {
  engine = new AttentionEngine();
  priority = new MeetingPriorityEngine();
  listeners = new Set<() => void>();
  timers: Set<ReturnType<typeof setTimeout>> = new Set();
  data: AppState;
  constructor(readonly ai?: AIService) {
    this.data = this.fresh();
  }
  fresh(): AppState {
    const now = Date.now();
    return {
      meetings: [
        {
          id: "frontend",
          title: "Revisão do frontend",
          platform: "Google Meet",
          startedAt: now,
          status: "ACTIVE",
          participants: ["João", "Maria"],
          attentionScore: 18,
          lastUserAttentionAt: now,
          transcript: [],
          events: [],
        },
        {
          id: "backend",
          title: "API e deploy",
          platform: "Microsoft Teams",
          startedAt: now,
          status: "ACTIVE",
          participants: ["Carlos", "Maria", "João"],
          attentionScore: 18,
          lastUserAttentionAt: now,
          transcript: [],
          events: [],
        },
      ],
      profile: structuredClone(defaultProfile),
      settings: structuredClone(defaultSettings),
      focusId: "frontend",
      focusMode: "MANUAL",
      running: false,
      demo: true,
      recommendation: {
        meetingId: "frontend",
        switchAttention: false,
        state: "CALM",
        reason: "Tudo tranquilo. Você pode continuar focado.",
        confidence: 0.8,
      },
    };
  }
  meeting(id: string) {
    const m = this.data.meetings.find((m) => m.id === id);
    if (!m) throw Error("Reunião inexistente");
    return m;
  }
  event(id: string) {
    for (const m of this.data.meetings) {
      const e = m.events.find((e) => e.id === id);
      if (e) return { m, e };
    }
    throw Error("Evento inexistente");
  }
  emit() {
    this.tick(false);
    for (const f of this.listeners) f();
  }
  /** What clients can see; lastUserAttentionAt moves every tick and is excluded. */
  private visible() {
    return JSON.stringify([
      this.data.recommendation,
      this.data.meetings.map((m) => [
        m.attentionScore,
        m.transcript.length,
        m.events.map((e) => [e.status, e.level]),
      ]),
    ]);
  }
  tick(emit = true) {
    const before = emit ? this.visible() : "";
    const now = Date.now();
    for (const m of this.data.meetings) {
      this.engine.refresh(m, this.data.settings, now);
      const before = now - this.data.settings.retentionHours * 3600000;
      m.transcript = m.transcript.filter((s) => s.endTime >= before);
      m.events = m.events.filter((e) => e.updatedAt >= before);
      if (m.id === this.data.focusId && this.data.running)
        m.lastUserAttentionAt = now;
    }
    this.data.recommendation = this.priority.recommend(
      this.data.meetings,
      this.data.focusId,
      this.data.settings.minAttentionDelta,
    );
    if (emit && this.visible() !== before)
      for (const f of this.listeners) f();
  }
  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.data.running = false;
    this.emit();
  }
  reset() {
    this.stop();
    const profile = this.data.profile,
      settings = this.data.settings;
    this.data = this.fresh();
    this.data.profile = profile;
    this.data.settings = settings;
    this.emit();
  }
  startDemo(publish?: (s: TranscriptSegment) => Promise<void>) {
    this.reset();
    this.data.running = true;
    this.data.demo = true;
    const started = Date.now();
    for (const [i, s] of demoScript.entries()) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!this.data.running) return;
        const segment = {
          ...s,
          text: s.text.replaceAll("Nataniel", this.data.profile.name),
          id: randomUUID(),
          startTime: started + s.at - 500,
          endTime: started + s.at,
          confidence: 1,
        };
        if (publish)
          void publish(segment).catch(() => {
            this.stop();
          });
        else this.ingest(segment);
      }, s.at);
      this.timers.add(timer);
    }
    this.emit();
  }
  ingest(s: TranscriptSegment) {
    const m = this.meeting(s.meetingId);
    if (m.status !== "ACTIVE") throw Error("Reunião não está ativa");
    const e = this.engine.ingest(
      m,
      s,
      this.data.profile,
      this.data.settings,
      Date.now(),
      randomUUID(),
    );
    this.emit();
    if (e) this.refining = this.refine(m, e, s.confidence);
  }
  /** Latest background refinement; tests await it. */
  refining: Promise<void> = Promise.resolve();
  private async refine(m: Meeting, e: AttentionEvent, sttConfidence: number) {
    if (!this.ai || !this.data.settings.externalAI || !this.ai.shouldRefine(e))
      return;
    try {
      if (!(await this.ai.refine(m, e, this.data.profile, sttConfidence))) return;
      this.engine.rescore(m, e, this.data.settings, Date.now());
      this.emit();
    } catch {
      // Router already logged the failure; heuristics stay in charge.
    }
  }
  /** Drafts from the configured model when allowed, else the local templates. */
  async responseFor(id: string) {
    const { m, e } = this.event(id);
    const local = generateResponse(m, e);
    if (!local.safe || !this.ai || !this.data.settings.externalAI)
      return { ...local, source: "local" };
    const draft = await this.ai.response(m, e, this.data.profile);
    return draft
      ? { ...draft, sourceSegmentIds: local.sourceSegmentIds }
      : { ...local, source: "local (IA indisponível)" };
  }
  async aiSummary(id: string) {
    if (!this.ai || !this.data.settings.externalAI)
      throw Error("IA externa desligada");
    const result = await this.ai.summarize(this.meeting(id), this.data.profile);
    if (!result) throw Error("Nenhum provider de IA respondeu");
    return result;
  }
  focus(id: string | null, mode: AppState["focusMode"] = id ? "MANUAL" : "AUTO") {
    const now = Date.now(),
      next = id ? this.meeting(id) : undefined;
    if (this.data.focusId && this.data.focusId !== id) {
      const previous = this.meeting(this.data.focusId);
      previous.lastUserAttentionAt = now;
      previous.catchUpSince = undefined;
      previous.catchUpUntil = undefined;
    }
    if (next && next.id !== this.data.focusId) {
      next.catchUpSince = next.lastUserAttentionAt;
      next.catchUpUntil = now;
    }
    this.data.focusId = id;
    this.data.focusMode = mode;
    this.emit();
  }
  interact(id: string) {
    if (this.data.focusMode === "AUTO") this.focus(id, "AUTO");
  }
  transition(id: string, status: EventStatus) {
    const { m, e } = this.event(id);
    if (!isOpen(e)) throw Error("Evento já encerrado");
    if (!["SEEN", "ACKNOWLEDGED", "RESPONDED", "DISMISSED"].includes(status))
      throw Error("Transição inválida");
    if (status === "SEEN" && e.status === "ACKNOWLEDGED")
      throw Error("Transição inválida");
    e.status = status;
    e.updatedAt = Date.now();
    this.engine.refresh(m, this.data.settings, Date.now());
    this.emit();
  }
  feedback(
    id: string,
    rating: "useful" | "unimportant" | "false-positive",
    reason: string,
  ) {
    this.event(id).e.feedback = { rating, reason };
    this.emit();
  }
  catchUp(id: string, ultra: boolean) {
    return catchUp(
      this.meeting(id),
      Date.now(),
      ultra,
      this.data.profile,
      this.data.settings,
    );
  }
  /** Builds the §34 summary and stores extracted tasks for §35 review. */
  summary(id: string) {
    const m = this.meeting(id);
    const summary = summarizeMeeting(m, this.data.profile, this.data.settings);
    m.tasks = summary.tasks;
    return summary;
  }
  timeline(id: string) {
    return timeline(this.meeting(id), this.data.profile, this.data.settings);
  }
  updateTask(
    meetingId: string,
    taskId: string,
    patch: { status?: ActionItemStatus; text?: string },
  ) {
    const m = this.meeting(meetingId),
      task = m.tasks?.find((t) => t.id === taskId);
    if (!task) throw Error("Tarefa inexistente");
    if (
      patch.status !== undefined &&
      !["PROPOSED", "CONFIRMED", "DISMISSED"].includes(patch.status)
    )
      throw Error("Status de tarefa inválido");
    if (patch.status) task.status = patch.status;
    if (patch.text !== undefined) {
      task.text = patch.text;
      task.edited = true;
    }
    this.emit();
    return task;
  }
  response(id: string) {
    const { m, e } = this.event(id);
    return generateResponse(m, e);
  }
  context(id: string) {
    const { m, e } = this.event(id);
    return {
      event: e,
      segments: m.transcript.filter(
        (s) =>
          s.endTime >= e.detectedAt - 120000 &&
          s.endTime <= e.updatedAt + 15000,
      ),
    };
  }
  end(id: string) {
    const m = this.meeting(id);
    const summary = this.summary(id);
    m.status = "ENDED";
    m.endedAt = Date.now();
    for (const e of m.events.filter(isOpen)) e.status = "EXPIRED";
    this.emit();
    return summary;
  }
  delete(id: string) {
    this.meeting(id);
    this.data.meetings = this.data.meetings.filter((m) => m.id !== id);
    if (this.data.focusId === id)
      this.data.focusId = this.data.meetings[0]?.id ?? null;
    this.emit();
  }
  clearTranscript(id: string) {
    const m = this.meeting(id);
    m.transcript = [];
    m.events = [];
    m.tasks = [];
    this.emit();
  }
  create(title: string, platform: string) {
    const now = Date.now(),
      id = randomUUID();
    this.data.meetings.push({
      id,
      title,
      platform,
      startedAt: now,
      status: "ACTIVE",
      participants: [],
      attentionScore: 18,
      lastUserAttentionAt: now,
      transcript: [],
      events: [],
    });
    this.emit();
    return id;
  }
  profile(p: UserProfile) {
    this.data.profile = p;
    this.emit();
  }
  settings(p: Partial<Settings>) {
    this.data.settings = { ...this.data.settings, ...p };
    this.emit();
  }
}
