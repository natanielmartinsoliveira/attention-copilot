import {
  type AlertChannel,
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
/** Folds spelling variants STT engines produce for names ("Nathaniel" for
 * "Nataniel"). Whole-word matching still applies, so "Nataniela" stays out. */
const phonetic = (s: string) =>
  normalize(s)
    .replace(/th/g, "t")
    .replace(/ph/g, "f")
    .replace(/y/g, "i")
    .replace(/([a-z])\1+/g, "$1");
export function mentions(text: string, p: UserProfile) {
  const spoken = phonetic(text);
  return [p.name, p.fullName, ...p.aliases]
    .filter(Boolean)
    .some((n) =>
      new RegExp(`(?:^|[^a-z0-9])${esc(phonetic(n))}(?=$|[^a-z0-9])`).test(spoken),
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
export const KNOWN_TOPICS = new Set(["api", "auth", "frontend", "redis"]);
export const topicOf = (t: string) =>
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
/** Unanswered requests escalate, informational ones fade; e.score keeps the
 * detected value so notification thresholds stay stable. */
export function effectiveScore(e: AttentionEvent, now: number) {
  const age = Math.floor((now - e.updatedAt) / 60000);
  return e.requiresResponse
    ? Math.min(100, e.score + Math.min(12, age * 2))
    : Math.max(0, e.score - age * 5);
}
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
    // Only "not needed" phrasing counts: a bare negation ("não conseguimos
    // verificar agora") is usually a blocker, not a dismissal.
    if (
      /nao (?:precisamos|precisa|necessitamos|e (?:mais )?(?:preciso|necessario))\b.*\b(?:resposta|responder|verificar)|ja (?:foi )?(?:resolvido|respondido)|nao esta mais bloqueado/.test(
        t,
      )
    )
      return {
        ...none(8, ["NONE"], "Pedido dispensado ou resolvido explicitamente."),
        dismissal: true,
      };
    if (
      named &&
      /\b(bom dia|boa tarde|boa noite|obrigad[oa]|parabens|oi)\b/.test(t) &&
      !/\?|consegue|precisa|responsavel/.test(t)
    )
      return none(
        Math.round(25 * settings.weights.MENTION),
        ["MENTION"],
        "Menção casual. Nenhuma resposta necessária.",
      );
    const question =
      /\?|\b(consegue|pode verificar|qual.*opiniao|quem pode|alguem sabe|podemos|confirma)\b/.test(
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
    // Chasing an earlier request ("conseguiu?", "alguma novidade?"). A bare
    // "Nataniel conseguiu…" is a statement, so it needs "?" or a chasing cue.
    const nudge =
      named &&
      !historical &&
      (/\b(alguma novidade|e ai)\b|ja (?:conseguiu|viu|olhou)/.test(t) ||
        (/\bconseguiu\b/.test(t) && t.includes("?")));
    // Looking for someone with a skill, phrased without a question mark.
    const seeking =
      /alguem que (?:conhec|saib|entend|domin)|precisamos de alguem|quem (?:conhece|sabe|entende)/.test(
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
    // Base score per type, so each weight scales only its own type.
    const base: Partial<Record<EventType, number>> = {};
    let score = 18,
      requiresResponse = false,
      confidence = 0.7;
    const add = (type: EventType, value: number) => {
      types.push(type);
      base[type] = value;
      score = Math.max(score, value);
    };
    if (named) add("MENTION", 30);
    if (named && question && !historical) {
      add("DIRECT_QUESTION", 78);
      requiresResponse = true;
      confidence = 0.92;
    } else if (prior && question) {
      add("INDIRECT_QUESTION", 67);
      requiresResponse = true;
      confidence = 0.72;
    } else if (expertise && (question || seeking)) {
      add("USER_EXPERTISE_REQUIRED", 52);
      confidence = 0.6;
    }
    if (named && assignment) {
      // A current assignment is both a responsibility and a task (§7, §28);
      // a past one is context only.
      add("USER_RESPONSIBILITY", historical ? 35 : 76);
      if (!historical) add("TASK_ASSIGNED", 76);
      requiresResponse = !historical;
    }
    if (relevant && /podemos.*(?:producao|deploy)|decidir|decisao/.test(t)) {
      add("DECISION_REQUIRED", 80);
      requiresResponse = true;
    }
    if (relevant && /aprov|autoriz/.test(t)) {
      add("APPROVAL_REQUIRED", 80);
      requiresResponse = true;
    }
    if (relevant && /confirm/.test(t)) {
      add("CONFIRMATION_REQUIRED", 78);
      requiresResponse = true;
    }
    if ((relevant && waiting) || nudge) {
      add("FOLLOW_UP", 80);
      requiresResponse = true;
    }
    if (relevant && /hoje|antes das|ate as|prazo|amanha/.test(t)) {
      add("DEADLINE", prior ? 87 : score + 15);
      requiresResponse = true;
    }
    if (
      relevant &&
      /sem isso|bloquead|nao conseguimos.*deploy|para continuar/.test(t)
    ) {
      add("BLOCKER", 97);
      requiresResponse = true;
      confidence = 0.9;
    }
    if (relevant && /urgente|agora|imediat/.test(t)) {
      add("URGENT_REQUEST", 90);
      requiresResponse = true;
    }
    // Contextual types fire only when tied to the user (name, recent
    // ownership context, a profile project or expertise): §66 silence.
    const project = profile.projects.some((p) =>
      t.includes(normalize(p.name)),
    );
    const area = prior || project || expertise;
    if (
      (named || area) &&
      /\b(discordo|nao concordo|conflito|vai quebrar|contradiz|nao faz sentido)\b/.test(
        t,
      )
    ) {
      add("CONFLICT", named ? 70 : 55);
      if (named) requiresResponse = true;
    }
    if (
      !named &&
      area &&
      /\b(decidimos|ficou decidido|foi decidido|vamos mudar|mudamos|foi cancelad\w*|foi adiad\w*|novo prazo)\b/.test(
        t,
      )
    ) {
      add("IMPORTANT_CONTEXT", 45);
      confidence = Math.min(confidence, 0.65);
    }
    if (
      !types.length &&
      area &&
      /\b(precisamos (?:fazer|implementar|corrigir|criar|ajustar)|vamos (?:implementar|corrigir|criar|refatorar|ajustar)|tarefa|ticket|card)\b/.test(
        t,
      )
    ) {
      add("TASK_DISCUSSION", 38);
      confidence = Math.min(confidence, 0.65);
    }
    if (!types.length && project) add("USER_TOPIC", 40);
    if (!types.length) return none();
    const weighted = Math.max(
      ...types.map((x) => (base[x] ?? score) * settings.weights[x]),
    );
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
      USER_RESPONSIBILITY: "Você foi citado como responsável",
      TASK_DISCUSSION: "Discussão de tarefa ligada ao seu trabalho",
      IMPORTANT_CONTEXT: "Decisão ou mudança que afeta seu trabalho",
      CONFLICT: "Divergência envolvendo você ou seu trabalho",
      USER_TOPIC: "Assunto de um dos seus projetos",
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
        .filter(
          (x) =>
            (x !== "MENTION" || types.length === 1) &&
            (x !== "USER_RESPONSIBILITY" || !types.includes("TASK_ASSIGNED")),
        )
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
      if (d.dismissal) {
        // A dismissal naming a known topic only closes that topic; a generic
        // one ("não precisamos da resposta") closes the latest open request.
        const generic =
          !KNOWN_TOPICS.has(d.topic) &&
          (d.topic === "general" ||
            /respost|respond/.test(normalize(segment.text)));
        const resolved = [...meeting.events]
          .reverse()
          .find((e) => isOpen(e) && (e.topic === d.topic || generic));
        if (resolved) {
          resolved.status = "RESPONDED";
          resolved.updatedAt = now;
        }
      }
      this.refresh(meeting, settings, now);
      return;
    }
    // A follow-up chases an older request, so it may join any open event
    // still alive; other relations only hold within the 120 s context window.
    const window = d.types.includes("FOLLOW_UP") ? settings.expireMs : 120000;
    const related = [...meeting.events]
      .reverse()
      .find(
        (e) =>
          isOpen(e) &&
          now - e.updatedAt < window &&
          (e.topic === d.topic ||
            (d.requiresResponse &&
              (d.types.includes("DEADLINE") ||
                d.types.includes("BLOCKER") ||
                d.types.includes("FOLLOW_UP")))),
      );
    let e: AttentionEvent;
    if (related && d.requiresResponse) {
      e = related;
      // Start from the escalated score so a repeat never lowers priority,
      // then bump: chasing (+5) weighs more than re-asking (+3).
      const escalated = effectiveScore(e, now);
      e.types = [...new Set([...e.types, ...d.types])];
      e.segmentIds.push(segment.id);
      e.updatedAt = now;
      e.repeats++;
      e.score = Math.min(
        100,
        Math.max(d.score, escalated) +
          (d.types.includes("FOLLOW_UP")
            ? 5
            : d.types.includes("DIRECT_QUESTION")
              ? 3
              : 0),
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
  /** Re-derives level, flags and notification after an external re-score. */
  rescore(m: Meeting, e: AttentionEvent, s: Settings, now: number) {
    e.level = level(e.score);
    e.requiresImmediateAttention = e.score >= 81 && e.confidence >= 0.8;
    if (this.shouldNotify(e, s, now)) {
      e.status = "NOTIFIED";
      e.notifiedAt = now;
      e.notifiedScore = e.score;
    }
    this.refresh(m, s, now);
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
    const scores = [m.status === "ENDED" ? 0 : 18];
    for (const e of m.events.filter(isOpen)) {
      if (now - e.updatedAt >= s.expireMs) {
        e.status = "EXPIRED";
        continue;
      }
      const score = effectiveScore(e, now);
      e.level = level(score);
      e.requiresImmediateAttention = score >= 81 && e.confidence >= 0.8;
      scores.push(score);
    }
    m.attentionScore = Math.max(...scores);
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
    if (change)
      return {
        meetingId: best.id,
        switchAttention: true,
        state: "SWITCH",
        eventId: event?.id,
        reason: `${best.title} precisa de atenção: ${event?.reason ?? "Prioridade elevada"}`,
        confidence: event?.confidence ?? 0.6,
      };
    // Relevant outside the focus but below the switch bar (confidence or
    // delta): surface it as 🟡 instead of pretending certainty either way.
    const possible = active
      .filter((m) => m.id !== focusId)
      .flatMap((m) =>
        m.events.filter((e) => isOpen(e) && e.score > 40).map((e) => ({ m, e })),
      )
      .sort((a, b) => b.e.score - a.e.score)[0];
    if (possible)
      return {
        meetingId: focusId,
        switchAttention: false,
        state: "POSSIBLE",
        eventId: possible.e.id,
        reason: `Possível necessidade de atenção em ${possible.m.title}: ${possible.e.reason}`,
        confidence: possible.e.confidence,
      };
    return {
      meetingId: focusId,
      switchAttention: false,
      state: "CALM",
      reason: "Tudo tranquilo. Você pode continuar focado.",
      confidence: 0.8,
    };
  }
}
export function alertChannel(e: AttentionEvent): AlertChannel {
  if (!isOpen(e) || e.level === "NONE") return "NONE";
  // Desktop delivery only when shouldNotify passed (score, confidence, cooldown).
  if (e.notifiedAt) return e.level === "URGENT" ? "URGENT" : "DESKTOP";
  return e.level === "LOW" ? "BADGE" : "DISCREET";
}
