import {
  AttentionEngine,
  KNOWN_TOPICS,
  isOpen,
  normalize,
  topicOf,
} from "./engine.js";
import {
  defaultProfile,
  defaultSettings,
  type ActionItem,
  type AttentionEvent,
  type Detection,
  type EventType,
  type Meeting,
  type Settings,
  type TimelineEntry,
  type TimelineKind,
  type TranscriptSegment,
  type UserProfile,
} from "./types.js";
// Everything here is extractive: bullets quote what was said and never add
// facts. An LLM provider may later rewrite them; the local path stays honest.
const engine = new AttentionEngine();
type Classified = { s: TranscriptSegment; d: Detection };
/** Re-runs the detector per segment with the preceding transcript as context. */
function classify(m: Meeting, profile: UserProfile, settings: Settings) {
  return m.transcript.map(
    (s, i): Classified => ({
      s,
      d: engine.detect(s, m.transcript.slice(Math.max(0, i - 80), i), profile, settings),
    }),
  );
}
const PROBLEM = /\b(problema|erro|falha|bug|incidente|quebrou|caiu|fora do ar|lento)\b/;
const DECISION = /\b(decidimos|ficou decidido|foi decidido|esta decidido|aprovad[oa]s?|vamos seguir com|fechamos)\b/;
const isDecision = (text: string) =>
  !text.includes("?") && DECISION.test(normalize(text));
const quote = (s: TranscriptSegment) => `“${s.text}”`;
/** "antes das 17h", "amanhã", "até sexta"… or null. Matching runs on the
 * accent-free text, so accents are restored for display. */
