# Attention Copilot — primeira entrega 0.1

Copiloto local de atenção para duas ou mais reuniões. Interface em português,
React/TypeScript, serviço NestJS e shell Tauri 2. Funciona sem serviços pagos.
Esta entrega é um MVP de desenvolvimento, não um instalador de produção.

## Comece pela demo (Node.js 22+)

```bash
npm ci
npm run build
npm start
```

Abra **http://127.0.0.1:4317** e informe o código de acesso mostrado no terminal.
Clique **Iniciar demo**. Em aproximadamente 14 segundos, a reunião frontend
fica em **18**, backend em **97**, e aparece a recomendação de trocar o foco.

Clique **Catch me up**, **Essencial**, **Ver contexto** e **Gerar resposta**.
Marque **Respondido** para resolver o alerta. Copiar uma sugestão não envia nada
nem marca a pergunta como respondida. Notificações desktop dependem de permissão
explícita; por padrão não há som. Mini modo compacta a interface; no Tauri também
redimensiona e mantém a janela no topo.

Para desenvolver: `npm run dev`. Verificação: `npm run check`, `npm test`.

## O que funciona nesta entrega

- Duas reuniões simuladas independentes com speakers, horários e WebSocket.
- Entidades e APIs aceitam mais de duas reuniões; `POST /api/meetings` adiciona.
- Detecção local com identidade, contexto de 120 s, responsabilidade, negação,
  pergunta, expertise, urgência, prazo, bloqueio e importância configurável.
- Score, comparação de reuniões, limite de diferença, cooldown, agrupamento,
  escalada, expiração, idempotência e ciclo de vida dos eventos.
- Centro de atenção, contexto, busca, filtros, foco manual e AUTO por interação.
- Catch-up do período fora do foco e extrato essencial de eventos relevantes.
- Respostas conservadoras editáveis; nenhuma execução/envio de resposta.
- Perfil, projetos, pessoas, expertise e pesos editáveis em formulário JSON.
- Feedback, exclusão de reunião/transcrição, retenção, resumo final extrativo.
- Autenticação por código local, validação de entrada e serviços ligados ao loopback.
- Docker Compose e migration PostgreSQL; adaptadores PostgreSQL/Redis/RabbitMQ.
- Caminho experimental real: seleção de aba no Chrome/Edge → PCM em memória →
  worker Python → Silero VAD → faster-whisper → motor de atenção.

## Infraestrutura opcional

A demo usa memória por padrão. Reiniciar o processo apaga essa sessão. Para
persistência, com Docker instalado:

```bash
docker compose -f infra/docker-compose.yml up -d --wait
```

Depois defina as variáveis de `.env.example` no seu shell e `STORAGE_MODE=infra`.
**O Node não carrega `.env` automaticamente neste comando**; você pode usar:

```bash
node --env-file=.env dist/apps/api/src/main.js
```

No modo infra, transcrições da demo passam pela fila `meeting.transcript`;
PostgreSQL persiste estado, perfil, reuniões, transcrições e eventos; Redis recebe
estado de foco/scores com TTL. As sete filas e respectivas DLQs são declaradas.
As demais filas reservam contratos para fases posteriores; não fingem ter
workers ativos. Retry de transcrição é limitado a três republicações, com
publisher confirms, ACK após persistência e deduplicação por segmento.

Migration `001_initial.sql` é aplicada na primeira inicialização do volume.
Em volume existente, aplique migrations com `psql` e controle a tabela
`schema_migration`. Não apague volumes para atualizar o esquema.
Credenciais Compose são exclusivas de desenvolvimento local.

## Áudio real experimental (Chrome/Edge)

Use a interface web em localhost. Configure **o mesmo ATTENTION_TOKEN** no Node
e no worker. Python 3.11+:

```bash
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r apps/worker/requirements.txt
python -m uvicorn apps.worker.stt:app --host 127.0.0.1 --port 4318 --no-access-log
```

Na interface, pare a demo. Em cada reunião clique **Selecionar aba com áudio**.
Escolha uma aba de reunião e habilite **Compartilhar áudio**. Repita para outra
aba. A seleção é explícita; não há acesso silencioso a todas as aplicações.
O worker processa WAV mono 16 kHz, com buffers de aproximadamente 3 s.
A confiança dos trechos reais é conservadora (0,65): são exibidos no radar, sem
notificação agressiva ou recomendação automática de troca até haver confirmação
mais confiável. O modelo Whisper é baixado no primeiro uso; para operação sem rede, pré-carregue
o modelo e configure `STT_MODEL` com o caminho local. STT em português por padrão.

**Limites:** browser deve oferecer áudio de aba; janela/tela podem não oferecer
áudio. O áudio não identifica speakers; usa “Voz não identificada”. Buffers
independentes perdem continuidade entre blocos; se STT não acompanhar, descarta
um bloco e mostra aviso. Não há promessa de latência <3 s. O cliente interrompe
tracks, worklet e requests ao parar ou perder conexão; o servidor rejeita novos
segmentos após STOP. O worker não armazena WAV, mas uma inferência em execução
pode terminar internamente após o cancelamento do cliente.

## Tauri / Windows

Instale os pré-requisitos oficiais: Rust, ferramentas C++ do Visual Studio e
WebView2. Execute o CLI **dentro de apps/desktop**, para resolver o projeto Rust:

```bash
cd apps/desktop
npx tauri dev
```

A configuração inicia `npm run dev` na raiz (ver ADR). Para build de desktop,
execute `npx tauri build` nesta pasta. O shell se conecta ao serviço NestJS em
127.0.0.1:4317; inicie o backend separadamente em uso fora do desenvolvimento.
Esta versão não empacota o backend nem gera instalador (`bundle.active=false`).
Captura de abas usa a interface web, não o WebView do Tauri.

## O que ainda não está entregue

- Captura WASAPI por processo e integrações nativas Meet/Teams.
- Diarização, reconhecimento de fala do próprio usuário e detecção automática
  confiável de resposta/resolução em todos os casos.
- Adapters comerciais OpenAI/Anthropic/Gemini: contrato e router existem; o fluxo
  executado é local. Não há chamada paga nem métricas fictícias de tokens/custo.
- Resumo abstrativo, decisões inferidas e tarefas externas.
- Inferência de foco por janela ativa: AUTO usa interação explícita na interface.
- Auth por conta do SO, armazenamento em keychain, encryption-at-rest, instalador,
  atualizador e operação distribuída tolerante a falhas.

Leia [arquitetura](docs/architecture.md), [riscos e roadmap](docs/risks.md),
[ADRs](docs/adrs.md), [API](docs/api.md) e [validação](docs/validation.md).
