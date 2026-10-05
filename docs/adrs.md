# Registros de decisões — 2026-10-04

## ADR 001 — Tauri 2 + React; áudio fora do shell nesta fase

**Decisão:** manter Tauri, React e TypeScript. Shell usa plugin oficial de
notificação e APIs de janela para mini modo. Backend NestJS local separado.
**Alternativa:** Electron oferece desktopCapturer e loopback, mas isso não resolve
por si só separação de duas reuniões ou duas abas. Não há evidência de vantagem
significativa para o requisito central que justifique mudar o desktop agora.
**Consequência:** menor superfície desktop; captura browser explicitamente
separada. Empacotamento do backend e lifecycle do sidecar são fases posteriores.
Tauri build/dev deve ser iniciado em `apps/desktop`.
Referências: https://v2.tauri.app/start/prerequisites/ ;
https://v2.tauri.app/plugin/notification/ ;
https://www.electronjs.org/docs/latest/api/desktop-capturer .

## ADR 002 — Separação de streams antes de transcrever

**Decisão:** o caminho experimental usa getDisplayMedia no Chrome/Edge, uma
seleção de aba por stream, consentimento explícito e validação de áudio presente.
Não assume que extensão/browser acessa aplicações arbitrárias. Não utiliza
API Meet/Teams inventada.
**Próximo caminho Windows:** WASAPI application loopback com process tree próprio,
baseado no sample Microsoft, requer build 20348+. Browser pode concentrar áudio
de múltiplas abas em processo comum, portanto PID não representa uma reunião.
O desktop Teams requer validação no hardware e versão reais antes de declarar
suporte. Alternativa para MVP: Meet e Teams web em abas selecionadas.
**Consequência:** uso browser real pode funcionar, mas não certifica desktop
Teams. Nenhum áudio misturado será rotulado como streams independentes.
Referências: https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/ ;
https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture ;
https://developer.chrome.com/docs/extensions/reference/api/tabCapture .

## ADR 003 — Motor local primeiro

**Decisão:** detector determinístico contextual como baseline; sem dependência
paga. Preservar contrato AIProvider e AIRouter opcional. Detecção local considera
histórico próximo, responsabilidades e tempo; não se limita à ocorrência do nome.
**Consequência:** barato, rápido, testável, mas limitado linguisticamente.
Exemplos ambíguos exigem revisão; confiança heurística é rotulada como estimada.
Adapters de providers externos aguardam testes de schema, custo e privacidade.

## ADR 004 — Infraestrutura opt-in

**Decisão:** memória por padrão; infra persistente é explícita. Compose traz
PostgreSQL, Redis e RabbitMQ com portas loopback. Banco é fonte de persistência;
cache não é fonte de verdade. Sete filas/DLQs declaradas; apenas transcript tem
pipeline ativo agora. IDs de segmento são idempotentes; confirmações precedem ACK.
**Consequência:** demo fácil de executar e testar. Modo distribuído não é certificado
nesta entrega; outbox transacional, backoff e workers especializados virão depois.
Referências: https://docs.nestjs.com/websockets/gateways ;
https://www.rabbitmq.com/tutorials/tutorial-two-javascript ;
https://www.postgresql.org/docs/current/sql-createtable.html ;
https://redis.io/docs/latest/develop/clients/nodejs/ .

## ADR 005 — Catch-up extrativo e respostas conservadoras

**Decisão:** resumo do período perdido usa trechos com origem verificável.
Ultra catch-up reduz a eventos relevantes. Resposta usa rascunho de reconhecimento
e esclarecimento, sem assumir disponibilidade, aprovação ou fatos externos.
**Consequência:** confiável sem LLM, porém menos natural que resumo abstrativo.
O usuário escolhe e edita; não há integração de envio.

## ADR 006 — STT local com VAD

**Decisão:** WAV mono 16 kHz em memória, pré-verificação Silero VAD, faster-whisper
local em buffers de aproximadamente 3 s. Dois requests concorrentes no máximo;
sem logs de áudio/texto. Modelo lazy-loading protegido por lock.
**Consequência:** silêncio não chega ao Whisper; cold-start e CPU podem exceder
metas de latência. Sem diarização; speaker desconhecido explícito. Blocos não
constituem STT streaming incremental. Teste em áudio de fala/hardware real é gate
para a fase 6.
Referência: https://github.com/SYSTRAN/faster-whisper .

## ADR 007 — Autenticação local e ausência de ações externas

**Decisão:** código aleatório por execução, token em ambiente opcional, loopback,
limites de payload, origem allowlist, WebSocket autenticado e descarte de áudio
quando a conexão cai. Transcript não é instrução nem possui ferramentas.
**Consequência:** adequado ao desenvolvimento pessoal; conta do SO, keychain,
criptografia em repouso e gestão de sessões exigem fase de produção própria.