export function deadlineOf(text: string): string | null {
  const m = normalize(text).match(
    /\b(antes d[aoe]s? \d{1,2}(?:h\d{0,2}|:\d{2})?|ate (?:as )?\d{1,2}(?:h\d{0,2}|:\d{2})?|ate (?:segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?|hoje|amanha|(?:n)?esta semana|fim do dia)\b/,
  );
  return m
    ? m[1]
        .replace(/^ate (as )?/, (_, as) => `até ${as ? "às " : ""}`)
        .replace("amanha", "amanhã")
        .replace("terca", "terça")
        .replace("sabado", "sábado")
    : null;
}
/** The thing being asked: "verificar o endpoint" from "…você consegue verificar o endpoint?". */
function requestOf(text: string): string | null {
  const m = text.match(
    /\b(?:consegue|pode|poderia|podemos|consegue me ajudar a)\s+(.+?)\s*[?.!]*$/i,
  );
  return m ? m[1].trim() : null;
}
const PRIMARY: EventType[] = [
  "BLOCKER",
  "DIRECT_QUESTION",
  "DECISION_REQUIRED",
  "APPROVAL_REQUIRED",
  "CONFIRMATION_REQUIRED",
  "INDIRECT_QUESTION",
  "TASK_ASSIGNED",
  "FOLLOW_UP",
  "DEADLINE",
  "CONFLICT",
  "IMPORTANT_CONTEXT",
  "USER_EXPERTISE_REQUIRED",
  "URGENT_REQUEST",
  "USER_RESPONSIBILITY",
  "TASK_DISCUSSION",
  "USER_TOPIC",
  "MENTION",
];
const primary = (d: Detection) => PRIMARY.find((t) => d.types.includes(t));
/** One catch-up bullet per relevant segment; undefined for chatter. */
function bullet({ s, d }: Classified): string | undefined {
  const who = s.speakerId,
    due = deadlineOf(s.text),
    withDue = (x: string) =>
      due && d.types.includes("DEADLINE") ? `${x} (prazo: ${due})` : x;
  if (d.dismissal) return `${who} dispensou o pedido: ${quote(s)}`;
  switch (primary(d)) {
    case "BLOCKER":
      return `O avanço está bloqueado esperando por você: ${quote(s)}`;
    case "DIRECT_QUESTION":
      return withDue(`${who} pediu diretamente sua ajuda: ${quote(s)}`);
    case "DECISION_REQUIRED":
      return withDue(`${who} pediu sua decisão: ${quote(s)}`);
    case "APPROVAL_REQUIRED":
      return withDue(`${who} pediu sua aprovação: ${quote(s)}`);
    case "CONFIRMATION_REQUIRED":
      return withDue(`${who} pediu sua confirmação: ${quote(s)}`);
    case "INDIRECT_QUESTION":
      return `${who} perguntou quem pode ajudar; o contexto aponta para você: ${quote(s)}`;
    case "TASK_ASSIGNED":
      return withDue(`Você foi citado como responsável: ${quote(s)}`);
    case "FOLLOW_UP":
      return `${who} cobrou sua resposta: ${quote(s)}`;
    case "DEADLINE":
      return due ? `Prazo: ${due}.` : `Prazo mencionado: ${quote(s)}`;
    case "CONFLICT":
      return `${who} discordou: ${quote(s)}`;
    case "IMPORTANT_CONTEXT":
      return `Decisão ou mudança que afeta seu trabalho: ${quote(s)}`;
    case "USER_EXPERTISE_REQUIRED":
      return `Procuram alguém com sua experiência: ${quote(s)}`;
    case "URGENT_REQUEST":
      return `Pedido urgente: ${quote(s)}`;
    case "USER_RESPONSIBILITY":
    case "MENTION":
      return `${who} mencionou você: ${quote(s)}`;
    case "TASK_DISCUSSION":
    case "USER_TOPIC":
      return `${who} falou de um assunto seu: ${quote(s)}`;
  }
  if (isDecision(s.text)) return `Decisão: ${quote(s)}`;
  if (PROBLEM.test(normalize(s.text))) return `${who} relatou um problema: ${quote(s)}`;
}
const firstSegment = (m: Meeting, e: AttentionEvent) =>
  m.transcript.find((s) => s.id === e.segmentIds[0]);
/** "Responder a Maria e verificar o endpoint." for the top pending request. */
function actionFor(m: Meeting, pending: AttentionEvent[]) {
  const top = [...pending].sort((a, b) => b.score - a.score)[0];
  if (!top) return null;
  const who = firstSegment(m, top)?.speakerId,
    ask = requestOf(top.quote),
    to = who && who !== "Voz não identificada" ? `Responder a ${who}` : "Responder ao pedido";
  return `${to}${ask ? ` e ${ask}` : ""}.`;
}
export function formatDuration(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds)),
    min = Math.floor(s / 60),
    sec = s % 60,
    unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (!min) return unit(sec, "segundo", "segundos");
  const m = unit(min, "minuto", "minutos");
  return sec ? `${m} e ${unit(sec, "segundo", "segundos")}` : m;
}
const ESSENTIALS: [string, (c: Classified) => boolean, (c: Classified[]) => string][] = [
  [
    "decision",
    (c) => isDecision(c.s.text) || c.d.types.includes("IMPORTANT_CONTEXT"),
    (c) => `Uma decisão foi tomada: ${quote(c[0].s)}`,
  ],
  [
    "task",
    (c) => c.d.types.includes("TASK_ASSIGNED"),
    (c) => `Uma tarefa foi atribuída a você: ${quote(c[0].s)}`,
  ],
  [
    "blocker",
    (c) => c.d.types.includes("BLOCKER"),
    (c) => `Há um bloqueio dependendo de você: ${quote(c[0].s)}`,
  ],
  [
    "deadline",
    (c) => c.d.types.includes("DEADLINE") && !!deadlineOf(c.s.text),
    (c) => `Prazo mencionado: ${deadlineOf(c[0].s.text)}.`,
  ],
  [
    "conflict",
    (c) => c.d.types.includes("CONFLICT"),
    (c) => `Houve uma divergência envolvendo você: ${quote(c[0].s)}`,
  ],
];
export function catchUp(
  m: Meeting,
  now: number,
  ultra = false,
  profile: UserProfile = defaultProfile,
  settings: Settings = defaultSettings,
) {
  const since = m.catchUpSince ?? m.lastUserAttentionAt;
  const until = m.catchUpUntil ?? now;
  const inWindow = (s: TranscriptSegment) => s.endTime > since && s.endTime <= until;
  const missed = classify(m, profile, settings).filter((c) => inWindow(c.s));
  const pending = m.events.filter((e) => isOpen(e) && e.requiresResponse);
  const awaiting = pending.filter((e) => e.detectedAt <= until && e.updatedAt > since);
  let summary: string[];
  if (ultra) {
    // §21: one line per category, question first among requests.
    summary = [];
    const [decision, ...rest] = ESSENTIALS;
    const hit = (rule: (typeof ESSENTIALS)[number]) => {
      const found = missed.filter(rule[1]);
      if (found.length) summary.push(rule[2](found));
    };
    hit(decision);
    hit(rest[0]);
    if (awaiting.length)
      summary.push(
        `Existe uma pergunta aguardando sua resposta: “${awaiting.sort((a, b) => b.score - a.score)[0].quote}”`,
      );
    for (const rule of rest.slice(1)) hit(rule);
  } else
    summary = missed.map(bullet).filter((b): b is string => !!b);
  const missedSeconds = Math.max(0, Math.floor((until - since) / 1000));
  return {
    missedSeconds,
    missedLabel: formatDuration(missedSeconds),
    from: since,
    to: until,
    summary,
    lines: missed.map(({ s }) => `${s.speakerId}: ${s.text}`),
    action: actionFor(m, awaiting),
    pending: pending.map((e) => ({
      eventId: e.id,
      question: e.quote,
      reason: e.reason,
    })),
    source: "local-extractive" as const,
  };
}
export function generateResponse(m: Meeting, e: AttentionEvent) {
  const segments = m.transcript.filter(
    (s) =>
      s.endTime >= e.detectedAt - 120000 && s.endTime <= e.updatedAt + 15000,
  );
  if (!isOpen(e) || !e.requiresResponse || segments.length === 0)
    return {
      safe: false,
      reason: "Não tenho contexto suficiente para sugerir uma resposta segura.",
      short: "",
      professional: "",
      detailed: "",
      sourceSegmentIds: segments.map((s) => s.id),
    };
  return {
    safe: true,
    reason:
      "Rascunhos conservadores: revise antes de copiar. Nenhuma disponibilidade ou decisão foi presumida.",
    short: "Entendi o pedido. Vou verificar o contexto antes de confirmar.",
    professional:
      "Recebi a solicitação. Preciso verificar o impacto e minha disponibilidade antes de confirmar um prazo. Qual é o critério de conclusão?",
    detailed: `Entendi que vocês estão aguardando uma resposta sobre este ponto: “${e.quote}”. Vou verificar as informações necessárias antes de confirmar a execução ou aprovação. Podem esclarecer o resultado esperado e o prazo?`,
    sourceSegmentIds: segments.map((s) => s.id),
  };
}
/** Someone else's task: "João vai cuidar do layout amanhã." */
const OTHER_TASK =
  /\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ú]+) (?:vai|precisa) ((?:cuidar|fazer|verificar|corrigir|revisar|entregar)\b.*?)\s*[.!]*$/;
