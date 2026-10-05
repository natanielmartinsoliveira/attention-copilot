import {
  type AttentionEvent,
  type Detection,
  type EventType,
  type Meeting,
  type Settings,
  type TranscriptSegment,
  type UserProfile,
  type Recommendation,
} from "./types.js";
export const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function mentions(text: string, p: UserProfile) {
  return [p.name, p.fullName, ...p.aliases]
    .filter(Boolean)
    .some((n) =>
      new RegExp(`(?:^|[^a-z0-9])${esc(normalize(n))}(?=$|[^a-z0-9])`).test(
        normalize(text),
      ),
    );
}
export const level = (score: number) =>
  score <= 20
    ? "NONE"
    : score <= 40
      ? "LOW"
      : score <= 60
        ? "MEDIUM"
        : score <= 80
          ? "HIGH"
          : "URGENT";
export const isOpen = (e: AttentionEvent) =>
  !["RESPONDED", "DISMISSED", "EXPIRED"].includes(e.status);
const topicOf = (t: string) =>
  /endpoint|api|backend/.test(t)
    ? "api"
    : /autentic|login|token/.test(t)
      ? "auth"
      : /frontend|layout/.test(t)
        ? "frontend"
        : /redis/.test(t)
          ? "redis"
          : normalize(t)
              .replace(/[^a-z0-9 ]/g, "")
              .split(" ")
              .filter((w) => w.length > 4)
              .slice(-3)
              .join(" ") || "general";
