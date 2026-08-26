# WTK-MEET-20 — Migrar wtk-meet de JavaScript para TypeScript em strict mode

> Documento de arquitetura: `docs/agents/arch-temp-migracao-typescript-strict.md`
> Branch: `agent/wtk-meet-20-quero-refatorar-o-proojeto-de-js-para-ts`
> Início: 2026-08-26

O registro do que a migração encontrou — números, decisões tomadas com evidência,
divergências entre documento e realidade, e o que foi deliberadamente **não** feito.

---

## 1. Linha de base (fase 0)

Medida antes de qualquer renomeação, com `npm install` nos três pacotes.

| Portão | Antes | Observação |
|---|---|---|
| `npm test` (client) | 478 casos verdes | é a contagem real em disco; o DoD do board diz "336", número de uma versão anterior da suíte |
| `npm test` (server) | 18 casos verdes | só `turnCredentials` |
| `node e2e/run.mjs` | **140/141** | única falha: F4a. O DoD do board diz "111/112" — também desatualizado |

**Divergência declarada:** os itens 4 e 7 do DoD citam números da suíte de uma
época anterior (336 casos e 111/112 checagens). A entrega respeita o **espírito**
do critério — nenhum teste removido, nenhum `skip` novo, nenhuma checagem de E2E
a menos — contra os números reais medidos aqui.

