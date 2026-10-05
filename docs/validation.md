# Validação da primeira entrega

Executada neste ambiente Linux com Node.js 24.19.0 e Python 3.12.14.

## Executado e aprovado

- TypeScript da UI e API: `npm run check`.
- Build de produção NestJS + Vite: `npm run build`.
- 35 testes Vitest: dataset de atenção, contexto, negação, nomes/aliases,
  identidade, incerteza do STT, agrupamento, cooldown, escalada, lifecycle,
  isolamento, 3 reuniões, catch-up, resposta, AI fallback e WAV PCM.
- 5 testes Python: WAV 16 kHz, silêncio com Silero VAD real, Whisper não chamado
  para silêncio, taxa inválida, stereo e limite de duração.
- Integração HTTP/WebSocket: auth, origem, validação, demo automatizada 18/97,
  recomendação, contexto, catch-up, resposta, feedback, resolução, idempotência,
  STOP bloqueando segmento tardio e exclusão.
- Integração browser headless: login, demo, agrupamento, recomendação, catch-up,
  contexto, edição de resposta, feedback, resolução, configuração, mini modo,
  viewport de 390 px sem overflow horizontal e ausência de erros JavaScript.
- Screenshots inspecionados: `docs/screenshots/dashboard.png` e `mobile.png`.

## Reproduzir

```bash
npm ci
npm run check
npm test
npm run build
```

Com API executando e ATTENTION_TOKEN definido igual ao servidor:

```bash
npm run test:integration
npx playwright install chromium
node tests/integration/ui.mjs
```

Com requirements do worker instalados e ATTENTION_TOKEN definido:

```bash
python -m unittest discover -s tests/transcript -p '*_test.py'
```

Os testes de integração reiniciam a demo e modificam seu estado. Use uma sessão
de teste, não uma reunião em andamento. Browser de testes pode ser indicado por
`CHROMIUM_PATH`; TEST_URL altera a URL local. Sem essas variáveis, usa o Chromium
do Playwright e localhost:4317.

## Não validado neste ambiente

- Compilação Rust/Tauri e notificações nativas do Windows: Rust/WebView2 ausentes.
- Execução Docker Compose e adapters PostgreSQL/Redis/RabbitMQ: Docker ausente.
- Transcrição de fala real pelo Whisper; benchmark GPU/CPU; diarização.
- Captura simultânea de duas reuniões Meet/Teams reais em Chrome/Edge Windows.
- Loopback nativo do Windows, instalador e empacotamento do backend.
- Providers comerciais e métricas reais de uso/custo de LLM.

As limitações de ambiente não foram substituídas por resultados simulados.
Demo e testes por texto validam o motor, não certificam a captura real.

## Revalidação — 2026-10-05

Executada no WSL Ubuntu 24.04 com Node.js 24.21.0, após a revisão de código.

- 51 testes Vitest, incluindo: dispensa vs. bloqueio negado, dispensa por
  assunto, pesos por tipo, decaimento, broadcast só com mudança visível, estado
  🟡 POSSIBLE, canais de alerta por nível, `PcmBlocker` e fontes simuladas.
- Integração HTTP/WebSocket em modo memória, incluindo `urgentSound` e perfil
  com item nulo.
- Integração HTTP/WebSocket em modo infra contra PostgreSQL, Redis e RabbitMQ
  reais (Docker Compose), com restart e recarga do snapshot.
- Integração browser headless: além do anterior, recomendação 🔴 com "Ver
  contexto", badge de não vistos, destaque urgente, estado 🟡 com 61% de
  confiança e alternância do som em urgentes.

Ainda não validado: Tauri/Rust no Windows, captura real de duas reuniões,
worker Python (testes não executados nesta revalidação). O RabbitMQ do Compose
saiu com código 1 em algumas subidas com volume novo; investigar.
