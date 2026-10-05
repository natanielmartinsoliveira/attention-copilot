import React, { useState } from "react";
import {
  EVENT_TYPES,
  type Settings,
  type UserProfile,
} from "../../../packages/core/src/types";
import {
  TYPE_LABEL,
  type WeightSuggestion,
} from "../../../packages/core/src/learning";
type Ranked = { name: string; importance: number }[];
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const decimal = (n: number) => n.toFixed(2).replace(".", ",");
/** §9: everything in the profile editable without touching JSON. */
export function SettingsForm({
  profile,
  settings,
  suggestions,
  onSave,
  onApply,
}: {
  profile: UserProfile;
  settings: Settings;
  suggestions: WeightSuggestion[];
  onSave: (profile: UserProfile, settings: Settings) => Promise<void>;
  onApply: (types: string[]) => Promise<void>;
}) {
  const [p, setP] = useState(() => structuredClone(profile));
  const [s, setS] = useState(() => structuredClone(settings));
  const [text, setText] = useState({
    aliases: profile.aliases.join(", "),
    teams: profile.teams.join(", "),
    expertise: profile.expertise.join(", "),
  });
  const field = (label: string, key: "name" | "fullName" | "role") => (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={p[key]}
        maxLength={200}
        required
        onChange={(e) => setP({ ...p, [key]: e.target.value })}
      />
    </label>
  );
  const csv = (label: string, key: keyof typeof text) => (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        value={text[key]}
        placeholder="separe por vírgula"
        onChange={(e) => setText({ ...text, [key]: e.target.value })}
      />
    </label>
  );
  const ranked = (title: string, key: "projects" | "people", noun: string) => {
    const rows: Ranked = p[key];
    const set = (next: Ranked) => setP({ ...p, [key]: next });
    return (
      <fieldset>
        <legend>{title}</legend>
        {!rows.length && <p className="muted">Nenhum cadastrado.</p>}
        {rows.map((row, i) => (
          <div className="ranked-row" key={i}>
            <input
              aria-label={`${noun} ${i + 1}`}
              value={row.name}
              maxLength={200}
              onChange={(e) =>
                set(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
              }
            />
            <input
              aria-label={`Importância de ${noun.toLowerCase()} ${i + 1}`}
              type="number"
              min={0}
              max={100}
              value={row.importance}
              onChange={(e) =>
                set(
                  rows.map((r, j) =>
                    j === i ? { ...r, importance: Number(e.target.value) } : r,
                  ),
                )
              }
            />
            <button
              type="button"
              aria-label={`Remover ${noun.toLowerCase()} ${i + 1}`}
              onClick={() => set(rows.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => set([...rows, { name: "", importance: 50 }])}
        >
          Adicionar {noun.toLowerCase()}
        </button>
      </fieldset>
    );
  };
  const number = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (n: number) => void,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(
          {
            ...p,
            aliases: list(text.aliases),
            teams: list(text.teams),
            expertise: list(text.expertise),
            projects: p.projects.filter((x) => x.name.trim()),
            people: p.people.filter((x) => x.name.trim()),
          },
          s,
        );
      }}
    >
      {suggestions.length > 0 && (
        <fieldset className="suggestions">
          <legend>Sugestões a partir do seu feedback</legend>
          {suggestions.map((x) => (
            <div className="suggestion" key={x.type}>
              <span>
                <strong>{TYPE_LABEL[x.type] ?? x.type}</strong>:{" "}
                {decimal(x.current)} → {decimal(x.suggested)}
                <br />
                <small className="muted">{x.reason}</small>
              </span>
              <button type="button" onClick={() => void onApply([x.type])}>
                Aplicar
              </button>
            </div>
          ))}
          {suggestions.length > 1 && (
            <button
              type="button"
              onClick={() => void onApply(suggestions.map((x) => x.type))}
            >
              Aplicar todas
            </button>
          )}
        </fieldset>
      )}
      <fieldset>
        <legend>Você</legend>
        {field("Nome", "name")}
        {field("Nome completo", "fullName")}
        {csv("Apelidos", "aliases")}
        {field("Cargo", "role")}
        {csv("Times", "teams")}
        {csv("Experiência", "expertise")}
      </fieldset>
      {ranked("Projetos (importância 0–100)", "projects", "Projeto")}
      {ranked("Pessoas importantes (0–100)", "people", "Pessoa")}
      <fieldset>
        <legend>Limites</legend>
        {number("Diferença mínima para sugerir troca", s.minAttentionDelta, 1, 100, (n) =>
          setS({ ...s, minAttentionDelta: n }),
        )}
        {number("Intervalo entre notificações (s)", Math.round(s.cooldownMs / 1000), 1, 600, (n) =>
          setS({ ...s, cooldownMs: n * 1000 }),
        )}
        {number("Retenção da transcrição (horas)", s.retentionHours, 1, 720, (n) =>
          setS({ ...s, retentionHours: n }),
        )}
      </fieldset>
      <details>
        <summary>Pesos por tipo de evento (0–2)</summary>
        <div className="weights">
          {EVENT_TYPES.filter((t) => t !== "NONE").map((t) => (
            <label className="field" key={t}>
              <span>{TYPE_LABEL[t] ?? t}</span>
              <input
                aria-label={`Peso ${TYPE_LABEL[t] ?? t}`}
                type="number"
                min={0}
                max={2}
                step={0.05}
                value={s.weights[t]}
                onChange={(e) =>
                  setS({ ...s, weights: { ...s.weights, [t]: Number(e.target.value) } })
                }
              />
            </label>
          ))}
        </div>
      </details>
      <button className="primary">Salvar</button>
    </form>
  );
}
