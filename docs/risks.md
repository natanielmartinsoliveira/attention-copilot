# Riscos, limites e próximos gates

| Risco                                      | Mitigação nesta entrega                                  | Gate para evoluir                                                   |
| ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Duas abas misturadas por loopback global   | Seleção individual de abas                               | Medir isolamento com vozes/sinais diferentes em duas reuniões reais |
| Nome mal transcrito ou pergunta implícita  | Apelidos, contexto, confiança e revisão                  | Dataset de transcrições reais e métricas por categoria              |
| Agrupamento incorreto por assunto genérico | Janela de 120 s e assunto derivado                       | Correlação semântica validada e casos de dois pedidos paralelos     |
| STT perde início/fim de frases             | Buffers limitados, erro visível                          | Overlap e reconciliação de segmentos, timestamps do provider        |
| CPU ou modelo excedem latência             | Dois requests e descarte explícito sob carga             | Benchmark p50/p95 em Windows alvo; sem meta falsa                   |
| Foco AUTO pouco preciso                    | Interação explícita, modo manual sempre disponível       | APIs de janela ativa com opt-in e evidências múltiplas              |
| Confiança não calibrada                    | Rótulo estimado, expertise indireta sem alerta agressivo | Curva precisão/recall, calibração e feedback                        |
| Provider indisponível/injection            | Caminho local e contrato sem ações                       | Adapters reais com schema estrito e testes adversariais             |
| Broker/cache/banco caem                    | Demo independente; modo infra explícito                  | Outbox, backoff, circuit breaker e testes de reinício               |
| Dados confidenciais persistidos            | Memória padrão, exclusão e áudio efêmero                 | Criptografia, DLQ TTL, purga coordenada e backups                   |
| Backend ausente no instalador              | Não entregar instalador como pronto                      | Sidecar, autenticação IPC, assinatura e atualização                 |

## Sequência de evolução

1. Primeira entrega: validar demo, regressões, catch-up, resposta e dashboard.
2. Validar caminho browser com duas reuniões reais e worker local; coletar latência
   e separação de streams. Testar STOP e cancelamento com inferências lentas.
3. Implementar WASAPI Windows a partir da documentação oficial em Windows compatível.
   Verificar compatibilidade de versões do Teams; nunca assumir PID estável.
4. Adapters OpenAI/Anthropic/Gemini, schemas, windowing, orçamento e custo real.
5. Diarização, tarefas confirmáveis, decisões e resumo com fontes.
6. Endurecer infraestrutura, retenção de filas, autenticação e empacotamento.

Não foram prometidos SDKs de Meet/Teams capazes de fornecer áudio individual nem
captura de macOS. Investigar documentação Apple/ScreenCaptureKit quando houver
um gate concreto de suporte macOS, sem atribuir capacidade inexistente ao MVP.
