import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import type {
  ActionItem,
  ActionItemStatus,
  AppState,
  AttentionEvent,
  EventStatus,
  Meeting,
  TimelineEntry,
} from "../../../packages/core/src/types";
import { alertChannel, isOpen } from "../../../packages/core/src/engine";
import { BrowserTabAudioSource } from "./capture";
import {
  enableNotifications,
  miniWindow,
  notify,
  playSoftTone,
} from "./notify";
import "./style.css";
const backend = "__TAURI_INTERNALS__" in window ? "http://127.0.0.1:4317" : "";
const time = (n: number) =>
  new Date(n).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const EVENT_STATUS: Record<EventStatus, string> = {
  DETECTED: "detectada",
  NOTIFIED: "notificada",
  SEEN: "vista",
  ACKNOWLEDGED: "ciente",
  RESPONDED: "respondida",
  DISMISSED: "ignorada",
  EXPIRED: "expirada",
};
const TASK_STATUS: Record<ActionItemStatus, string> = {
  PROPOSED: "proposta",
  CONFIRMED: "confirmada",
  DISMISSED: "ignorada",
};
function Bullets({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? (
    <ul>
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  ) : (
    <p className="muted">{empty}</p>
  );
}
function Action({ text }: { text: string | null }) {
  return text ? (
    <p className="action">
      <strong>AÇÃO:</strong> {text}
    </p>
  ) : null;
}
function RawLines({ lines, label }: { lines: string[]; label: string }) {
  return lines.length ? (
    <details>
      <summary>
        {label} ({lines.length})
      </summary>
      <ul>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </details>
  ) : null;
}
function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="timeline">
      {entries.map((e, i) => (
        <li key={i} className={`tl-${e.kind.toLowerCase()}`}>
          <time>{time(e.at)}</time>
          <span>{e.text}</span>
        </li>
      ))}
    </ol>
  );
}
function App() {
  const [token, setToken] = useState(
      sessionStorage.getItem("attention-token") || "",
    ),
    [draft, setDraft] = useState(""),
    [state, setState] = useState<AppState | null>(null),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false),
    [compact, setCompact] = useState(false),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState(false),
    [modal, setModal] = useState<{
      title: string;
      data: any;
      kind?: string;
      id?: string;
    } | null>(null),
    [config, setConfig] = useState(""),
    [notifs, setNotifs] = useState(false),
    [audioIds, setAudioIds] = useState<string[]>([]),
    [toast, setToast] = useState<{ id: string; text: string } | null>(null),
    [editing, setEditing] = useState<{ id: string; text: string } | null>(
      null,
    ),
    [aiStatus, setAiStatus] = useState<{
      configured: boolean;
      providers: { cheap: string[]; strong: string[] };
      calls: number;
      cost: number;
    } | null>(null);
  const socket = useRef<Socket | null>(null),
    notified = useRef(new Set<string>()),
    sources = useRef(new Map<string, BrowserTabAudioSource>()),
    notifEnabled = useRef(false);
  async function api(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) {
    const r = await fetch(`${backend}/api/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw Error(j.error ?? "Falha na solicitação");
    return j;
  }
  async function action(f: () => Promise<unknown>) {
    setError("");
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha");
    }
  }
  useEffect(() => {
    if (!token) return;
    let active = true;
    void api("state")
      .then((data) => {
        if (active) setState(data);
      })
      .catch((e) => setError(e.message));
    const s = io(backend || window.location.origin, {
      auth: { token },
      transports: ["websocket"],
    });
    socket.current = s;
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => {
      setConnected(false);
      for (const source of sources.current.values()) void source.stop();
      sources.current.clear();
      setAudioIds([]);
    });
    s.on("connect_error", () => {
      setConnected(false);
      setError("Sem conexão autenticada com o serviço local.");
    });
    s.on("state", (data: AppState) => {
      setState(data);
      // §17: BADGE is only counted in the header; DISCREET shows an in-app
      // toast once per event; DESKTOP/URGENT once per engine notification.
      for (const m of data.meetings)
        for (const e of m.events) {
          const channel = alertChannel(e);
          if (channel === "DISCREET") {
            const key = e.id + ":discreet";
            if (notified.current.has(key)) continue;
            notified.current.add(key);
            setToast({ id: e.id, text: `${m.title} · ${e.reason}` });
            continue;
          }
          if (channel !== "DESKTOP" && channel !== "URGENT") continue;
          const key = e.id + ":" + e.notifiedAt;
          if (notified.current.has(key)) continue;
          notified.current.add(key);
          if (notifEnabled.current)
            void notify(
              `${channel === "URGENT" ? "🔴 " : ""}Attention Copilot · ${m.platform}`,
              `${e.reason}\n“${e.quote}”`,
            ).catch(() => {});
          if (channel === "URGENT" && data.settings.urgentSound)
            void playSoftTone().catch(() => {});
        }
    });
    return () => {
      active = false;
      s.disconnect();
    };
  }, [token]);
  useEffect(
    () => () => {
      for (const source of sources.current.values()) void source.stop();
    },
    [],
  );
  const externalAI = !!state?.settings.externalAI;
  useEffect(() => {
    if (!token || !state) return;
    const load = () =>
      void api("ai/usage")
        .then(setAiStatus)
        .catch(() => {});
    load();
    if (!externalAI) return;
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [token, !!state, externalAI]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  const stopAudio = async () => {
    await Promise.all([...sources.current.values()].map((s) => s.stop()));
    sources.current.clear();
    setAudioIds([]);
  };
  const stop = () =>
    action(async () => {
      await stopAudio();
      await api("stop", {});
    });
  const context = (e: AttentionEvent) =>
    action(async () => {
      setModal({
        title: "Contexto do evento",
        data: await api(`events/${e.id}/context`),
        kind: "context",
        id: e.id,
      });
      if (isOpen(e)) await api(`events/${e.id}/status`, { status: "SEEN" });
    });
  const response = (e: AttentionEvent) =>
    action(async () =>
      setModal({
        title: "Sugestões de resposta",
        data: await api(`events/${e.id}/response`, {}),
        kind: "response",
        id: e.id,
      }),
    );
  const catchup = (m: Meeting, ultra = false) =>
    action(async () =>
      setModal({
        title: ultra
          ? "O que preciso saber?"
          : `O que você perdeu · ${m.title}`,
        data: await api(`meetings/${m.id}/catch-up`, { ultra }),
        kind: ultra ? "essentials" : "catchup",
      }),
    );
  const showSummary = (m: Meeting, data?: unknown) =>
    action(async () =>
      setModal({
        title: `Resumo · ${m.title}`,
        data: data ?? (await api(`meetings/${m.id}/summary`)),
        kind: "summary",
        id: m.id,
      }),
    );
  const showTimeline = (m: Meeting) =>
    action(async () =>
      setModal({
        title: `Linha do tempo · ${m.title}`,
        data: await api(`meetings/${m.id}/timeline`),
        kind: "timeline",
      }),
    );
  const updateTask = (meetingId: string, taskId: string, patch: object) =>
    action(async () => {
      await api(`meetings/${meetingId}/tasks/${taskId}`, patch);
      setEditing(null);
      const data = await api(`meetings/${meetingId}/summary`);
      setModal((current) => (current ? { ...current, data } : current));
    });
  const capture = (m: Meeting) =>
    action(async () => {
      if (state?.demo && state.running)
        throw Error("Pare a demo antes de iniciar áudio real.");
      if (sources.current.has(m.id)) {
        await sources.current.get(m.id)!.stop();
        sources.current.delete(m.id);
        setAudioIds([...sources.current.keys()]);
        return;
      }
      const source = new BrowserTabAudioSource(
        m.id,
        token,
        async (text, startTime, endTime) => {
          await api("transcript", {
            id: crypto.randomUUID(),
            meetingId: m.id,
            speakerId: "Voz não identificada",
            text,
            startTime,
            endTime,
            confidence: 0.65,
          });
        },
        (message) => {
          setError(message);
          if (message === "A captura da aba foi encerrada.") {
            sources.current.delete(m.id);
            setAudioIds([...sources.current.keys()]);
            if (sources.current.size === 0)
              void api("stop", {}).catch(() => {});
          }
        },
      );
      try {
        await source.start();
        await api("capture/start", {});
        sources.current.set(m.id, source);
        setAudioIds([...sources.current.keys()]);
      } catch (e) {
        await source.stop();
        throw e;
      }
    });
  const logout = () =>
    action(async () => {
      await stopAudio();
      await api("stop", {});
      sessionStorage.removeItem("attention-token");
      setToken("");
      setState(null);
    });
  if (!token || !state)
    return (
      <div className="login">
        <span className="eyebrow">ATTENTION COPILOT / LOCAL</span>
        <h1>
          Uma reunião por vez.
          <br />
          Duas no radar.
        </h1>
        <p>
          Abra o serviço local e copie o código de acesso mostrado no terminal.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sessionStorage.setItem("attention-token", draft);
            setToken(draft);
            setError("");
          }}
        >
          <input
            aria-label="Código de acesso"
            placeholder="Código de acesso local"
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            required
          />
          <button>Entrar</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    );
  const events = state.meetings
    .flatMap((m) => m.events.map((e) => ({ ...e, title: m.title })))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const recommendation = state.recommendation,
    // Snapshots saved before `state` existed only carry switchAttention.
    mode =
      recommendation.state ??
      (recommendation.switchAttention ? "SWITCH" : "CALM"),
    target = state.meetings.find((m) => m.id === recommendation.meetingId),
    recommendedEvent = events.find((e) => e.id === recommendation.eventId),
    unseen = events.filter(
      (e) =>
        alertChannel(e) !== "NONE" &&
        (e.status === "DETECTED" || e.status === "NOTIFIED"),
    ).length;
  return (
    <div className={compact ? "app compact" : "app"}>
      <header>
        <div>
          <span className="logo">◎</span>
          <strong>Attention Copilot</strong>
          <span className="version">LOCAL · v0.1</span>
        </div>
        <nav>
          {unseen > 0 && (
            <span
              className="badge"
              aria-label={`${unseen} eventos não vistos`}
              title="Eventos ainda não vistos"
            >
              {unseen}
            </span>
          )}
          <span className={connected ? "connection" : "error"}>
            {connected ? "● Conectado" : "● Desconectado"}
          </span>
          <button
            onClick={() =>
              action(async () => {
                await miniWindow(!compact);
                setCompact(!compact);
              })
            }
          >
            {compact ? "Expandir" : "Mini modo"}
          </button>
          {!compact && <button onClick={logout}>Sair</button>}
        </nav>
      </header>
      {!compact && (
        <section className="intro">
          <div>
            <span className="eyebrow">SEU RADAR DE ATENÇÃO</span>
            <h1>Foco onde você faz diferença.</h1>
            <p>Acompanhe o contexto. Interrompa apenas quando necessário.</p>
          </div>
          <div className="capture-state">
            <span className={state.running ? "live" : "muted"}>
              ●{" "}
              {state.running
                ? state.demo
                  ? "DEMO ATIVA · SEM CAPTURA"
                  : "CAPTURA ATIVA"
                : "CAPTURA PARADA"}
            </span>
            <button className="stop" onClick={stop}>
              ■ Parar tudo
            </button>
          </div>
        </section>
      )}
      {error && (
        <div role="alert" className="error-banner">
          {error}
          <button onClick={() => setError("")}>Fechar</button>
        </div>
      )}
      <section
        className={
          mode === "SWITCH"
            ? "recommendation urgent"
            : mode === "POSSIBLE"
              ? "recommendation possible"
              : "recommendation"
        }
        role="status"
      >
        <span className="radar" aria-hidden="true">
          {mode === "SWITCH" ? "!" : mode === "POSSIBLE" ? "?" : "✓"}
        </span>
        <div>
          <span className="eyebrow">RECOMENDAÇÃO ATUAL</span>
          <h2>
            {mode === "SWITCH"
              ? `Mude sua atenção para ${target?.title}`
              : mode === "POSSIBLE"
                ? "Possível pergunta ou pedido para você."
                : "Tudo tranquilo. Você pode continuar focado."}
          </h2>
          {mode !== "CALM" && <p>{recommendation.reason}</p>}
          {mode !== "CALM" && (
            <span className="muted">
              Confiança estimada: {Math.round(recommendation.confidence * 100)}%
            </span>
          )}
        </div>
        {mode !== "CALM" && recommendedEvent && (
          <button onClick={() => context(recommendedEvent)}>
            Ver contexto
          </button>
        )}
        {mode === "SWITCH" && target && (
          <button onClick={() => action(() => api("focus", { id: target.id }))}>
            Marcar foco aqui
          </button>
        )}
      </section>
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          <button
            onClick={() => {
              const e = events.find((x) => x.id === toast.id);
              setToast(null);
              if (e) void context(e);
            }}
          >
            Ver
          </button>
          <button aria-label="Fechar aviso" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      {!compact && (
        <div className="toolbar">
          <div>
            <button
              className="primary"
              disabled={audioIds.length > 0}
              onClick={() =>
                action(async () => {
                  notified.current.clear();
                  await api("demo/start", {});
                })
              }
            >
              ▶ Iniciar demo
            </button>
            <button
              onClick={() =>
                action(async () => {
                  await stopAudio();
                  await api("reset", {});
                  notified.current.clear();
                })
              }
            >
              Reiniciar
            </button>
            <button
              className={state.focusMode === "AUTO" ? "selected" : ""}
              onClick={() => action(() => api("focus", { id: null }))}
            >
              Foco automático
            </button>
          </div>
          <div>
            <button
              onClick={() =>
                action(async () => {
                  const ok = await enableNotifications();
                  notifEnabled.current = ok;
                  setNotifs(ok);
                  if (!ok)
                    throw Error("Permissão de notificação não concedida.");
                })
              }
            >
              {notifs ? "✓ Alertas desktop" : "Ativar alertas desktop"}
            </button>
            <button
              aria-pressed={!!state.settings.urgentSound}
              onClick={() =>
                action(async () => {
                  const urgentSound = !state.settings.urgentSound;
                  await api("settings", { ...state.settings, urgentSound });
                  if (urgentSound) await playSoftTone();
                })
              }
            >
              {state.settings.urgentSound
                ? "✓ Som suave em urgentes"
                : "Som em urgentes"}
            </button>
            <button
              aria-pressed={externalAI}
              disabled={!aiStatus?.configured}
              title={
                aiStatus?.configured
                  ? "Refina eventos incertos, rascunhos e resumos com IA externa"
                  : "Nenhuma chave de IA configurada no .env"
              }
              onClick={() =>
                action(async () => {
                  const turnOn = !externalAI;
                  if (
                    turnOn &&
                    !window.confirm(
                      "Ligar IA externa envia trechos da transcrição (e seu perfil) para os providers configurados: " +
                        [...(aiStatus?.providers.cheap ?? []), ...(aiStatus?.providers.strong ?? [])].join(", ") +
                        ". Confirme que isso é permitido pelas políticas da sua organização.",
                    )
                  )
                    return;
                  await api("settings", { ...state.settings, externalAI: turnOn });
                  setAiStatus(await api("ai/usage"));
                })
              }
            >
              {externalAI ? "✓ IA externa" : "IA externa"}
            </button>
            <button
              onClick={() => {
                setConfig(
                  JSON.stringify(
                    { profile: state.profile, settings: state.settings },
                    null,
                    2,
                  ),
                );
                setModal({
                  title: "Perfil e preferências",
                  data: null,
                  kind: "settings",
                });
              }}
            >
              Configurar
            </button>
          </div>
        </div>
      )}
      <div className="meetings">
        {state.meetings.map((m, i) => {
          const highlighted = new Set(
            m.events.filter((e) => e.score > 40).flatMap((e) => e.segmentIds),
          );
          const entries = m.transcript.filter(
            (s) =>
              s.text.toLowerCase().includes(query.toLowerCase()) &&
              (!filter || highlighted.has(s.id)),
          );
          return (
            <article
              key={m.id}
              className={`meeting ${m.attentionScore > 80 ? "danger" : ""} ${state.focusId === m.id ? "focused" : ""}`}
              onPointerDown={() => {
                if (state.focusMode === "AUTO")
                  void action(() => api("interaction", { id: m.id }));
              }}
            >
              <div className="meeting-head">
                <div>
                  <span className="eyebrow">
                    REUNIÃO {i + 1} · {m.platform}
                  </span>
                  <h2>{m.title}</h2>
                </div>
                <span className="status">
                  {state.focusId === m.id
                    ? "SEU FOCO"
                    : m.status === "ENDED"
                      ? "FINALIZADA"
                      : "NO RADAR"}
                </span>
              </div>
              <div className="score">
                <strong>{m.attentionScore}</strong>
                <span>
                  /100
                  <br />
                  {m.attentionScore > 80
                    ? "URGENTE"
                    : m.attentionScore > 60
                      ? "ATENÇÃO NECESSÁRIA"
                      : m.attentionScore > 40
                        ? "POSSÍVEL RELEVÂNCIA"
                        : m.attentionScore > 20
                          ? "BAIXA PRIORIDADE"
                          : "TUDO TRANQUILO"}
                </span>
              </div>
              <div className="meter">
                <span style={{ width: m.attentionScore + "%" }} />
              </div>
              {!compact && (
                <>
                  <div className="card-actions">
                    <button
                      disabled={m.status !== "ACTIVE"}
                      onClick={() => action(() => api("focus", { id: m.id }))}
                    >
                      Focar
                    </button>
                    <button onClick={() => catchup(m)}>Catch me up</button>
                    <button onClick={() => catchup(m, true)}>Essencial</button>
                    <button onClick={() => showTimeline(m)}>
                      Linha do tempo
                    </button>
                    {m.status === "ENDED" && (
                      <button onClick={() => showSummary(m)}>Ver resumo</button>
                    )}
                  </div>
                  <div className="transcript-head">
                    <span>TRANSCRIÇÃO {state.demo ? "SIMULADA" : "LOCAL"}</span>
                    <span>{m.transcript.length} trechos</span>
                  </div>
                  <div className="transcript">
                    {!entries.length ? (
                      <p className="empty">
                        Aguardando conversa. Inicie a demo ou selecione uma aba
                        com áudio.
                      </p>
                    ) : (
                      entries.map((s) => (
                        <div
                          className={
                            highlighted.has(s.id)
                              ? "segment relevant"
                              : "segment"
                          }
                          key={s.id}
                        >
                          <div>
                            <strong>{s.speakerId}</strong>
                            <time>{time(s.endTime)}</time>
                          </div>
                          <p>{s.text}</p>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="bottom-actions">
                    <button
                      disabled={m.status !== "ACTIVE"}
                      onClick={() => capture(m)}
                    >
                      {audioIds.includes(m.id)
                        ? "■ Parar aba"
                        : "Selecionar aba com áudio"}
                    </button>
                    <button
                      onClick={() =>
                        action(async () => {
                          if (sources.current.has(m.id)) {
                            await sources.current.get(m.id)!.stop();
                            sources.current.delete(m.id);
                            setAudioIds([...sources.current.keys()]);
                          }
                          await showSummary(
                            m,
                            await api(`meetings/${m.id}/end`, {}),
                          );
                        })
                      }
                    >
                      Finalizar
                    </button>
                    <button
                      onClick={() =>
                        action(() => api(`meetings/${m.id}/clear`, {}))
                      }
                    >
                      Excluir transcrição
                    </button>
                    <button
                      onClick={() =>
                        action(async () => {
                          if (sources.current.has(m.id)) {
                            await sources.current.get(m.id)!.stop();
                            sources.current.delete(m.id);
                            setAudioIds([...sources.current.keys()]);
                          }
                          await api(`meetings/${m.id}`, undefined, "DELETE");
                        })
                      }
                    >
                      Excluir reunião
                    </button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>
      {compact ? (
        <button className="stop" onClick={stop}>
          ■ Parar tudo
        </button>
      ) : (
        <>
          <section className="search-row">
            <input
              aria-label="Buscar na transcrição"
              placeholder="Buscar na transcrição…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label>
              <input
                type="checkbox"
                checked={filter}
                onChange={(e) => setFilter(e.target.checked)}
              />{" "}
              Só trechos relevantes
            </label>
          </section>
          <section className="notification-center">
            <div className="section-head">
              <h2>Central de atenção</h2>
              <span className="muted">
                {events.filter(isOpen).length} eventos abertos · som em urgentes{" "}
                {state.settings.urgentSound ? "ligado" : "desligado"}
              </span>
            </div>
            {!events.length ? (
              <p className="empty">
                Tudo tranquilo. Os eventos aparecerão aqui quando a conversa
                precisar de você.
              </p>
            ) : (
              events.map((e) => (
                <div
                  className={`event ${!isOpen(e) ? "resolved" : ""} ${alertChannel(e) === "URGENT" ? "urgent-event" : ""}`}
                  key={e.id}
                >
                  <div className="event-score">{e.score}</div>
                  <div className="event-body">
                    <span className="eyebrow">
                      {e.title} · {time(e.updatedAt)} · {e.status}
                    </span>
                    <h3>{e.reason}</h3>
                    <p>“{e.quote}”</p>
                    <small>
                      {e.repeats} trechos relacionados ·{" "}
                      {Math.round(e.confidence * 100)}% de confiança estimada
                      {e.ai &&
                        ` · refinado por IA (${e.ai.provider}); regras locais davam ${e.ai.original.score}`}
                    </small>
                    <div className="event-actions">
                      <button onClick={() => context(e)}>Ver contexto</button>
                      <button
                        disabled={!isOpen(e) || !e.requiresResponse}
                        onClick={() => response(e)}
                      >
                        Gerar resposta
                      </button>
                      {isOpen(e) && (
                        <>
                          <button
                            onClick={() =>
                              action(() =>
                                api(`events/${e.id}/status`, {
                                  status: "ACKNOWLEDGED",
                                }),
                              )
                            }
                          >
                            Ciente
                          </button>
                          <button
                            onClick={() =>
                              action(() =>
                                api(`events/${e.id}/status`, {
                                  status: "RESPONDED",
                                }),
                              )
                            }
                          >
                            Respondido
                          </button>
                          <button
                            onClick={() =>
                              action(() =>
                                api(`events/${e.id}/status`, {
                                  status: "DISMISSED",
                                }),
                              )
                            }
                          >
                            Ignorar
                          </button>
                        </>
                      )}
                      <select
                        aria-label="Avaliar alerta"
                        value={e.feedback?.rating || ""}
                        onChange={(ev) =>
                          action(() =>
                            api(`events/${e.id}/feedback`, {
                              rating: ev.target.value,
                            }),
                          )
                        }
                      >
                        <option value="" disabled>
                          Avaliar alerta
                        </option>
                        <option value="useful">Útil</option>
                        <option value="unimportant">Não era importante</option>
                        <option value="false-positive">Falso positivo</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))
            )}
          </section>
          <footer>
            {state.settings.externalAI && aiStatus?.configured ? (
              <>
                IA externa ligada · barato:{" "}
                {aiStatus.providers.cheap.join(" → ") || "nenhum"} · forte:{" "}
                {aiStatus.providers.strong.join(" → ") || "nenhum"} ·{" "}
                {count(aiStatus.calls, "chamada", "chamadas")}
                {aiStatus.cost > 0 &&
                  ` · US$ ${aiStatus.cost.toFixed(4)} (custo conhecido)`}
              </>
            ) : (
              "Processamento local por regras contextuais"
            )}{" "}
            · sem envio automático de respostas · sem armazenamento de áudio
          </footer>
        </>
      )}
      {modal && (
        <div className="overlay" onClick={() => setModal(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={modal.title}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-head">
              <h2>{modal.title}</h2>
              <button onClick={() => setModal(null)}>Fechar</button>
            </div>
            {modal.kind === "settings" ? (
              <>
                <p>
                  Edite nome, apelidos, experiência, projetos, pessoas, pesos e
                  limites. Importância: 0–100; pesos: 0–2.
                </p>
                <textarea
                  aria-label="Configuração do perfil"
                  className="config"
                  value={config}
                  onChange={(e) => setConfig(e.target.value)}
                />
                <button
                  className="primary"
                  onClick={() =>
                    action(async () => {
                      const c = JSON.parse(config);
                      await api("profile", c.profile);
                      await api("settings", c.settings);
                      setModal(null);
                    })
                  }
                >
                  Salvar
                </button>
              </>
            ) : modal.kind === "response" ? (
              <>
                <p>{modal.data.reason}</p>
                <p className="muted">
                  Origem:{" "}
                  {modal.data.source === "local"
                    ? "rascunhos locais conservadores"
                    : modal.data.source}
                  . Revise antes de copiar; nada é enviado automaticamente.
                </p>
                {modal.data.safe &&
                  [
                    ["Curta", "short"],
                    ["Profissional", "professional"],
                    ["Detalhada", "detailed"],
                  ].map(([label, key]) => (
                    <div key={key}>
                      <h3>{label}</h3>
                      <textarea
                        aria-label={`Resposta ${label}`}
                        value={modal.data[key]}
                        onChange={(ev) =>
                          setModal({
                            ...modal,
                            data: { ...modal.data, [key]: ev.target.value },
                          })
                        }
                      />
                      <button
                        onClick={() =>
                          action(() =>
                            navigator.clipboard.writeText(modal.data[key]),
                          )
                        }
                      >
                        Copiar
                      </button>
                    </div>
                  ))}
                <p className="muted">
                  Copiar não marca o evento como respondido. Nenhuma mensagem é
                  enviada.
                </p>
              </>
            ) : modal.kind === "context" ? (
              <>
                <p>{modal.data.event.reason}</p>
                <p>
                  Tipos: {modal.data.event.types.join(", ")} · Resposta
                  necessária:{" "}
                  {modal.data.event.requiresResponse ? "sim" : "não"}
                </p>
                {modal.data.segments.map((s: any) => (
                  <div className="segment" key={s.id}>
                    <strong>
                      {time(s.endTime)} · {s.speakerId}
                    </strong>
                    <p>{s.text}</p>
                  </div>
                ))}
              </>
            ) : modal.kind === "catchup" ? (
              <>
                <p className="lead">Você perdeu {modal.data.missedLabel}.</p>
                <h3>Resumo</h3>
                <Bullets
                  items={modal.data.summary}
                  empty="Nada relevante para você neste período."
                />
                {modal.data.pending.length > 0 && (
                  <>
                    <h3>⚠️ Agora</h3>
                    {modal.data.pending.map((p: any) => (
                      <p key={p.eventId}>
                        {p.reason}
                        <br />
                        Pergunta: “{p.question}”
                      </p>
                    ))}
                  </>
                )}
                <Action text={modal.data.action} />
                <RawLines lines={modal.data.lines} label="Todas as falas do período" />
                <p className="muted">
                  Extrato local: só frases ditas na reunião, nada inventado.
                </p>
              </>
            ) : modal.kind === "essentials" ? (
              <>
                <p className="lead">
                  {modal.data.summary.length === 0
                    ? "Nada importante aconteceu enquanto você estava fora."
                    : modal.data.summary.length === 1
                      ? "1 coisa importante aconteceu:"
                      : `${modal.data.summary.length} coisas importantes aconteceram:`}
                </p>
                <ol>
                  {modal.data.summary.map((t: string, i: number) => (
                    <li key={i}>{t}</li>
                  ))}
                </ol>
                <Action text={modal.data.action} />
                <p className="muted">Período fora do foco: {modal.data.missedLabel}.</p>
              </>
            ) : modal.kind === "timeline" ? (
              <Timeline entries={modal.data} />
            ) : (
              <>
                <h3>Resumo</h3>
                <Bullets
                  items={modal.data.summary}
                  empty="Nenhum ponto relevante identificado."
                />
                <h3>Decisões</h3>
                <Bullets
                  items={modal.data.decisions.map(
                    (d: any) => `${d.speaker}: “${d.text}”`,
                  )}
                  empty="Nenhuma decisão explícita."
                />
                <h3>Tarefas</h3>
                {!modal.data.tasks.length && (
                  <p className="muted">Nenhuma tarefa identificada.</p>
                )}
                {modal.data.tasks.map((t: ActionItem) => (
                  <div className={`task ${t.status.toLowerCase()}`} key={t.id}>
                    {editing?.id === t.id ? (
                      <input
                        aria-label="Texto da tarefa"
                        value={editing.text}
                        maxLength={300}
                        onChange={(e) =>
                          setEditing({ id: t.id, text: e.target.value })
                        }
                      />
                    ) : (
                      <strong>{t.text}</strong>
                    )}
                    <small>
                      Responsável: {t.owner} · Prazo:{" "}
                      {t.deadline ?? "não mencionado"} · Confiança:{" "}
                      {Math.round(t.confidence * 100)}% ·{" "}
                      {TASK_STATUS[t.status]}
                    </small>
                    <div className="event-actions">
                      {editing?.id === t.id ? (
                        <button
                          className="primary"
                          onClick={() =>
                            updateTask(modal.id!, t.id, { text: editing.text })
                          }
                        >
                          Salvar
                        </button>
                      ) : (
                        <>
                          <button
                            disabled={t.status === "CONFIRMED"}
                            onClick={() =>
                              updateTask(modal.id!, t.id, {
                                status: "CONFIRMED",
                              })
                            }
                          >
                            Confirmar
                          </button>
                          <button
                            onClick={() =>
                              setEditing({ id: t.id, text: t.text })
                            }
                          >
                            Editar
                          </button>
                          <button
                            disabled={t.status === "DISMISSED"}
                            onClick={() =>
                              updateTask(modal.id!, t.id, {
                                status: "DISMISSED",
                              })
                            }
                          >
                            Ignorar
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
                <h3>Perguntas</h3>
                <Bullets
                  items={modal.data.questions.map(
                    (q: any) =>
                      `${q.speaker ?? "?"}: “${q.question}” · ${EVENT_STATUS[q.status as EventStatus]}`,
                  )}
                  empty="Nenhuma pergunta para você."
                />
                {state.settings.externalAI && aiStatus?.configured && (
                  <>
                    <h3>Rascunho da IA</h3>
                    {modal.data.ai ? (
                      <>
                        <p className="muted">
                          Gerado por {modal.data.ai.source}. Revise: pode conter
                          erros.
                        </p>
                        <Bullets items={modal.data.ai.summary} empty="Sem tópicos." />
                        <Bullets
                          items={modal.data.ai.tasks.map(
                            (t: any) =>
                              `Tarefa: ${t.text} · ${t.owner}${t.deadline ? ` · ${t.deadline}` : ""}`,
                          )}
                          empty="Nenhuma tarefa sugerida pela IA."
                        />
                      </>
                    ) : (
                      <button
                        onClick={() =>
                          action(async () => {
                            const result = await api(
                              `meetings/${modal.id}/ai-summary`,
                              {},
                            );
                            setModal((current) =>
                              current
                                ? { ...current, data: { ...current.data, ai: result } }
                                : current,
                            );
                          })
                        }
                      >
                        Gerar resumo com IA
                      </button>
                    )}
                  </>
                )}
                <h3>Possíveis follow-ups</h3>
                <Bullets items={modal.data.followUps} empty="Nenhum." />
                <p className="muted">
                  {count(modal.data.missed.length, "item relevante não aberto", "itens relevantes não abertos")}{" "}
                  · {count(modal.data.attentionItems.length, "exigiu atenção", "exigiram atenção")}{" "}
                  · {count(modal.data.ignored.length, "ignorado", "ignorados")}
                </p>
                <h3>Linha do tempo</h3>
                <Timeline entries={modal.data.timeline} />
                <RawLines lines={modal.data.transcript} label="Transcrição completa" />
                <p className="muted">
                  Extrato local. Nenhuma tarefa é criada fora do aplicativo.
                </p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