/** The user's own assignment: "Nataniel ficou responsável pelo endpoint." */
const OWN_TASK =
  /\b(?:respons[aá]vel (?:por|pel[oa]s?)|ficou com|vai cuidar d[eoa]s?|precisa entregar|vai fazer)\s+(.+?)\s*[.!?]*$/i;
export function extractTasks(
  m: Meeting,
  profile: UserProfile = defaultProfile,
  settings: Settings = defaultSettings,
): ActionItem[] {
  const tasks: ActionItem[] = [];
  const eventOf = (s: TranscriptSegment) =>
    m.events.find((e) => e.segmentIds.includes(s.id));
  // A request's deadline often comes in a later sentence of the same event.
  const dueFor = (s: TranscriptSegment) => {
    const ids = eventOf(s)?.segmentIds ?? [s.id];
    for (const x of m.transcript.filter((t) => ids.includes(t.id))) {
      const due = deadlineOf(x.text);
      if (due) return due;
    }
    return null;
  };
  const push = (s: TranscriptSegment, owner: string, text: string, confidence: number) =>
    tasks.push({
      id: `task-${s.id}`,
      meetingId: m.id,
      text,
      owner,
      deadline: dueFor(s),
      confidence: Math.round(confidence * 100) / 100,
      status: "PROPOSED",
      sourceSegmentId: s.id,
    });
  for (const { s, d } of classify(m, profile, settings)) {
    if (d.types.includes("TASK_ASSIGNED")) {
      push(s, profile.name, s.text.match(OWN_TASK)?.[1] ?? s.text, d.confidence);
      continue;
    }
    const ask = requestOf(s.text);
    if (d.requiresResponse && ask && (d.types.includes("DIRECT_QUESTION") || d.types.includes("INDIRECT_QUESTION"))) {
      push(s, profile.name, ask, d.confidence * 0.9);
      continue;
    }
    const other = s.text.match(OTHER_TASK);
    if (other && !d.types.includes("MENTION")) push(s, other[1], other[2], 0.6);
  }
  return tasks;
}
const TOPIC_LABEL: Record<string, string> = {
  api: "API",
  auth: "autenticação",
  frontend: "frontend",
  redis: "Redis",
};
const TIMELINE: Partial<Record<EventType, [TimelineKind, (s: TranscriptSegment, p: UserProfile) => string]>> = {
  BLOCKER: ["BLOCKER", () => "bloqueio dependendo de você"],
  DIRECT_QUESTION: ["QUESTION", (s) => `pergunta direta de ${s.speakerId}`],
  DECISION_REQUIRED: ["QUESTION", () => "decisão solicitada"],
  APPROVAL_REQUIRED: ["QUESTION", () => "aprovação solicitada"],
  CONFIRMATION_REQUIRED: ["QUESTION", () => "confirmação solicitada"],
  INDIRECT_QUESTION: ["QUESTION", () => "pergunta indireta"],
  TASK_ASSIGNED: ["TASK", () => "tarefa atribuída a você"],
  FOLLOW_UP: ["FOLLOW_UP", (s) => `cobrança de ${s.speakerId}`],
  DEADLINE: ["DEADLINE", (s) => `prazo: ${deadlineOf(s.text) ?? "mencionado"}`],
  CONFLICT: ["CONFLICT", (s) => `divergência (${s.speakerId})`],
  IMPORTANT_CONTEXT: ["DECISION", () => "decisão ou mudança no seu trabalho"],
  MENTION: ["MENTION", (_s, p) => `${p.name} mencionado`],
};
/** §36: start, topic shifts, relevant moments, decisions and end. */
export function timeline(
  m: Meeting,
  profile: UserProfile = defaultProfile,
  settings: Settings = defaultSettings,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ at: m.startedAt, kind: "START", text: "reunião começou" }];
  let topic: string | undefined;
  for (const c of classify(m, profile, settings)) {
    const at = c.s.startTime,
      t = topicOf(normalize(c.s.text));
    if (KNOWN_TOPICS.has(t) && t !== topic) {
      topic = t;
      entries.push({ at, kind: "TOPIC", text: `discussão ${TOPIC_LABEL[t]}` });
    }
    const p = primary(c.d),
      rule = p && TIMELINE[p];
    if (rule) entries.push({ at, kind: rule[0], text: rule[1](c.s, profile) });
    else if (isDecision(c.s.text)) entries.push({ at, kind: "DECISION", text: "decisão tomada" });
  }
  entries.sort((a, b) => a.at - b.at);
  // Segment clocks come from the capture source; never list speech after the end.
  if (m.endedAt)
    entries.push({
      at: Math.max(m.endedAt, entries.at(-1)!.at),
      kind: "END",
      text: "reunião finalizada",
    });
  return entries;
}
const unresolved = (e: AttentionEvent) =>
  e.requiresResponse && e.status !== "RESPONDED" && e.status !== "DISMISSED";