**Correção que precedeu tudo (`2064e25`):** a branch nasceu de um merge-base
quebrado. `401b739` (merge do PR #20 na main) deixou `ReferenceError: sinkId is
not defined` no client — a página não renderiza nada. Confirmado depois, com uma
sonda no próprio merge-base: `root` vazio e `pageerror: sinkId is not defined`. O
primeiro commit desta branch repara isso; **a `main` de hoje está quebrada e essa
correção precisa chegar lá**.

---

## 2. Fase 1 — a rede de segurança (antes de renomear)

Commit `152786d`, sobre o código JavaScript original, sem tocar em nenhum fonte.

| Arquivo novo | Casos | O que caracteriza |
|---|---|---|
| `server/test/rooms.test.mjs` | 11 | o `RoomStore`, inclusive `getRoom` de sala inexistente (`undefined`), `removeMember` que não lança e a saída do último, que **apaga** a sala |
| `server/test/signaling.test.mjs` | 27 | os seis handlers Socket.IO e os três endpoints, com o servidor real num processo filho. Metade dos casos é sobre **silêncio**: aprovação forjada ignorada, `signal` para outra sala descartado, sala cheia sem incomodar quem está dentro |
| `client/test/webrtcMeshContract.test.mjs` | 20 | `iceTransportPolicy: 'relay'` em toda conexão, os quatro transceivers na ordem que é o protocolo, o data channel negociado fora de banda, o desmonte |
| `client/test/roomPhases.test.mjs` | 22 | `pages/Room.jsx`, até então sem nenhum teste unitário: redirect sempre `replace`, nada de rede enquanto o redirect está pendente, a máquina de fases, os **três** pontos que criam registro de participante e a desmontagem que apaga o LED |

Contagem depois da fase 1: client 520, server 56.

**O recuo previsto no §6 do documento (cobrir do `Room` só o redirect e as fases)
não foi necessário** — `mock.module` deu conta do componente inteiro.

**O que a fase 1 deliberadamente não cobriu:** o caminho de mídia de verdade
(`getUserMedia`, ICE, DTLS) continua só no E2E. Caracterizar isso em `node:test`
exigiria dublar o navegador inteiro, e o dublê passaria a ser o que se testa.

---

## 3. As duas provas de fumaça da fase 2

Ambas exigidas pelo documento **antes** de converter qualquer módulo real.

**§3.3 — imports com sufixo `.js`:** confirmada. Um módulo folha (`lib/gridLayout`)
foi convertido sozinho e as três resoluções fecharam sem tocar em nenhum teste:
`npm test`, `npm run build` (o módulo dentro do bundle) e `tsc --noEmit`.

**§3.10 — o worklet: caminho A, com evidência.** O `?url` do Vite entrega o
arquivo **verbatim**, e TypeScript num `AudioWorkletGlobalScope` é `SyntaxError`
no `addModule`. O plugin `wtk-meet:ts-url-asset` (em `client/vite.config.ts`)
intercepta o `?url` sobre `.ts`, transpila com esbuild e emite o resultado como
asset. Prova em disco: `client/dist/assets/noiseSuppressorWorklet-*.js`, e o
`import` do `micPipeline` apontando para ele. O caminho B (deixar o worklet como
o único `.js` de `client/src/`) **não** foi necessário — não há exceção ao item 2
do DoD.

---

## 4. Bugs encontrados e **não** corrigidos

Regra do §7.5 do documento: a tipagem revela defeito real, e corrigir defeito
dentro de uma migração de 11 mil linhas torna impossível atribuir uma regressão.
Os três estão marcados no código com `TODO(WTK-MEET-21)` e preservam o
comportamento atual, byte a byte.

| Onde | O defeito | Por que não foi corrigido aqui |
|---|---|---|
| `client/src/lib/webrtcMesh.ts:21` e `client/src/pages/Room.tsx:611` | `displayName` atravessa do payload do outro browser direto para o callback, **sem sanitização** — `chat.ts` já sanitiza o autor da mensagem, este caminho não. Tipado como `unknown`, que é o que ele é | é mudança de comportamento em superfície de entrada hostil; merece card e teste próprios |
| `client/src/lib/musicSession.ts:674` | `useMusicRoom` passa `recovering: recoveringRef.current` num ponto em que o valor já mudou | idem |
| `client/vite.config.ts` (`server.allowedHosts`) | `'all'` **não é um valor aceito** pelo Vite. Ele libera qualquer host só com `true`; para qualquer outro valor ele *itera* o que recebeu — e iterar uma string percorre `'a'`, `'l'`, `'l'`, que não casa com hostname nenhum. Ou seja, hoje isso não libera nada | a correção é uma linha (`allowedHosts: true`), mas muda o comportamento do servidor de desenvolvimento |

---

## 4.1 O que a tipagem encontrou de morto

`meshRecovery.test.ts` tinha uma opção de fixture, `addPeerNow: false`, com
**zero chamadores** — e o ramo dela obrigava `rec`/`pc` a serem opcionais em
todo o arquivo, o que custaria ~50 `!` em asserções de um caminho que nunca
executa. A opção foi removida junto com o ramo. É a única mudança de fixture da
fase 7 que não é sintática, e ela não altera nenhuma asserção.

---

## 5. O E2E: o vermelho era contenção de sondas órfãs, não a migração

**Resultado final: 140/141, com a única falha sendo a F4a** — a mesma regressão
pré-existente da linha de base. A comparação nome a nome é exata:

```
diff <(vereditos da linha de base) <(vereditos sobre TypeScript)  →  sem diferença
```

141 checagens dos dois lados, os mesmos nomes, os mesmos vereditos. Nenhuma
checagem nova, nenhuma removida, nenhuma quebrada.

Chegar aqui custou três execuções, e o caminho merece registro porque é uma
armadilha que vai se repetir.

**A primeira execução** morreu no bloco T (`timeout esperando mesh da sala de
ruído`), levando junto os blocos T, U e G — 30 checagens que não chegaram a
rodar. As 111 que rodaram batiam com a linha de base.

**O diagnóstico por sondas** (o roteiro completo custa 10 minutos por tentativa;
uma sonda de um bloco só custa 3):

| Sonda | Resultado |
|---|---|
| bloco T isolado, código migrado, **com** `forceWorkletNoiseSuppression` | falhou — o par Dora↔Flavia parado em `conn: new, ice: new, sig: stable`, sem erro de console |
| mesmo bloco, **sem** o worklet forçado | 6/6 conexões |
| bloco T isolado, migrado, com o worklet, de novo | 6/6 conexões, 8 transceivers por conexão |
| bloco T no código **pré-migração** (`2064e25`), com o worklet | 6/6 conexões |

**A segunda execução completa** morreu ainda mais cedo — na checagem A1, no
mesh da sala principal, **sem worklet nenhum**. Foi o que derrubou a hipótese do
worklet e apontou para o ambiente.

**A causa:** as três sondas de diagnóstico tinham terminado de imprimir, mas
seus processos **nunca saíram** — cada uma segurava um `node-turn`, um servidor
estático e um servidor de sinalização vivos. O `finally` da sonda para os três,
e ainda assim o processo fica pendurado. Com os órfãos mortos e a máquina limpa
(`loadavg` 0.81), a terceira execução fechou 140/141.

É exatamente o modo de falha que o `claude-progress.md` já registrava — "duas
rodadas de E2E ao mesmo tempo produzem o sintoma de uma regressão de
negociação" —, só que a segunda rodada aqui não era um E2E: eram sondas mortas
que ninguém tinha enterrado.

**Como não cair nisto de novo:** depois de qualquer sonda que use o `harness`,
varrer `/proc/*/cmdline` atrás de `probe`/`run.ts` órfão **antes** de rodar o
E2E. Não há `ps` neste sandbox, e a sonda não morre sozinha.

> A comparação com o pré-migração custou uma volta a mais: o **merge-base**
> (`401b739`) tem o client quebrado (§1), e a sonda ali não passava nem da tela
> de pré-entrada. O ponto de comparação correto é `2064e25`, o commit desta
> branch que repara o resíduo.

E, de qualquer forma, o mesh está **fora de suspeita por construção**:
`client/src/lib/webrtcMesh.ts` e `client/src/lib/micPipeline.ts` são idênticos
ao JavaScript original a menos de anotação de tipo — a comparação linha a linha,
com comentários removidos, não mostra nenhuma mudança de lógica. As três únicas
construções que não são anotação pura estão comentadas no próprio código:
`String(pc.signalingState)` (o `'closed'` saiu da `RTCSignalingState` da spec, e
os navegadores continuam reportando-o), `clearTimeout(x ?? undefined)`
(`clearTimeout(null)` é no-op válido) e o predicado que substitui
`filter(Boolean)`.

**Trabalho futuro registrado:** a espera do mesh no bloco T merece a mesma
tolerância a re-tentativa que outros blocos já têm. Não foi mexido aqui porque o
E2E é conversão literal nesta entrega (item 7 do DoD).

---

## 5.1 Estado final dos portões

| Portão | Antes (JavaScript) | Depois (TypeScript) |
|---|---|---|
| `npx tsc --noEmit` (client / server / e2e) | não existia | **0 erros nos três**, com `strict: true` |
| `npm test` (client) | 478 | **520**, sem `skip`, sem teste removido |
| `npm test` (server) | 18 | **56** |
| `npm run lint` (client) | `.eslintrc.json`, só `.js`/`.jsx` | flat config + typescript-eslint, 82 arquivos `.ts`/`.tsx`, **0 erros e 0 warnings** |
| `npm run lint` (server) | não existia | **0 erros** |
| `npm run build` (client) | bundle | bundle + o worklet emitido como asset `.js` |
| `npm run build` (server) | não existia | `dist/` — `node dist/index.js` sobe, `/health` responde `{ ok: true, turn: { configured: false } }` e o aviso de TURN é logado |
| `node e2e/run.*` | 140/141 (só a F4a) | **140/141, só a F4a** — mesmos nomes, mesmos vereditos, checagem a checagem |
| `docker compose build` | — | **não executável neste sandbox** (não há `docker`); os dois `Dockerfile` e o contexto na raiz estão escritos e revisados, mas o comando não foi rodado |

## 6. Divergências entre o escopo do board e a entrega

1. **`docker-compose.yml` e `.dockerignore` não estão no escopo declarado**, mas o
   item 11 do DoD os exige: um `tsconfig.json` que estende `../tsconfig.base.json`
   não enxerga o arquivo base a partir de um contexto de build em `./client`. Os
   contextos passaram para a raiz, com `dockerfile:` explícito.
2. **`eslint.config.js` aparece no escopo no singular**; a entrega tem **um por
   pacote**, porque flat config resolve plugins a partir do diretório do próprio
   arquivo de config e não há `node_modules` na raiz.
3. **`tools/tsLoader.mjs` ganhou um companheiro**, `tools/registerTs.mjs` —
   exigência mecânica da flag `--import`.
4. **Os números do DoD (336 casos, 111/112 checagens) estão desatualizados** —
   ver §1.
5. **`client/probe4.mjs` foi apagado** (§7).
6. **`server/src/index.js` existiu como shim** entre as fases 5 e 7, para manter
   verdes, sem editá-los, os dois testes do client que sobem o servidor por
   caminho literal. Apagado na fase 7, junto com a conversão desses testes: eles
   passaram a fazer
   `spawn(node, ['--import', 'tools/registerTs.mjs', 'server/src/index.ts'])`.
7. **`docker compose build` não foi executado**: não há `docker` neste sandbox. É
   a única verificação do DoD que ficou por fazer, e está declarada como tal
   também no `add_task_log` da task. Os dois `Dockerfile` e o contexto na raiz
   estão escritos, revisados e coerentes com o build local que **foi** executado
   (`npm run build` nos dois pacotes, `node dist/index.js` de pé).

---

## 7. Deriva entre `docs/architecture.md` §8 e a estrutura real

`docs/architecture.md`, escrito **antes** da implementação, prescreve:

```
apps/web/                 # Vite + React + TS
signaling-server/         # Node.js + ws, TypeScript
```

O que existe é `client/` (Vite + React) e `server/` (Node + Express + **Socket.IO**,
não `ws`). São **três** derivas, e esta entrega fecha só uma:

| Eixo | Documento | Realidade | Nesta entrega |
|---|---|---|---|
| Tipagem | TypeScript | JavaScript | **fechado** — TS strict nos três pacotes |
| Nomes de diretório | `apps/web`, `signaling-server` | `client`, `server` | **não fechado** |
| Transporte de sinalização | `ws` | Socket.IO | **não fechado** |

Renomear os diretórios reescreveria os dois `Dockerfile`, o `docker-compose.yml`,
o `harness` do E2E e a documentação de instalação inteira, por zero ganho
funcional; trocar Socket.IO por `ws` é reescrever a sinalização. `ARCHITECTURE.md`
§8 — que descreve o que **existe** — é a referência correta; `docs/architecture.md`
é o documento de intenção original e deveria dizer isso de si mesmo.

---

## 8. O que ficou registrado como próximo degrau

- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` e
  `noPropertyAccessFromIndexSignature`: cada um exige mudança de código real.
- Type-aware linting (`projectService` do typescript-eslint): multiplica o tempo
  de lint por ~5 e traz um conjunto de regras novas cujo vermelho se confundiria
  com o da migração.
- Project references (`tsconfig.app` / `tsconfig.test` / `tsconfig.node`): hoje é
  um `tsconfig.json` por pacote, cobrindo `src` e `test` juntos — o que faz
  globais do Node ficarem visíveis no código de browser.
- Os três `TODO(WTK-MEET-21)` do §4.
- A correção do merge-base quebrado precisa chegar à `main` (§1).
