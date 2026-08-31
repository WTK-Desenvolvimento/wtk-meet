# WTK-MEET-22 — Design tokens, tema claro/escuro e CSS por componente

O registro completo desta entrega — o que mudou, a **tabela de contraste dos 81
pares dos dois temas**, os screenshots antes/depois de cada tela nos dois temas e
nos dois viewports, a linha de base do E2E e os débitos identificados — vive na
seção `# WTK-MEET-22` no topo de [`claude-progress.md`](../../claude-progress.md),
que é onde o DoD desta task pede que ele esteja.

Nesta pasta:

| Arquivo | O que é |
|---|---|
| `wtk-meet-22/shots.ts` | a sonda que produz as evidências: sobe TURN, sinalização, servidor estático e três participantes Chromium, captura as telas nos dois temas e nos dois viewports, e mede layout, alvo de toque, foco por `Tab` e as invariantes que o E2E lê. **Não** faz parte da suíte E2E |
| `wtk-meet-22/antes-*.png` | as telas antes da reforma (só no escuro — o tema claro não existia) |
| `wtk-meet-22/depois-*.png` | as telas depois, no escuro e no claro |
| `wtk-meet-22/{antes,depois}-medicoes.json` | as medições cruas de cada passada |

Como reproduzir (da raiz do repositório, com as libs do Chromium exportadas — ver
"Notas para rodar o E2E neste ambiente" no fim de `claude-progress.md`):

```bash
node --import ./tools/registerTs.mjs docs/progress/wtk-meet-22/shots.ts depois
```

O documento de arquitetura que orientou a entrega é
[`docs/agents/arch-temp-design-tokens-tema-claro-css-por-componente.md`](../agents/arch-temp-design-tokens-tema-claro-css-por-componente.md).
Duas divergências declaradas em relação a ele (CSS co-localizado em vez de barril
de `@import`, e agrupamento de fases em menos commits) estão justificadas na
seção de `claude-progress.md`.
