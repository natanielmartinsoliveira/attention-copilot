import { describe, expect, it } from "vitest";
import {
  catchUp,
  deadlineOf,
  formatDuration,
  summarizeMeeting,
  timeline,
} from "../../packages/core/src/assistant";
import { demoScript } from "../../packages/core/src/demo";
import {
  defaultProfile,
  defaultSettings,
  type Meeting,
  type TranscriptSegment,
} from "../../packages/core/src/types";
import { State } from "../../apps/api/src/state";
let count = 0;
const now = Date.now();
const seg = (
  text: string,
  t: number,
  speakerId = "Maria",
  meetingId = "backend",
): TranscriptSegment => ({
  id: "a" + ++count,
  meetingId,
  speakerId,
  text,
  startTime: t - 500,
  endTime: t,
  confidence: 1,
});
/** §55 demo: backend meeting while the user was focused elsewhere. */
const demo = () => {
  const s = new State();
  s.data.running = true;
  s.meeting("backend").lastUserAttentionAt = now;
  for (const row of demoScript)
    s.ingest(seg(row.text, now + row.at, row.speakerId, row.meetingId));
  return s;
};
describe("deadlineOf", () => {
  it.each([
    ["Precisamos disso antes das 17h.", "antes das 17h"],
    ["Entrega até às 18h", "até às 18h"],
    ["Fica para amanhã", "amanhã"],
    ["Até sexta-feira, por favor", "até sexta-feira"],
    ["Sem prazo definido", null],
  ])("%s → %s", (text, due) => expect(deadlineOf(text)).toBe(due));
});
describe("formatDuration", () => {
  it.each([
    [72, "1 minuto e 12 segundos"],
    [360, "6 minutos"],
    [61, "1 minuto e 1 segundo"],
    [1, "1 segundo"],
    [0, "0 segundos"],
  ])("%i s → %s", (s, label) => expect(formatDuration(s)).toBe(label));
});
describe("catch-up §20/§55", () => {
  it("demo catch-up gives the §55 bullets and action", () => {
    const s = demo(),
      c = catchUp(s.meeting("backend"), now + 72000, false, s.data.profile, s.data.settings);
    expect(c.missedLabel).toBe("1 minuto e 12 segundos");
    const text = c.summary.join("\n");
    expect(text).toContain("Carlos relatou um problema");
    expect(text).toContain("Maria pediu diretamente sua ajuda");
    expect(text).toContain("Prazo: antes das 17h");
    expect(text).toMatch(/bloquead/);
    expect(c.action).toBe("Responder a Maria e verificar o endpoint.");
    expect(c.lines).toHaveLength(4);
  });
  it("neutral period has no bullets and no action, but keeps raw lines", () => {
    const m: Meeting = {
      ...new State().meeting("frontend"),
      lastUserAttentionAt: now,
    };
    m.transcript.push(seg("Estamos revisando o frontend.", now + 1000, "João", "frontend"));
    const c = catchUp(m, now + 5000);
    expect(c.summary).toEqual([]);
    expect(c.action).toBeNull();
    expect(c.lines).toEqual(["João: Estamos revisando o frontend."]);
  });
  it("ultra catch-up lists only what matters, by category (§21)", () => {
    const s = demo();
    s.ingest(seg("Decidimos usar Postgres na API.", now + 15000, "Carlos"));
    const c = catchUp(s.meeting("backend"), now + 72000, true, s.data.profile, s.data.settings);
    expect(c.summary[0]).toMatch(/^Uma decisão foi tomada/);
    expect(c.summary.some((x) => x.startsWith("Existe uma pergunta aguardando sua resposta"))).toBe(true);
    expect(c.summary.some((x) => x.includes("antes das 17h"))).toBe(true);
    expect(new Set(c.summary).size).toBe(c.summary.length);
  });
});
describe("meeting summary §34/§35/§36", () => {
  it("extracts the user's task with owner and deadline from the demo", () => {
    const s = demo(),
      r = summarizeMeeting(s.meeting("backend"), s.data.profile, s.data.settings);
    const task = r.tasks.find((t) => t.owner === "Nataniel")!;
    expect(task.text).toBe("verificar o endpoint");
    expect(task.deadline).toBe("antes das 17h");
    expect(task.status).toBe("PROPOSED");
    expect(r.followUps.some((f) => f.includes("Responder a Maria"))).toBe(true);
  });
  it("extracts other people's tasks and decisions", () => {
    const m: Meeting = { ...new State().meeting("frontend") };
    m.transcript.push(
      seg("João vai cuidar do layout amanhã.", now, "Maria", "frontend"),
      seg("Decidimos usar Postgres.", now + 1000, "Carlos", "frontend"),
      seg("Decidimos usar Postgres?", now + 2000, "João", "frontend"),
    );
    const r = summarizeMeeting(m);
    expect(r.tasks).toEqual([
      expect.objectContaining({ owner: "João", text: "cuidar do layout amanhã", deadline: "amanhã" }),
    ]);
    expect(r.decisions).toEqual([
      expect.objectContaining({ speaker: "Carlos", text: "Decidimos usar Postgres." }),
    ]);
  });
  it("timeline marks start, topic, question, deadline, blocker and end", () => {
    const s = demo();
    s.end("backend");
    const kinds = timeline(s.meeting("backend"), s.data.profile, s.data.settings).map((e) => e.kind);
    expect(kinds[0]).toBe("START");
    expect(kinds.at(-1)).toBe("END");
    for (const k of ["TOPIC", "QUESTION", "DEADLINE", "BLOCKER"])
      expect(kinds).toContain(k);
  });
  it("task decisions survive re-summarizing and are validated", () => {
    const s = demo();
    const id = s.summary("backend").tasks[0].id;
    s.updateTask("backend", id, { text: "Verificar endpoint de pagamentos" });
    s.updateTask("backend", id, { status: "CONFIRMED" });
    const again = s.summary("backend").tasks.find((t) => t.id === id)!;
    expect(again).toMatchObject({
      text: "Verificar endpoint de pagamentos",
      status: "CONFIRMED",
      edited: true,
    });
    expect(() => s.updateTask("backend", id, { status: "DONE" as never })).toThrow();
    expect(() => s.updateTask("backend", "nope", { status: "DISMISSED" })).toThrow();
  });
});
