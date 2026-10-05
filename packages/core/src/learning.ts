import type { EventType, Settings } from "./types.js";
// §51 personalization without ML: feedback becomes weight *suggestions* the
// user applies explicitly. Nothing changes silently.
export type FeedbackRating =
  | "useful"
  | "unimportant"
  | "false-positive"
  /** Implicit: the user pressed "Ignorar". */
  | "dismissed"
  /** Implicit: the user marked it answered. */
  | "responded";
export interface FeedbackSignal {
  eventId: string;
  /** The event's lead type: what the alert was mainly about. */
  type: EventType;
  rating: FeedbackRating;
  at: number;
}
export const SIGNAL_VALUE: Record<FeedbackRating, number> = {
  useful: 1,
  responded: 0.5,
  dismissed: -0.5,
  unimportant: -1,
  "false-positive": -1.5,
};
const LEAD_ORDER: EventType[] = [
  "BLOCKER",
  "DIRECT_QUESTION",
  "DECISION_REQUIRED",
  "APPROVAL_REQUIRED",
  "CONFIRMATION_REQUIRED",
  "URGENT_REQUEST",
  "INDIRECT_QUESTION",
  "TASK_ASSIGNED",
  "FOLLOW_UP",
  "DEADLINE",
  "CONFLICT",
  "IMPORTANT_CONTEXT",
  "USER_EXPERTISE_REQUIRED",
  "USER_RESPONSIBILITY",
  "TASK_DISCUSSION",
  "USER_TOPIC",
  "MENTION",
];
/** Credits feedback to one type, so a useful question does not also boost MENTION. */
export function leadType(types: readonly EventType[]): EventType {
  return LEAD_ORDER.find((t) => types.includes(t)) ?? types[0] ?? "NONE";
}
export const TYPE_LABEL: Partial<Record<EventType, string>> = {
  MENTION: "menção",
  DIRECT_QUESTION: "pergunta direta",
  INDIRECT_QUESTION: "pergunta indireta",
  TASK_ASSIGNED: "tarefa atribuída",
  TASK_DISCUSSION: "discussão de tarefa",
  DECISION_REQUIRED: "decisão",
  USER_RESPONSIBILITY: "responsabilidade",
  USER_TOPIC: "assunto de projeto",
  USER_EXPERTISE_REQUIRED: "expertise",
  DEADLINE: "prazo",
  BLOCKER: "bloqueio",
  URGENT_REQUEST: "pedido urgente",
  FOLLOW_UP: "cobrança",
  IMPORTANT_CONTEXT: "contexto importante",
  CONFLICT: "divergência",
  APPROVAL_REQUIRED: "aprovação",
  CONFIRMATION_REQUIRED: "confirmação",
};
export interface WeightSuggestion {
  type: EventType;
  current: number;
  suggested: number;
  signals: number;
  reason: string;
}
const WINDOW_MS = 30 * 86400000;
const MIN_SIGNALS = 3;
const STEP = 0.3;
export function suggestWeights(
  log: readonly FeedbackSignal[],
  weights: Settings["weights"],
  now = Date.now(),
  /** When a suggestion was last applied per type: older signals are spent. */
  appliedAt: Partial<Record<EventType, number>> = {},
): WeightSuggestion[] {
  const byType = new Map<EventType, FeedbackSignal[]>();
  for (const s of log)
    if (now - s.at <= WINDOW_MS && s.at > (appliedAt[s.type] ?? -Infinity))
      byType.set(s.type, [...(byType.get(s.type) ?? []), s]);
  const out: WeightSuggestion[] = [];
  for (const [type, signals] of byType) {
    if (signals.length < MIN_SIGNALS) continue;
    const mean =
      signals.reduce((sum, s) => sum + SIGNAL_VALUE[s.rating], 0) / signals.length;
    const current = weights[type] ?? 1;
    const suggested =
      Math.round(Math.min(2, Math.max(0.2, current + STEP * mean)) * 20) / 20;
    if (Math.abs(suggested - current) < 0.1 - 1e-9) continue;
    const negative = signals.filter((s) => SIGNAL_VALUE[s.rating] < 0).length,
      positive = signals.length - negative,
      label = TYPE_LABEL[type] ?? type;
    out.push({
      type,
      current,
      suggested,
      signals: signals.length,
      reason:
        suggested < current
          ? `${negative} de ${signals.length} alertas de ${label} foram ignorados ou avaliados como pouco úteis.`
          : `${positive} de ${signals.length} alertas de ${label} foram úteis ou respondidos.`,
    });
  }
  return out.sort((a, b) => b.signals - a.signals);
}
