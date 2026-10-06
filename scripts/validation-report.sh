#!/bin/bash
# Collects the numbers for docs/validacao-captura-real.md after a real-capture
# session. Prints counts and metrics only: no transcript text.
set -u
cd "$(dirname "$0")/.."
port_from_shell="${PORT:-}"
[ -f .env ] && { set -a; . ./.env; set +a; }
API="http://127.0.0.1:${port_from_shell:-${PORT:-4317}}/api"
AUTH="Authorization: Bearer ${ATTENTION_TOKEN:?defina ATTENTION_TOKEN no .env}"
get() { curl -fsS -H "$AUTH" "$API/$1"; }
get health >/dev/null 2>&1 || { echo "API indisponível em $API (rode npm start)"; exit 1; }
echo "== worker"
curl -fsS http://127.0.0.1:4318/health || echo "worker indisponível"
echo
echo "== reuniões (contagens)"
get state | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const st=JSON.parse(s);
  for (const m of st.meetings) {
    const speakers=new Set(m.transcript.map(x=>x.speakerId));
    const conf=m.transcript.map(x=>x.confidence);
    console.log(`${m.title} [${m.id.slice(0,8)}] trechos=${m.transcript.length} eventos=${m.events.length}`+
      ` score=${m.attentionScore} speakers=${[...speakers].join("/")||"-"}`+
      ` confiança=${conf.length?Math.min(...conf):"-"}`+
      ` tipos=${[...new Set(m.events.flatMap(e=>e.types))].join(",")||"-"}`);
  }
  console.log(`recomendação: ${st.recommendation.state ?? (st.recommendation.switchAttention?"SWITCH":"CALM")}`+
    ` confiança=${Math.round(st.recommendation.confidence*100)}% captura=${st.running && !st.demo ? "ativa" : "parada"}`);
})'
echo "== métricas"
get metrics | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const m=JSON.parse(s), f=(x)=>x.count?`p50=${x.p50}ms p95=${x.p95}ms max=${x.max}ms (n=${x.count})`:"sem amostras";
  console.log("transcrição (fim da fala → texto):", f(m.transcriptionLatency));
  console.log("detecção:", f(m.attentionDetectionLatency));
  console.log("notificação (fim da fala → alerta):", f(m.notificationLatency));
  console.log("eventos/min:", m.eventsPerMinute, "| chamadas IA:", m.aiCalls, "| falso positivo:", m.falsePositiveRate ?? "sem avaliações");
})'
