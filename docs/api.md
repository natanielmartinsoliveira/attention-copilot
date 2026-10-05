# API local

Todas as rotas exigem `Authorization: Bearer <ATTENTION_TOKEN>`. Porta padrão
4317, host 127.0.0.1. JSON até 64 KiB; erros JSON sem conteúdo da transcrição.
Socket.IO exige `{auth:{token}}` e emite `state` após cada mudança/reconexão.

| Método | Rota                       | Entrada/resultado                                      |
| ------ | -------------------------- | ------------------------------------------------------ |
| GET    | /api/state                 | AppState completo                                      |
| GET    | /api/health                | modo, status                                           |
| POST   | /api/demo/start            | {} inicia nova sessão demo                             |
| POST   | /api/stop                  | {} interrompe ingestão/demo                            |
| POST   | /api/reset                 | {} reinicia reuniões demo e mantém configuração        |
| POST   | /api/focus                 | {id: meetingId ou null para AUTO}                      |
| POST   | /api/interaction           | {id: meetingId} evidência de foco em AUTO              |
| POST   | /api/profile               | UserProfile validado                                   |
| POST   | /api/settings              | minAttentionDelta, cooldownMs, retentionHours, weights |
| POST   | /api/meetings              | {title, platform} retorna id                           |
| POST   | /api/capture/start         | {} autoriza ingestão real nesta sessão                 |
| POST   | /api/transcript            | TranscriptSegment, somente captura real ativa          |
| GET    | /api/events/:id/context    | Evento e trechos de origem                             |
| POST   | /api/events/:id/status     | {status: SEEN, ACKNOWLEDGED, RESPONDED, DISMISSED}     |
| POST   | /api/events/:id/response   | {} rascunhos, safe e origem                            |
| POST   | /api/events/:id/feedback   | {rating, reason opcional}                              |
| POST   | /api/meetings/:id/catch-up | {ultra: boolean} não altera foco                       |
| POST   | /api/meetings/:id/end      | {} resumo extrativo e encerramento                     |
| POST   | /api/meetings/:id/clear    | {} apaga transcript e eventos                          |
| DELETE | /api/meetings/:id          | Remove reunião e seus dados                            |

O API não tem acesso aos MediaStreams do browser. STOP é coordenado pelo cliente
para fechar tracks imediatamente e pelo servidor para rejeitar segmentos tardios.
Nenhuma rota envia mensagens, clica em Meet/Teams ou cria tarefas externas.