export class AttentionEngine {
  detect(
    segment: TranscriptSegment,
    context: TranscriptSegment[],
    profile: UserProfile,
    settings: Settings,
  ): Detection {
    const t = normalize(segment.text),
      named = mentions(t, profile),
      recent = context.filter(
        (s) =>
          segment.endTime - s.endTime <= 120000 && s.endTime <= segment.endTime,
      ),
      c = normalize(recent.map((s) => s.text).join(" "));
    const none = (
      score = 18,
      types: EventType[] = ["NONE"],
      reason = "Discussão geral. Nenhuma ação identificada para você.",
    ): Detection => ({
      types,
      score,
      confidence: 0.65,
      requiresResponse: false,
      reason,
      topic: topicOf(t),
    });
    if (
      /nao (?:precisamos|precisa|necessitamos).*resposta|nao.*(?:responder|verificar).*agora|ja (?:foi )?(?:resolvido|respondido)|nao esta mais bloqueado/.test(
        t,
      )
    )
      return none(
        8,
        ["NONE"],
        "Pedido dispensado ou resolvido explicitamente.",
      );
    if (
      named &&
      /\b(bom dia|boa tarde|boa noite|obrigad[oa]|parabens|oi)\b/.test(t) &&
      !/\?|consegue|precisa|responsavel/.test(t)
    )
      return none(
        25,
        ["MENTION"],
        "Menção casual. Nenhuma resposta necessária.",
      );
    const question =
      /\?|\b(consegue|pode verificar|qual.*opiniao|quem pode|alguem sabe|podemos|confirma|conseguiu)\b/.test(
        t,
      );
    const historical =
      /\b(ontem|semana passada|anteriormente|foi responsavel|era responsavel)\b/.test(
        t,
      );
    const assignment =
      /\b(responsavel|ficou com|atribu|vai cuidar|precisa entregar)\b/.test(t);
    const waiting =
      /\b(esperar|aguardando|esperando|precisamos da resposta|sem.*resposta)\b/.test(
        t,
      );
    const priorRelevant = recent.filter(
      (s) =>
        mentions(s.text, profile) &&
        /responsavel|trabalha|cuida|conhece|consegue|verificar|endpoint|api/i.test(
          normalize(s.text),
        ),
    );
    const prior = priorRelevant.length > 0;
    const expertise = profile.expertise.some((x) =>
      new RegExp(`(?:^|[^a-z0-9])${esc(normalize(x))}(?=$|[^a-z0-9])`).test(t),
    );
    const ongoing =
      prior &&
      /\b(precisamos disso|sem isso|precisamos da resposta|conseguiu|prazo|antes das|bloquead)\b/.test(
        t,
      );
    const relevant = named || (prior && question) || ongoing;
    const types: EventType[] = [];
    let score = 18,
      requiresResponse = false,
      confidence = 0.7;
    if (named) {
      types.push("MENTION");
      score = 30;
    }
    if (named && question && !historical) {
      types.push("DIRECT_QUESTION");
      score = 78;
      requiresResponse = true;
      confidence = 0.92;
    } else if (prior && question) {
      types.push("INDIRECT_QUESTION");
      score = 67;
      requiresResponse = true;
      confidence = 0.72;
    } else if (expertise && question) {
      types.push("USER_EXPERTISE_REQUIRED");
      score = 52;
      confidence = 0.6;
    }
    if (named && assignment) {
      types.push(historical ? "USER_RESPONSIBILITY" : "TASK_ASSIGNED");
      score = Math.max(score, historical ? 35 : 76);
      requiresResponse = !historical;
    }
    if (relevant && /podemos.*(?:producao|deploy)|decidir|decisao/.test(t)) {
      types.push("DECISION_REQUIRED");
      score = Math.max(score, 80);
      requiresResponse = true;
    }
    if (relevant && /aprov|autoriz/.test(t)) {
      types.push("APPROVAL_REQUIRED");
      score = Math.max(score, 80);
      requiresResponse = true;
    }
    if (relevant && /confirm/.test(t)) {
      types.push("CONFIRMATION_REQUIRED");
      score = Math.max(score, 78);
      requiresResponse = true;
    }
    if (relevant && waiting) {
      types.push("FOLLOW_UP");
      score = Math.max(score, 80);
      requiresResponse = true;
    }
    if (relevant && /hoje|antes das|ate as|prazo|amanha/.test(t)) {
      types.push("DEADLINE");
      score = Math.max(score, prior ? 87 : score + 15);
      requiresResponse = true;
    }
    if (
      relevant &&
      /sem isso|bloquead|nao conseguimos.*deploy|para continuar/.test(t)
    ) {
      types.push("BLOCKER");
      score = Math.max(score, 97);
      requiresResponse = true;
      confidence = 0.9;
    }
    if (relevant && /urgente|agora|imediat/.test(t)) {
      types.push("URGENT_REQUEST");
      score = Math.max(score, 90);
      requiresResponse = true;
    }
    if (
      !types.length &&
      profile.projects.some((p) => normalize(t).includes(normalize(p.name)))
    ) {
      types.push("USER_TOPIC");
      score = 40;
    }
    if (!types.length) return none();
    const weighted = Math.max(...types.map((x) => score * settings.weights[x]));
    const importance = Math.max(
      0,
      ...profile.projects
        .filter((p) => t.includes(normalize(p.name)))
        .map((p) => p.importance),
      ...profile.people
        .filter((p) => normalize(segment.speakerId) === normalize(p.name))
        .map((p) => p.importance),
    );
    score = Math.round(
      Math.min(100, weighted + (score > 40 ? importance / 20 : 0)),
    );
    const labels: Partial<Record<EventType, string>> = {
      DIRECT_QUESTION: "Pergunta direta para você",
      INDIRECT_QUESTION: "Pergunta ligada à sua responsabilidade no contexto",
      TASK_ASSIGNED: "Tarefa atribuída a você",
      DEADLINE: "Prazo mencionado",
      BLOCKER: "O avanço depende desta resposta",
      FOLLOW_UP: "Aguardam sua resposta",
      MENTION: "Seu nome foi mencionado",
      USER_EXPERTISE_REQUIRED: "Possível necessidade da sua experiência",
      DECISION_REQUIRED: "Decisão solicitada",
      APPROVAL_REQUIRED: "Aprovação solicitada",
      CONFIRMATION_REQUIRED: "Confirmação solicitada",
    };
    confidence = Math.min(confidence, segment.confidence);
    return {
      types,
      score,
      confidence,
      requiresResponse,
      reason: types
        .filter((x) => x !== "MENTION" || types.length === 1)
        .map((x) => labels[x] ?? x)
        .join(" + "),
      topic: ongoing ? topicOf(c) : topicOf(t),
    };
  }
  ingest(
    meeting: Meeting,
    segment: TranscriptSegment,
    profile: UserProfile,
    settings: Settings,
    now: number,
    id: string,
  ): AttentionEvent | undefined {
    if (meeting.transcript.some((s) => s.id === segment.id)) return;
    const context = meeting.transcript.slice(-80);
    meeting.transcript.push(segment);
    const d = this.detect(segment, context, profile, settings);
    if (d.score <= 20) {
      if (d.reason.startsWith("Pedido")) {
        const resolved = [...meeting.events]
          .reverse()
          .find(
            (e) =>
              isOpen(e) &&
              (d.topic === e.topic ||
                d.topic === "general" ||
                /nao.*resposta/.test(normalize(segment.text))),
          );
        if (resolved) {
          resolved.status = "RESPONDED";
          resolved.updatedAt = now;
        }
      }
      this.refresh(meeting, settings, now);
      return;
    }
    const related = [...meeting.events]
      .reverse()
      .find(
        (e) =>
          isOpen(e) &&
          now - e.updatedAt <= 120000 &&
          (e.topic === d.topic ||
            (d.requiresResponse &&
              (d.types.includes("DEADLINE") ||
                d.types.includes("BLOCKER") ||
                d.types.includes("FOLLOW_UP")))),
      );
    let e: AttentionEvent;
    if (related && d.requiresResponse) {
      e = related;
      e.types = [...new Set([...e.types, ...d.types])];
      e.segmentIds.push(segment.id);
      e.updatedAt = now;
      e.repeats++;
      e.score = Math.min(
        100,
        Math.max(d.score, e.score) +
          (d.types.includes("DIRECT_QUESTION") ? 3 : 0),
      );
      e.reason = [...new Set([e.reason, d.reason])].join("; ");
      e.requiresResponse = true;
    } else {
      e = {
        ...d,
        id,
        meetingId: meeting.id,
        level: level(d.score),
        requiresImmediateAttention: d.score >= 81 && d.confidence >= 0.8,
        recommendedAction: d.requiresResponse
          ? "Confira o contexto e responda."
          : "Continue focado.",
        status: "DETECTED",
        segmentIds: [segment.id],
        detectedAt: now,
        updatedAt: now,
        repeats: 1,
        quote: segment.text,
      };
      meeting.events.push(e);
    }
    e.level = level(e.score);
    e.requiresImmediateAttention = e.score >= 81 && e.confidence >= 0.8;
    if (this.shouldNotify(e, settings, now)) {
      e.status = "NOTIFIED";
      e.notifiedAt = now;
      e.notifiedScore = e.score;
    }
    meeting.lastRelevantEventAt = now;
    this.refresh(meeting, settings, now);
    return e;
  }
  shouldNotify(e: AttentionEvent, s: Settings, now: number) {
    return (
      isOpen(e) &&
      e.score >= 61 &&
      e.confidence >= 0.7 &&
      (!e.notifiedAt ||
        (now - e.notifiedAt >= s.cooldownMs &&
          e.score - (e.notifiedScore ?? 0) >= 10))
    );
  }
  refresh(m: Meeting, s: Settings, now: number) {
    for (const e of m.events.filter(isOpen)) {
      if (now - e.updatedAt >= s.expireMs) {
        e.status = "EXPIRED";
        continue;
      }
      const age = Math.floor((now - e.updatedAt) / 60000);
      const score = e.requiresResponse
        ? Math.min(100, e.score + Math.min(12, age * 2))
        : Math.max(0, e.score - age * 5);
      e.level = level(score);
    }
    m.attentionScore = Math.max(
      m.status === "ENDED" ? 0 : 18,
      ...m.events
        .filter(isOpen)
        .map((e) =>
          e.requiresResponse
            ? Math.min(
                100,
                e.score +
                  Math.min(12, Math.floor((now - e.updatedAt) / 60000) * 2),
              )
            : Math.max(
                0,
                e.score - Math.floor((now - e.updatedAt) / 60000) * 5,
              ),
        ),
    );
  }
}
export class MeetingPriorityEngine {
  recommend(
    meetings: Meeting[],
    focusId: string | null,
    delta = 25,
  ): Recommendation {
    const active = meetings.filter((m) => m.status === "ACTIVE");
    const best = [...active].sort(
      (a, b) => b.attentionScore - a.attentionScore,
    )[0];
    const current = active.find((m) => m.id === focusId);
    const event = best?.events
      .filter(isOpen)
      .sort((a, b) => b.score - a.score)[0];
    const change =
      !!best &&
      best.id !== focusId &&
      best.attentionScore >= 61 &&
      best.attentionScore - (current?.attentionScore ?? 0) >= delta &&
      (event?.confidence ?? 0) >= 0.7;
    return {
      meetingId: change ? best.id : focusId,
      switchAttention: change,
      reason: change
        ? `${best.title} precisa de atenção: ${event?.reason ?? "Prioridade elevada"}`
        : "Tudo tranquilo. Você pode continuar focado.",
      confidence: change ? (event?.confidence ?? 0.6) : 0.8,
    };
  }
}
