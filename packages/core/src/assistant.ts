import { isOpen } from "./engine.js";
import type { Meeting, AttentionEvent } from "./types.js";
export function catchUp(m: Meeting, now: number, ultra = false) {
  const since = m.catchUpSince ?? m.lastUserAttentionAt;
  const until = m.catchUpUntil ?? now;
  const missed = m.transcript.filter(
    (s) => s.endTime > since && s.endTime <= until,
  );
  const events = m.events.filter(
    (e) => e.detectedAt <= until && e.updatedAt > since,
  );
  return {
    missedSeconds: Math.max(0, Math.floor((until - since) / 1000)),
    from: since,
    to: until,
    summary: ultra
      ? events
          .filter((e) => e.requiresResponse || e.score > 40)
          .map((e) => e.reason)
      : missed.map((s) => `${s.speakerId}: ${s.text}`),
    pending: m.events
      .filter((e) => isOpen(e) && e.requiresResponse)
      .map((e) => ({ eventId: e.id, question: e.quote, reason: e.reason })),
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
export function summarizeMeeting(m: Meeting) {
  return {
    title: m.title,
    source: "local-extractive",
    summary: m.transcript.map((s) => `${s.speakerId}: ${s.text}`),
    tasks: m.events
      .filter((e) => e.types.includes("TASK_ASSIGNED"))
      .map((e) => ({
        text: e.quote,
        status: e.status,
        confidence: e.confidence,
      })),
    decisions: [],
    pending: m.events.filter((e) => isOpen(e) && e.requiresResponse),
    ignored: m.events.filter((e) => e.status === "DISMISSED"),
    attentionItems: m.events.filter((e) => e.score >= 61),
  };
}