export function summarizeMeeting(
  m: Meeting,
  profile: UserProfile = defaultProfile,
  settings: Settings = defaultSettings,
) {
  const classified = classify(m, profile, settings);
  // Stored tasks keep the user's confirm/edit/ignore decisions (§35).
  const stored = new Map((m.tasks ?? []).map((t) => [t.id, t]));
  const tasks = extractTasks(m, profile, settings).map((t) => stored.get(t.id) ?? t);
  const questions = m.events.filter((e) => e.requiresResponse);
  return {
    title: m.title,
    source: "local-extractive" as const,
    summary: classified.map(bullet).filter((b): b is string => !!b),
    transcript: classified.map(({ s }) => `${s.speakerId}: ${s.text}`),
    decisions: classified
      .filter(({ s }) => isDecision(s.text))
      .map(({ s }) => ({ text: s.text, speaker: s.speakerId, at: s.startTime })),
    tasks,
    questions: questions.map((e) => ({
      eventId: e.id,
      question: e.quote,
      speaker: firstSegment(m, e)?.speakerId ?? null,
      status: e.status,
    })),
    pending: m.events.filter((e) => isOpen(e) && e.requiresResponse),
    /** Relevant events the user never opened. */
    missed: m.events.filter(
      (e) => e.score > 40 && ["DETECTED", "NOTIFIED", "EXPIRED"].includes(e.status),
    ),
    ignored: m.events.filter((e) => e.status === "DISMISSED"),
    attentionItems: m.events.filter((e) => e.score >= 61),
    followUps: [
      ...questions.filter(unresolved).map((e) => {
        const who = firstSegment(m, e)?.speakerId;
        return `Responder a ${who ?? "pedido"}: “${e.quote}”`;
      }),
      ...tasks
        .filter((t) => t.status === "PROPOSED")
        .map((t) => `Confirmar tarefa de ${t.owner}: ${t.text}`),
    ],
    timeline: timeline(m, profile, settings),
  };
}
