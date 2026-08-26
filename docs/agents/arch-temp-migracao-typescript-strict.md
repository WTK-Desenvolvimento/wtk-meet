# Migrar wtk-meet de JavaScript para TypeScript em strict mode — Documento de Arquitetura Técnica

> Gerado em: 2026-08-26
> Status: Rascunho
> Task: WTK-MEET-20 (`01a03e79-fab2-7838-83b7-784f4a91c41b`), estimativa do board: 56h
> Branch: `agent/wtk-meet-20-quero-refatorar-o-proojeto-de-js-para-ts`

---

## 1. Contexto e Objetivo

O repositório é 100% JavaScript em **três pacotes independentes**, sem `package.json` na
raiz e sem workspaces:

| Pacote | Runtime | Conteúdo | Testes |
|---|---|---|---|
| `client/` | Vite 5 + React 18 | 21 módulos em `src/lib/`, 13 componentes, 3 páginas, `App.jsx`, `main.jsx`, `config.js` | 29 `.test.mjs` em `node:test` + 2 hooks de módulo |
| `server/` | Node ESM + Express + Socket.IO | `src/index.js` (235 l.), `src/rooms.js` (60 l.), `src/turnCredentials.js` (179 l.) | 1 `.test.mjs` + 1 fixture |
| `e2e/` | Node + Playwright | `run.mjs` (2549 l.), `harness.mjs` (891 l.) | é o próprio teste |

`ARCHITECTURE.md` §7 (linha 917) registra a decisão explícita **"Sem TypeScript neste MVP
para reduzir footprint de ferramentas — decisão reversível se o time crescer"**. Esta task
exerce a reversibilidade prevista. `docs/architecture.md` §8, escrito antes da
implementação, sempre prescreveu "React + TS + Vite" e "signaling-server: Node.js + ws,
TypeScript" — o código nasceu divergente daquele documento em dois eixos (tipagem e
estrutura de pastas), e esta entrega fecha **apenas o eixo da tipagem**.

**Problema concreto que a tipagem resolve neste código, e não é abstrato:** o histórico do
projeto tem defeitos que um compilador teria pego antes do E2E — `showVideo = !!stream &&
!cameraOff` com stream só de áudio (WTK-MEET-19), registro de participante nascendo sem o
campo `cameraOff` (`!!undefined === false`), quatro pontos do `Room` assumindo que o track
do `getUserMedia` era o track que ia para o mesh (`micPipeline.js`), `planAdvance`
duplicado por fusão de duas sessões. São erros de **forma de objeto** e de **identidade de
recurso** — exatamente a classe que `strict: true` elimina.

**Comportamento esperado após a entrega:** o produto se comporta *exatamente* como hoje.
Esta é uma migração de forma, não de comportamento — nenhum bug corrigido, nenhuma
refatoração de desenho, nenhuma dependência de runtime nova. O que muda é o
ferramental: `tsc --noEmit` passa a ser um portão, o lint passa a entender tipos e o
servidor passa a ter passo de compilação.

---

## 2. Escopo

**Dentro do escopo:**

- Conversão de todo o código-fonte de `client/src/`, `server/src/` e `e2e/` para `.ts`/`.tsx`,
  com `strict: true` puro nos três pacotes.
- Uma **rede de segurança de testes de caracterização** (fase 1), escrita **antes** de
  qualquer renomeação, cobrindo as três áreas que hoje só o E2E exercita: os handlers
  Socket.IO de `server/src/index.js`, `server/src/rooms.js`, `client/src/lib/webrtcMesh.js`
  e `client/src/pages/Room.jsx`.
- Conversão dos 30 arquivos de teste (29 do client + 1 do server) para TypeScript, **só na
  fase final**, com a suíte já verde sobre código TypeScript.
- Infra de tipos: `tsconfig.base.json` na raiz + um `tsconfig.json` por pacote; hooks de
  módulo em `tools/` para o `node --test` enxergar `.ts`/`.tsx`; arquivos de declaração
  ambiente para as lacunas da `lib.dom`.
- Lint em flat config com `typescript-eslint` no client e no server; remoção do
  `.eslintrc.json` legado.
- Passo de build do server (`tsc` → `dist/`), `Dockerfile` dos dois pacotes e o que o
  `docker-compose.yml` precisar para continuar buildando sem ajuste manual.
- Atualização de `ARCHITECTURE.md` §7/§8, `README.md` e criação de
  `docs/progress/WTK-MEET-20.md`.

**Fora do escopo — explicitamente:**

- **Corrigir qualquer bug encontrado no caminho.** Se a tipagem revelar um defeito real
  (e vai revelar), o comportamento é **preservar o comportamento atual** com um comentário
  `// TODO(WTK-MEET-XX)` e um registro no arquivo de progresso. Corrigir bug dentro de uma
  migração de 11 mil linhas torna impossível dizer se uma regressão veio da tipagem ou da
  correção.
- **Refatorar desenho.** Nenhuma função extraída, nenhum módulo dividido, nenhuma
  assinatura mudada, nenhuma classe virando função. `Room.tsx` continua com 1600 linhas.
- **Reestruturar diretórios** para o `apps/web` + `signaling-server` de `docs/architecture.md`
  §8. A deriva é registrada no arquivo de progresso (item 14 do DoD), não resolvida.
- **Trocar `useState`/`useRef` por store tipada** (o Zustand que `docs/architecture.md` §8
  sugere). Não é migração de tipos.
- **Migrar para React 19, Vite 6, Express 5 ou ESLint stylistic.** Só sobem as dependências
  que a migração exige.
- **Reescrever o E2E.** `run.ts` e `harness.ts` são conversão literal; nenhuma checagem
  nova, nenhuma checagem removida. A F4a continua falhando (regressão pré-existente
  conhecida, documentada no board e em `docs/progress/`).
- **Habilitar `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` ou
  `noPropertyAccessFromIndexSignature`.** Não estão em `strict` e cada um exige mudança de
  código real. Ficam registrados como trabalho futuro no `ARCHITECTURE.md`.
- **`.d.ts` de terceiros mantidos à mão** além das lacunas listadas no §5.4.

---

## 3. Decisões Arquiteturais

### 3.1 Duas ordens, sete fases: rede de segurança antes de renomear

- **Decisão:** a migração acontece em sete fases numeradas (§6), e a fase 1 é
  exclusivamente testes de caracterização em JavaScript sobre o código JavaScript
  original. Nenhum arquivo é renomeado antes de a fase 1 estar commitada e verde.
- **Motivação:** três áreas do código — `server/src/index.js`, `client/src/pages/Room.jsx`
  e `client/src/lib/webrtcMesh.js` — concentram a lógica mais frágil do produto e têm
  cobertura unitária parcial ou nenhuma. O único portão sobre elas hoje é o E2E, que leva
  ~10 minutos, tem passos intermitentes por temporização do sandbox e **não pode rodar em
  paralelo** (ver `claude-progress.md` e o registro de contenção do `node-turn`). Migrar
  primeiro e testar depois transforma cada erro de conversão em uma bissecção de 10 minutos
  por tentativa.
- **Alternativas descartadas:**
  - *Migrar arquivo a arquivo com o E2E como único portão* — rejeitada pelo custo de ciclo
    e pela intermitência conhecida: um E2E vermelho por temporização, no meio de uma
    migração, é indistinguível de uma regressão de conversão.
  - *Converter tudo de uma vez e consertar o que quebrar* — rejeitada porque o `Room.tsx`
    sozinho tem 24 imports e 83 hooks; um único commit gigante não é revisável e não é
    bissectável.

### 3.2 Renomeação primeiro, tipos depois — dentro de cada fase de conversão

- **Decisão:** cada arquivo é convertido em dois movimentos separados: (a) `git mv` para
  `.ts`/`.tsx` com o mínimo de anotações para compilar; (b) tipagem de verdade. Os dois
  movimentos podem estar no mesmo commit, mas o `git mv` deve ser detectável como rename
  pelo `git log --follow`.
- **Motivação:** o repositório carrega dois commits de reparo de fusão (`1b09b12`,
  `1baa707`) e um histórico de sessões concorrentes sobrescrevendo arquivos. Perder o
  histórico de `Room.jsx` numa renomeação que o git não reconhece como rename apagaria o
  rastro de por que cada uma das ~40 decisões documentadas nos comentários existe.
- **Alternativas descartadas:** *criar o `.ts` novo e apagar o `.js`* — rejeitada: o git
  detecta rename por similaridade, e um arquivo que ganha 200 anotações no mesmo commit da
  criação pode cair abaixo do limiar.

### 3.3 Especificadores de import continuam com sufixo `.js`

- **Decisão:** dentro dos fontes TypeScript, os imports relativos continuam escritos como
  `'./rooms.js'`, `'../lib/webrtcMesh.js'`, `'../components/VideoTile.jsx'` — **mudando
  apenas** `.jsx` → `.js` onde o alvo virou `.tsx`. Nenhum import passa a apontar para
  `.ts`/`.tsx`, e nenhum vira extensionless.
- **Motivação:** três consumidores diferentes precisam resolver os mesmos especificadores,
  e só o sufixo `.js` serve aos três: (a) o **server emite** para `dist/` via `tsc`, e
  `allowImportingTsExtensions` é proibido quando há emissão — importar `'./rooms.ts'`
  simplesmente não compila; (b) o **Vite** resolve `.js` → `.ts` para importadores
  TypeScript; (c) os **29 testes `.mjs` da fase 2–6 não podem ser tocados** (item 6 do
  DoD) e eles importam `'../src/lib/webrtcMesh.js'` — se o fonte passasse a se chamar
  internamente de outro jeito, a migração teria que tocar em teste antes da hora.
- **Alternativas descartadas:**
  - *`allowImportingTsExtensions` com `.ts` explícito* — rejeitada: incompatível com a
    emissão do server (DoD 10) e desnecessária, já que o hook de resolução do §3.4 resolve
    o mesmo problema para todos os pacotes de uma vez.
  - *Imports extensionless com `moduleResolution: Bundler`* — rejeitada: quebra o `node
    --test` (ESM exige extensão), quebra a emissão do server e obrigaria a tocar nos 29
    testes.
- **Verificação obrigatória na fase 2** (é a única premissa não confirmada deste
  documento): antes de converter qualquer módulo real, converter **um** módulo folha
  (sugestão: `lib/gridLayout.js`) e provar as três resoluções — `npm run build` no client
  gera bundle com aquele módulo dentro, `node --test` do teste correspondente passa sem
  tocar no teste, e `npx tsc --noEmit` fecha. Se o Vite **não** resolver `.js` → `.ts`, o
  plano B é `resolve.extensions` explícito no `vite.config.ts`; se nem isso, a decisão cai
  para "extensionless no client + `.js` no server", e este documento precisa ser revisado
  antes de seguir.

### 3.4 Dois hooks de módulo em `tools/`, com responsabilidades separadas

- **Decisão:** o `node --test` enxerga TypeScript por meio de **um** arquivo de hooks,
  `tools/tsLoader.mjs`, registrado por `tools/registerTs.mjs` via a flag `--import` nos
  scripts `test` do `package.json`. Ele faz exatamente duas coisas:
  1. **`resolve`** — quando um especificador terminado em `.js`/`.jsx` não existe em
     disco, tenta `.ts` e depois `.tsx` no mesmo caminho. Sem dependência nenhuma.
  2. **`load`** — só para `.tsx`, transforma com esbuild (`loader: 'tsx'`, `jsx:
     'automatic'`). Arquivos `.ts` **não** são interceptados: o Node 24 já faz type
     stripping nativo, e não interceptar significa uma engrenagem a menos.
- **Motivação:** o repositório já resolve problemas assim (`client/test/jsxLoader.mjs`,
  `client/test/viteUrlLoader.mjs`), e o próprio comentário do `viteUrlLoader` defende a
  separação por responsabilidade. Manter o `resolve` livre de dependências é o que permite
  o **server** e o **e2e** usarem o mesmo arquivo sem instalar esbuild.
- **Detalhe de implementação que não é opcional:** `tools/` fica na raiz, onde **não há
  `node_modules`**. O esbuild precisa ser resolvido a partir do `client/` (onde ele existe,
  hoje transitivamente pelo Vite). O contrato é: resolução **preguiçosa** (só na primeira
  vez que um `.tsx` for carregado) e ancorada em `client/`, para que o hook não exploda em
  `server`/`e2e`, que nunca carregam `.tsx`. Adicionar `esbuild` como `devDependency`
  **explícita** do client: a infraestrutura de teste já depende dele hoje por acidente de
  árvore, e isso é uma dependência de verdade.
- **Alternativas descartadas:**
  - *`ts-node`, `tsx` ou `swc` como runner* — rejeitada: dependência nova de peso para
    resolver o que 40 linhas de hook resolvem, contra a diretriz de footprint mínimo que a
    própria §7 do `ARCHITECTURE.md` invoca.
  - *Compilar os testes para `.js` antes de rodar* — rejeitada: introduz artefato
    intermediário, quebra os stack traces e obriga a um `pretest` em todo lugar.
  - *Confiar só no type stripping nativo do Node* — rejeitada: o Node não transforma JSX e
    não remapeia `.js` → `.ts`. As duas lacunas são justamente as que temos.

### 3.5 O client não emite; o server emite

- **Decisão:** `client/tsconfig.json` tem `noEmit: true` (o Vite constrói, o `tsc` só
  confere). `server/tsconfig.json` emite para `server/dist/`, e o `start` do server passa a
  ser `node dist/index.js`.
- **Motivação:** é o item 10 do DoD e é o desenho padrão dos dois runtimes. O server roda em
  `node:alpine` num container, onde não vale a pena carregar loader de tipos em produção;
  o client já tem um bundler.
- **Consequência em cascata (§4.4 e §7.2):** três consumidores hoje apontam para
  `server/src/index.js` — `e2e/harness.mjs` (linha 190), `client/test/joinRequestSignaling.test.mjs`
  (linha 28) e `client/test/roomOccupancy.test.mjs` (linha 22). Os dois últimos são
  arquivos de teste que **não podem ser tocados** nas fases 2–6.

### 3.6 Shim transitório de `server/src/index.js` (a peça que faz o DoD 6 e o DoD 2 caberem juntos)

- **Decisão:** quando o server for convertido (fase 5), `server/src/index.js` **não some** —
  ele vira um shim de três linhas que registra `tools/tsLoader.mjs` e importa
  dinamicamente `./index.ts`. O shim é apagado na fase 7, junto com a conversão dos testes
  que o usam.
- **Motivação:** `spawn(process.execPath, [SERVER_ENTRY])` cria um processo Node **novo**;
  hook registrado no processo pai não atravessa. Sem o shim, converter o server quebra
  dois testes do client que o item 6 do DoD proíbe editar naquele momento. Com o shim, os
  dois testes continuam byte-a-byte idênticos e continuam verdes, e a fase 7 os reescreve
  para apontarem para o alvo definitivo.
- **Alternativas descartadas:**
  - *`NODE_OPTIONS=--import ...` propagado pelo `env` do spawn* — rejeitada: depende de o
    hook de `resolve` interceptar o **entry point** do processo, comportamento que varia
    entre versões do Node. Apostar nisso é apostar a suíte inteira num detalhe não
    documentado.
  - *Converter o server por último, depois dos testes* — rejeitada: contradiz a ordem que a
    própria task fixa ("só em uma fase final os testes são migrados").
  - *Deixar os dois testes vermelhos por duas fases* — rejeitada: uma suíte vermelha durante
    a migração destrói o valor da rede de segurança, que é justamente saber que o vermelho
    de agora foi você quem causou.

### 3.7 Um `tsconfig.json` por pacote, herdando de um `tsconfig.base.json` na raiz

- **Decisão:** a raiz ganha `tsconfig.base.json` com o rigor comum (`strict`,
  `isolatedModules`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`, `target`/`module` ES2023+). Cada
  pacote estende e acrescenta só o que é dele (libs, `types`, `noEmit`/`outDir`, `jsx`,
  `include`). **Não** haverá `package.json` na raiz nem workspaces: os três pacotes
  continuam independentes, cada um com `typescript` na própria `devDependencies`.
- **Motivação:** um único lugar define o que "strict" significa neste repo; três
  `package.json` independentes preservam a propriedade que o `ARCHITECTURE.md` §8 descreve
  e que os `Dockerfile` assumem.
- **Alternativas descartadas:**
  - *Monorepo com npm workspaces* — rejeitada: reescreveria os dois `Dockerfile`, o
    `docker-compose.yml`, o `harness.mjs` e a documentação inteira de instalação por um
    ganho que esta task não precisa.
  - *`tsconfig` autocontido por pacote, sem base* — rejeitada: três cópias de `strict`
    derivam, e a primeira que derivar cria um pacote menos rigoroso sem ninguém perceber.
- **Consequência que precisa ser tratada junto (§7.3):** os contextos de build do
  `docker-compose.yml` hoje são `./server` e `./client`. Um `tsconfig.json` que estende
  `../tsconfig.base.json` **não enxerga o arquivo base dentro desses contextos**. A
  correção é mover os contextos para a raiz com `dockerfile:` explícito e adicionar um
  `.dockerignore`. O `docker-compose.yml` não está no escopo declarado do board, mas o item
  11 do DoD ("`docker compose build` sobe as duas imagens sem ajuste manual") o arrasta para
  dentro — divergência registrada no §9.4.

### 3.8 `tsconfig` único por pacote, cobrindo `src` + `test` (sem project references)

- **Decisão:** o client tem **um** `tsconfig.json` incluindo `src/`, `test/` e
  `vite.config.ts`, com `lib: ["ES2023", "DOM", "DOM.Iterable"]` e `types: ["node",
  "vite/client"]`.
- **Motivação:** o item 1 do DoD pede `npx tsc --noEmit` fechando por pacote — comando
  simples, sem `-b`, sem grafo de projetos. O custo é aceitar globais de Node visíveis no
  código de browser.
- **Alternativa descartada:** *project references* (`tsconfig.app.json` +
  `tsconfig.test.json` + `tsconfig.node.json`, padrão do `create-vite`) — rejeitada pelo
  custo de ferramental num repo que não tem CI e cujo portão é um comando manual. Fica
  registrada como trabalho futuro.
- **Armadilha direta desta decisão, e ela vai aparecer:** com `@types/node` e `DOM` no
  mesmo programa, `setTimeout`/`setInterval` resolvem para a sobrecarga do Node
  (`NodeJS.Timeout`), não para `number`. **Regra do projeto: todo handle de timer é tipado
  como `ReturnType<typeof setTimeout>`, nunca `number`.** Vale para `Room.tsx`
  (`toastTimersRef`), `audioLevels.ts`, `musicSession.ts`, `youtubePlayer.ts` e
  `iceServers.ts`.

### 3.9 `any` e casts só nas bordas, num lugar só

- **Decisão:** as lacunas da `lib.dom` são declaradas em **arquivos de declaração ambiente
  dedicados** (§5.4), não espalhadas em casts pelo código. Cada declaração leva um
  comentário de uma linha dizendo qual API do browser não está na `lib.dom` e por quê. Os
  sete módulos puros nomeados no item 12 do DoD — `musicVote`, `musicSession`/fila,
  `gridLayout`, `spotlightLayout`, `roomSlug`, `roomRouting`, `musicProtocol` — **não
  podem conter nenhum `any`, nenhum `as` de contorno e nenhum `@ts-expect-error`.**
- **Motivação:** são justamente os módulos que o projeto manteve puros de propósito (o
  cabeçalho de `iceServers.js` e o de `micPipeline.js` documentam essa fronteira), e são os
  únicos onde a tipagem entrega valor sem atrito. Se `any` entrar ali, entrou por
  preguiça, não por lacuna de plataforma.
- **Alternativa descartada:** *`@ts-expect-error` pontual em cada uso* — rejeitada: o mesmo
  buraco de plataforma seria redocumentado em N lugares, e um `@ts-expect-error` que deixa
  de ser necessário vira erro de compilação em um ponto aleatório do futuro.

### 3.10 O `noiseSuppressorWorklet` é o caso especial da migração

- **Decisão:** o arquivo continua com **uma cópia só** do DSP e continua sendo carregado
  de duas formas (browser via `audioWorklet.addModule(url)`, e `node:test` como módulo ES),
  mas o caminho do browser deixa de poder receber o arquivo cru. A fase 2 precisa **provar
  qual dos dois caminhos abaixo funciona** antes de o arquivo ser convertido:
  - **Caminho A (preferido):** um plugin mínimo no `vite.config.ts` intercepta o import
    `?url` desse arquivo, transpila com esbuild e emite o resultado como asset. O fonte
    continua `.ts`, o browser recebe `.js`.
  - **Caminho B (recuo):** o worklet permanece o **único** `.js` de `client/src/`, com os
    tipos num `.d.ts` irmão. Viola o item 2 do DoD e precisa ser registrado como
    divergência no arquivo de progresso e no `add_task_log` do board.
- **Motivação:** o sufixo `?url` do Vite entrega o arquivo **como asset**, sem transformação
  — é para isso que ele existe. Um arquivo `.ts` com anotações servido a um
  `AudioWorkletGlobalScope` é `SyntaxError` no `addModule`.
- **Por que isto é o risco nº 1 e não uma nota de rodapé:** `micPipeline.ts` **engole** a
  falha do `addModule` de propósito (`console.warn` + `passthrough`), porque uma promise
  rejeitada solta num efeito reprova a checagem G do E2E. Ou seja: se o worklet quebrar, a
  supressão de ruído desliga em silêncio e o produto continua "funcionando". A verificação
  não pode ser "o E2E passou" — tem que ser a checagem **T8** do bloco T (RMS ≥ 6 dB menor
  com supressão ligada), que é a única que morre se o worklet não carregar.

### 3.11 Lint: flat config por pacote

- **Decisão:** `client/eslint.config.js` e `server/eslint.config.js` (ESLint 9 +
  `typescript-eslint` v8), cada um com o plugin na `devDependencies` do próprio pacote.
  `client/.eslintrc.json` é removido. Configuração **sem** `type-aware linting`
  (`projectService`) na primeira entrega.
- **Motivação:** flat config resolve plugins a partir do diretório do próprio arquivo de
  config; um config na raiz exigiria `node_modules` na raiz, e o §3.7 já decidiu não ter um.
  Type-aware linting multiplica o tempo de lint por ~5 e traz um conjunto de regras novas
  cujo vermelho se confunde com o da migração — fica como trabalho futuro.
- **Divergência declarada:** o escopo do board diz `eslint.config.js` no singular, no grupo
  da raiz. Ver §9.4.
- **Alternativa descartada:** *manter `.eslintrc` com `@typescript-eslint/parser` legado* —
  rejeitada: o item 8 do DoD pede flat config explicitamente, e o ESLint 9 não lê mais o
  formato antigo sem flag de compatibilidade.

### 3.12 O E2E não precisa de loader

- **Decisão:** `e2e/` é convertido para `.ts` e roda com o **type stripping nativo do Node**
  (v24 no ambiente atual), usando `allowImportingTsExtensions` + `noEmit` no tsconfig do
  pacote e importando `'./harness.ts'` com extensão real. `e2e/` ganha `typescript` como
  `devDependency` só para o `tsc --noEmit`, e **nenhuma** dependência de runtime nova.
- **Motivação:** o e2e não emite, não tem JSX e não é importado por ninguém. É o único
  pacote que pode usar o caminho mais simples, e usá-lo reduz o número de peças móveis.
- **Consequência:** o `harness.ts` passa a buildar o server (`npm run build` em `server/`,
  espelhando o `buildClient()` que já existe) e a subir `dist/index.js`. Ganho colateral: o
  E2E passa a validar o artefato compilado, que é exatamente o que o item 10 do DoD pede.
- **Requisito de Node que precisa ir para o README (item 13 do DoD):** `>= 22.18` (ou
  `>= 24`). Em Node 20 não há type stripping e nem `npm test` nem `node e2e/run.ts`
  funcionam. Os `Dockerfile` usam `node:20-alpine` hoje e só rodam artefato compilado ou
  `vite build` — funcionam, mas devem subir para `node:22-alpine` por coerência com o
  `engines` declarado.

---

## 4. Componentes Afetados

### 4.1 Raiz do repositório

| Componente | O que muda | Por quê |
|---|---|---|
| `tsconfig.base.json` | **novo** — rigor comum aos três pacotes | §3.7; um só lugar define "strict" |
| `tools/tsLoader.mjs` | **novo** — hooks `resolve` (`.js`→`.ts`/`.tsx`) e `load` (`.tsx` via esbuild) | §3.4; é o que faz o `node --test` enxergar TS sem runner novo |
| `tools/registerTs.mjs` | **novo** — chama `register()`; é o alvo do `--import` | `--import` precisa de um módulo que registre o hook |
| `docker-compose.yml` | contextos de build passam para a raiz, com `dockerfile:` explícito | §3.7; sem isso o `tsconfig.base.json` não entra na imagem |
| `.dockerignore` | **novo** — exclui `node_modules/`, `dist/`, `.git/`, `e2e/`, `docs/` | consequência do contexto na raiz; sem ele o build fica lento e vaza arquivo |
| `ARCHITECTURE.md` | §7 (l. 917): "Sem TypeScript" vira decisão **revertida**, com data (2026-08) e motivo, preservando o registro histórico; §8 ganha os arquivos novos | item 13 do DoD |
| `README.md` | scripts novos (`typecheck`, `build` do server), requisito de Node, como rodar lint | item 13 do DoD |
| `docs/progress/WTK-MEET-20.md` | **novo** | item 14 do DoD |

### 4.2 `client/`

| Componente | O que muda | Por quê |
|---|---|---|
| `src/lib/` (21 módulos) | `.js` → `.ts`, tipados | núcleo da entrega |
| `src/components/` (13) | `.jsx` → `.tsx`, props tipadas por `interface` local | idem |
| `src/pages/` (3) | `.jsx` → `.tsx` | `Room.tsx` é o arquivo mais caro da migração (1600 l., 24 imports, 83 hooks) |
| `src/App.jsx`, `src/main.jsx`, `src/config.js` | `.tsx`/`.ts` | `main.tsx` obriga a mexer no `index.html` |
| `index.html` | `src="/src/main.jsx"` → `/src/main.tsx` | senão o app não carrega, e o `vite build` **não** avisa de forma óbvia |
| `vite.config.js` | → `vite.config.ts`; possivelmente o plugin do worklet (§3.10 caminho A) | typecheck do próprio config |
| `src/types/*.d.ts` | **novos** (§5.4) | lacunas da `lib.dom`, num lugar só |
| `.eslintrc.json` → `eslint.config.js` | flat config + typescript-eslint | item 8 do DoD |
| `package.json` | scripts `test`/`lint`/`typecheck`; devDeps `typescript`, `esbuild`, `@types/react`, `@types/react-dom`, `@types/node`, eslint 9, typescript-eslint | §5.1 |
| `Dockerfile` | `COPY` ajustado ao contexto da raiz | §3.7 |
| `test/` (29 `.test.mjs`) | **intocados nas fases 1–6**; convertidos para `.ts` na fase 7 | itens 4, 6 e 2 do DoD |
| `test/jsxLoader.mjs`, `test/viteUrlLoader.mjs` | permanecem nas fases 2–6 (5 testes os registram); na fase 7, `jsxLoader` é absorvido por `tools/tsLoader.mjs` e some; `viteUrlLoader` migra para `tools/` | o `?url` continua existindo depois da migração |
| `probe4.mjs` | **apagar** (recomendação) | script de sondagem de 15 linhas, aponta para `../server/src/index.js`, usa API interna (`process._getActiveHandles`) e não é referenciado por nada. Ver §9.5 |

### 4.3 `server/`

| Componente | O que muda | Por quê |
|---|---|---|
| `src/rooms.js` → `.ts` | `RoomStore` com `Map<string, Map<string, Member>>` tipado | a estrutura aninhada é o que os handlers mais erram |
| `src/turnCredentials.js` → `.ts` | tipar `env`, o retorno de `fetch` da Cloudflare e os três desfechos | já tem suíte; conversão de baixo risco, boa para abrir a fase 5 |
| `src/index.js` → `.ts` + shim `.js` transitório | tipar os 6 handlers Socket.IO e os 3 endpoints Express | §3.6 |
| `dist/` | **novo** artefato (ignorado pelo git — o `.gitignore` já tem `dist/`) | item 10 do DoD |
| `package.json` | `main`/`start` → `dist/index.js`; scripts `build`, `typecheck`, `lint`; devDeps `typescript`, `@types/node`, `@types/express`, `@types/cors`, eslint 9, typescript-eslint | itens 9 e 10 do DoD |
| `eslint.config.js` | **novo** | item 9 do DoD |
| `Dockerfile` | multi-stage: builder com devDeps + `tsc`, runner com `--omit=dev` e `dist/` | item 11 do DoD |
| `test/turnCredentials.test.mjs`, `test/fixtures/stubCloudflare.mjs` | intocados nas fases 1–6; `.ts` na fase 7 | itens 5 e 6 do DoD |

### 4.4 `e2e/`

| Componente | O que muda | Por quê |
|---|---|---|
| `harness.mjs` → `harness.ts` | `startSignaling` passa a subir `dist/index.js`; novo `buildServer()` espelhando `buildClient()`; tipos do Playwright | §3.5 e §3.12 |
| `run.mjs` → `run.ts` | conversão literal; nenhuma checagem alterada | item 7 do DoD |
| `package.json` | `test` → `node run.ts`; devDep `typescript`; script `typecheck` | §3.12 |
| `tsconfig.json` | **novo**, com `allowImportingTsExtensions` + `noEmit` | §3.12 |

---

## 5. Contratos de Interface

Não há endpoint REST novo, evento de tempo real novo nem schema de banco (o projeto não
tem persistência — `ARCHITECTURE.md` §5). Os contratos desta entrega são de **ferramental**.

### 5.1 Scripts npm por pacote (estado final)

| Pacote | Script | Contrato |
|---|---|---|
| client | `dev` / `preview` | inalterados |
| client | `build` | `vite build` — inalterado; **não** roda `tsc` (o typecheck é portão separado, para o build do E2E não ficar 40s mais lento) |
| client | `typecheck` | **novo** — `tsc --noEmit`; 0 erros |
| client | `test` | `node --import ../tools/registerTs.mjs --test "test/*.test.ts"` (nas fases 2–6, ainda `"test/*.test.mjs"`) |
| client | `lint` | `eslint .` com flat config; cobre `.ts`/`.tsx`; 0 erros **e 0 warnings** |
| server | `build` | **novo** — `tsc`; produz `dist/` executável por `node dist/index.js` |
| server | `start` | `node dist/index.js` |
| server | `dev` | `node --watch --import ../tools/registerTs.mjs src/index.ts` |
| server | `typecheck` / `lint` | **novos** |
| e2e | `test` | `node run.ts` |
| e2e | `typecheck` | **novo** |

> O `prestart` do server **não** deve rodar `build`: o container já builda na imagem, e um
> rebuild no boot mascara imagem mal construída.

### 5.2 Contrato dos hooks de módulo (`tools/tsLoader.mjs`)

| Hook | Entrada | Saída | Observações |
|---|---|---|---|
| `resolve` | especificador terminado em `.js` ou `.jsx` que não existe em disco | mesma URL com `.ts` (ou `.tsx`) | tenta `.ts` primeiro, `.tsx` depois; se nenhum existir, delega ao `nextResolve` **sem engolir o erro original** |
| `resolve` | qualquer outro | delega | inclui bare specifiers — o hook nunca resolve pacote |
| `load` | URL terminada em `.tsx` | módulo ESM transformado por esbuild (`loader: 'tsx'`, `jsx: 'automatic'`, `format: 'esm'`, `sourcefile` preservado) | `shortCircuit: true` |
| `load` | URL terminada em `.ts` | **delega** | type stripping nativo do Node; uma engrenagem a menos |

Invariantes: (a) o hook **não** faz typecheck — o portão de tipos é `npm run typecheck`,
e misturar os dois faria o `npm test` ficar lento e vermelho por motivo errado; (b) o
esbuild é resolvido de forma preguiçosa a partir de `client/`, para o hook servir a
`server`/`e2e` sem esbuild instalado; (c) o hook encadeia com os hooks já registrados por
`register()` dentro dos testes — os 5 testes que registram `jsxLoader.mjs` continuam
funcionando sem alteração.

### 5.3 Flags de `tsconfig` (contrato de rigor)

| Flag | Valor | Onde | Por quê |
|---|---|---|---|
| `strict` | `true` | base | é o pedido da task, puro, sem afrouxar sub-flags |
| `isolatedModules` | `true` | base | esbuild e o Node transpilam arquivo a arquivo; sem isso, construções válidas para o `tsc` quebram em runtime |
| `verbatimModuleSyntax` | `true` | base | obriga `import type` explícito — é o que impede o esbuild de manter um import que só existia para tipos (efeito colateral em runtime) |
| `erasableSyntaxOnly` | `true` | base | proíbe `enum`, `namespace` e parameter properties, que o type stripping do Node não suporta. Garante que o fonte roda direto |
| `noUnusedLocals` / `noUnusedParameters` | `true` | base | o `.eslintrc` atual já é rígido com `no-unused-vars`; manter a paridade |
| `noFallthroughCasesInSwitch` | `true` | base | boring, custo zero |
| `skipLibCheck` | `true` | base | `@types` de terceiros não são responsabilidade desta entrega |
| `noEmit` | `true` | client, e2e | Vite/Node cuidam |
| `outDir` + `declaration: false` | `dist` | server | item 10 do DoD; ninguém consome o server como lib |
| `moduleResolution` | `Bundler` (client) / `NodeNext` (server) / `Bundler`+`allowImportingTsExtensions` (e2e) | por pacote | cada runtime resolve de um jeito |
| `jsx` | `react-jsx` | client | o projeto já usa o runtime automático (`plugin:react/jsx-runtime`) |
| `lib` | `["ES2023","DOM","DOM.Iterable"]` | client | `DOM.Iterable` é necessário para `for..of` em `NodeList`/`MediaStream` |
| `types` | `["node","vite/client"]` | client | `vite/client` dá `import.meta.env` e `declare module '*?url'` |

**Não habilitar** nesta entrega: `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
`useUnknownInCatchVariables` além do que `strict` já traz. Registrar no `ARCHITECTURE.md`
como próximo degrau.

### 5.4 Declarações ambiente (as bordas onde `any`/cast são permitidos)

| Arquivo | Declara | Módulos que dependem |
|---|---|---|
| `client/src/types/webrtc-encoded.d.ts` | `RTCRtpSender.createEncodedStreams` / `RTCRtpReceiver.createEncodedStreams`, `RTCEncodedVideoFrame`/`RTCEncodedAudioFrame` (`type`, `data`, `getMetadata`), e `encodedInsertableStreams` em `RTCConfiguration` | `lib/e2ee.ts`, `lib/webrtcMesh.ts` |
| `client/src/types/audioworklet.d.ts` | `AudioWorkletProcessor`, `registerProcessor`, `sampleRate`, `currentTime` no escopo global do worklet | `lib/noiseSuppressorWorklet.ts` |
| `client/src/types/browser-gaps.d.ts` | `Window.webkitAudioContext`; `HTMLMediaElement.setSinkId`/`sinkId` **se** ausentes da `lib.dom` da versão de TS escolhida (conferir antes de declarar — declarar o que já existe gera conflito); `Window.YT` e `Window.onYouTubeIframeAPIReady` | `lib/audioContext.ts`, `lib/audibleMedia.ts`, `components/PeerAudio.tsx`, `components/RemoteMusicAudio.tsx`, `lib/youtubePlayer.ts` |
| `client/src/vite-env.d.ts` | `/// <reference types="vite/client" />` + `ImportMetaEnv` com `VITE_SIGNALING_URL` e `VITE_ENABLE_YOUTUBE` | `config.ts`, `lib/youtubePlayer.ts` |

Regra do §3.9: **toda** linha desses arquivos leva um comentário de uma linha dizendo qual
API não está na `lib.dom` e por quê. É esse comentário que o item 12 do DoD cobra.

### 5.5 Tipos de domínio (onde eles moram)

- **Não** criar um `types.ts` central com tudo. Cada módulo exporta os tipos que ele
  define, do lado da função que os produz — é a convenção que o código já segue em espírito
  (o JSDoc de `audibleMedia.js` documenta `params` junto da função).
- Os tipos compartilhados **de fato** são poucos e devem sair do módulo que é a fonte da
  verdade daquele dado:

| Tipo | Módulo dono | Consumidores principais |
|---|---|---|
| `Participant` (a forma de `DEFAULT_PARTICIPANT`) | `pages/Room.tsx` | `VideoTile`, `VideoGrid`, `SpotlightStage`, `ThumbnailRail` |
| Mensagens do protocolo de sinalização (`join-request`, `join-approved`, `join-denied`, `peer-joined`, `peer-left`, `signal`, `join-request-cancelled`) | `lib/signaling.ts` no client e `src/index.ts` no server | **duas** declarações independentes, uma por pacote |
| Mensagens do protocolo de música | `lib/musicProtocol.ts` | `useMusicRoom`, `musicSession`, `webrtcMesh` |
| Preferências de dispositivo e de áudio | `lib/devices.ts`, `lib/noiseSuppression.ts` | `Room`, `SettingsModal`, `PreJoin` |

> **Decisão explícita: não criar pacote compartilhado de tipos entre client e server.** Os
> dois lados declaram o protocolo separadamente. Um pacote compartilhado exigiria workspace
> (rejeitado no §3.7) e acoplaria dois artefatos que hoje sobem em imagens diferentes. O
> custo — duas declarações que podem divergir — é mitigado pelos testes de caracterização da
> fase 1, que exercitam o protocolo dos dois lados.

---

## 6. Dependências e Ordem de Implementação

### Fase 0 — Linha de base (bloqueante, não pular)

1. `npm install` em `client/`, `server/` **e** `e2e/` — o `node_modules` não persiste neste
   ambiente, e uma suíte vermelha por dependência ausente é lida como regressão.
2. `npm test` em client e server; **registrar os números exatos** (a referência do DoD é
   336 no client). Conferir se `kill('SIGKILL')` já está nesta branch em
   `joinRequestSignaling.test.mjs`, `roomOccupancy.test.mjs` e `harness.mjs` — sem isso a
   suíte trava com todos os casos verdes.
3. `node e2e/run.mjs` uma vez, **em série** (nunca em paralelo com outra coisa pesada), com
   saída redirecionada para arquivo. Esperado: 111/112, única falha F4a.
4. Commitar nada. Registrar os números no arquivo de progresso.

### Fase 1 — Rede de segurança (§3.1) · **em JavaScript, sobre o código JavaScript**

Pode ser paralelizada em três frentes independentes (arquivos distintos, sem sobreposição).
Inventário mínimo — cada linha é um comportamento hoje sem teste unitário:

**1a. `server/test/rooms.test.mjs`** (novo): sala nasce vazia; `isFull` só a partir de 6;
`removeMember` do último **apaga a sala** (`findRoomOf` volta `null` e o `Map` encolhe);
`members` devolve pares na ordem de inserção; `findRoomOf` de socket desconhecido é `null`;
`ensureRoom` é idempotente.

**1b. `server/test/signaling.test.mjs`** (novo, sobe o server real numa porta sorteada e usa
`socket.io-client`, espelhando o padrão que `client/test/joinRequestSignaling.test.mjs` já
usa — inclusive o `SIGKILL`):

- primeiro a entrar é admitido **sem aprovação** e recebe `join-approved` com `selfId`,
  `members: []` e `maxParticipants: 6`;
- segundo a entrar dispara `join-request` para **todos** os membros, com `requesterId` e
  `displayName` sanitizado;
- `displayName` não-string, vazio ou só espaço vira `'Guest'`; string longa é truncada em 40;
- `roomId` inválido (não-string ou vazio) → `join-denied { reason: 'invalid-room' }`;
- sala com 6 → `join-denied { reason: 'room-full' }`;
- `approve-join` de quem **não está na sala do pedido** é ignorado silenciosamente (é a
  defesa contra aprovação forjada);
- `deny-join` → `join-denied { reason: 'denied' }` no requisitante **e**
  `join-request-cancelled` nos demais;
- requisitante que desconecta enquanto espera → `join-request-cancelled` em todos, sem
  `join-denied`;
- `signal` só é retransmitido **dentro da mesma sala**; `to` inexistente ou de outra sala é
  descartado sem erro; o payload chega com `from` preenchido;
- `leave-room` e `disconnect` emitem `peer-left` uma vez para os que ficam;
- `/health` responde `{ ok: true, turn: { configured } }`; `/rooms/:id/occupancy` responde
  `{ occupied }` e **nada além disso**.

**1c. `client/test/webrtcMeshContract.test.mjs`** (novo; complementa `meshRecovery`,
`musicMeshRouting` e `joinCameraDefault`, que já existem): ordem e quantidade de
transceivers criados na entrada (contrato do §6.1 do `ARCHITECTURE.md`); `iceTransportPolicy:
'relay'` presente em **toda** `RTCPeerConnection` criada; lista de ICE servers vazia não
lança e leva a `onPeerStateChange(peerId, 'failed')`; `close()` fecha todas as conexões e
para todos os tracks; peer desconhecido em `signal` não cria conexão órfã.

**1d. `client/test/roomPhases.test.mjs`** (novo; o mais caro e o mais valioso): renderiza
`Room` com o dispatcher próprio já usado em `musicRoomPlayerError.test.mjs` e com os
módulos de efeito colateral substituídos (`mock.module` do `node:test`, que exige
`--experimental-test-module-mocks` no script `test` — `package.json` **não** é arquivo de
teste, então mexer nele não fere o item 6 do DoD). Comportamentos a caracterizar:

- path que não é sala (`/a/b`, `/!!!`) → `navigate('/', { replace: true })`;
- path não canônico (`/Daily`) → redirect para `/daily` preservando o `hash`;
- path sem `#` → redirect com passphrase gerada, **sempre `replace`** (um `push` gera laço
  no botão Voltar — está documentado no comentário do arquivo);
- enquanto `redirectPending`, **nenhum** `getUserMedia` e **nenhuma** socket;
- `PHASE`: `connecting` → `waiting-approval` no `join-request` pendente → `in-call` no
  `join-approved` → `denied` no `join-denied`, com `denyReason` propagado;
- todo participante novo nasce com a forma de `DEFAULT_PARTICIPANT` — nos **três** pontos
  que criam registro (loop de `members`, `peer-joined`, `onRemoteStream` de peer
  desconhecido);
- desmontar a sala para tracks locais, fecha socket, fecha mesh e limpa os timers de toast.

> Se a substituição de módulos se mostrar frágil, o recuo aceitável é caracterizar
> `1d` **só** pela camada de redirect e pela máquina de `PHASE`, e declarar no arquivo de
> progresso que o resto do `Room` segue coberto apenas pelo E2E. O que **não** é aceitável é
> pular a fase 1 inteira do `Room`.

**Portão da fase 1:** as duas suítes verdes, com contagem maior que a linha de base, e
**commit** antes de qualquer renomeação. Este commit é o ponto de comparação de toda a
migração.

### Fase 2 — Ferramental (nenhum arquivo de fonte renomeado ainda)

Ordem interna importa:

5. `tsconfig.base.json` + `tsconfig.json` por pacote; `typescript` nas devDeps dos três.
6. `tools/tsLoader.mjs` + `tools/registerTs.mjs`; `--import` nos scripts `test`.
7. **Prova de fumaça obrigatória (§3.3):** converter **um** módulo folha (`lib/gridLayout.js`),
   e provar as três resoluções — `npm test` do client verde **sem tocar no teste**, `npm run
   build` com o módulo no bundle, `npx tsc --noEmit` limpo. Se falhar, parar e revisar
   este documento.
8. **Prova de fumaça do worklet (§3.10):** decidir caminho A ou B com evidência, não com
   suposição.
9. Declarações ambiente (§5.4) e `vite.config.js` → `.ts`.
10. Flat config de lint nos dois pacotes; remover `.eslintrc.json`; `npm run lint` verde
    ainda sobre `.js`/`.jsx`. Fazer isto **agora** dá feedback de lint em todas as fases
    seguintes.
11. `docker-compose.yml` com contexto na raiz + `.dockerignore`; `docker compose build`
    verde ainda sobre JavaScript.

### Fase 3 — `client/src/lib/` (25 módulos, folhas primeiro)

12. **Folhas** (nenhum import relativo — podem ir em paralelo): `gridLayout`, `musicVote`,
    `roomSlug`, `chat`, `audioContext`, `peerConnectionStatus`, `noiseSuppression`,
    `noiseSuppressorWorklet`, `devices`, `iceServers`, `audioLevels`, `e2ee`,
    `musicSources`, `musicEngine`, `youtubePlayer`, `audibleMedia`.
13. **Um nível acima:** `musicSession`, `spotlightLayout`, `roomRouting`, `signaling`.
14. **Dois níveis:** `musicProtocol`, `micPipeline`.
15. **Últimos, e um de cada vez:** `webrtcMesh` (1067 l.), `useMusicRoom` (1295 l.).
16. `config.js` → `config.ts`.

Portão a cada passo: `npm test` do client verde **sem tocar em teste algum** e `npx tsc
--noEmit` limpo. Commitar por grupo, não por arquivo solto.

### Fase 4 — `client/src/components/` e `src/pages/`

17. Componentes folha: `JoinRequestModal`, `Toasts`, `VideoTile`.
18. Um import: `ChatPanel`, `MusicPanel`, `MusicVoteCard`, `PeerAudio`, `RemoteMusicAudio`.
19. Dois: `PreJoin`, `SettingsModal`, `ThumbnailRail`, `VideoGrid`.
20. `SpotlightStage`; `pages/LegacyRoomRedirect`; `App`; `main` **+ `index.html`**.
21. `pages/Home.tsx`.
22. `pages/Room.tsx` — **sozinho, no próprio commit**, com a rede da fase 1d ativa.

### Fase 5 — `server/`

23. `rooms.ts` → `turnCredentials.ts` → `index.ts` (nesta ordem: dependência).
24. **Shim `src/index.js`** (§3.6) no mesmo commit de `index.ts`.
25. `npm run build` + `node dist/index.js` sobem; `Dockerfile` multi-stage.

### Fase 6 — `e2e/`

26. `harness.ts` (com `buildServer()` e `startSignaling` apontando para `dist/`), depois
    `run.ts`.
27. `node e2e/run.ts` em série: **111/112, só a F4a**.

### Fase 7 — Testes para TypeScript (a fase final)

28. 29 `.test.mjs` do client + `turnCredentials.test.mjs` + `fixtures/stubCloudflare.mjs`
    → `.ts`. Conversão mecânica: os `await import('...')` continuam funcionando pelo hook.
29. Remover os `register('./jsxLoader.mjs')` (o hook global cobre); apagar
    `client/test/jsxLoader.mjs`; mover `viteUrlLoader.mjs` para `tools/`.
30. **Apagar o shim `server/src/index.js`** e reapontar `joinRequestSignaling` e
    `roomOccupancy` para o entry TypeScript com `--import` nos argumentos do `spawn`.
31. Glob dos scripts `test` → `"test/*.test.ts"`.
32. Apagar `client/probe4.mjs` (§9.5).

### Fase 8 — Fechamento

33. `npm run typecheck`, `lint`, `test` nos três pacotes; `npm run build` no client e no
    server; `docker compose build`; `node e2e/run.ts` uma última vez.
34. `ARCHITECTURE.md` §7/§8, `README.md`, `docs/progress/WTK-MEET-20.md`.
35. Registrar no board (`add_task_log`) a evidência item a item do DoD — o `checked` não é
    gravável pela API.

**Paralelizável:** fase 1 (1a/1b × 1c × 1d), o passo 12 inteiro, os passos 17–19.
**Estritamente serial:** 5→6→7→8, 15, 22, 23→24, 26→27 e a fase 7 inteira.

---

## 7. Riscos e Armadilhas

### 7.1 O worklet de supressão de ruído entregue como TypeScript ao browser

- **Risco:** `?url` entrega o arquivo cru; TypeScript no `AudioWorkletGlobalScope` é
  `SyntaxError` no `addModule`.
- **Mitigação:** §3.10 — decidir A ou B com prova, na fase 2, antes de converter o arquivo.
- **Anti-pattern a evitar:** concluir "funcionou" porque o E2E passou. `micPipeline` engole
  a falha do `addModule` em `console.warn` + `passthrough` **de propósito**. O único sinal
  confiável é a checagem **T8** (RMS ≥ 6 dB menor com supressão ligada) e a **T3** (o mesh
  transmite o track processado). Se T8 passar e T3 passar, o worklet carregou.

### 7.2 Os dois testes do client que sobem o server por caminho literal

- **Risco:** `client/test/joinRequestSignaling.test.mjs:28` e
  `client/test/roomOccupancy.test.mjs:22` fazem `spawn` de
  `../../server/src/index.js`. O processo filho é novo: hook do pai não atravessa. Converter
  o server quebra os dois, e o item 6 do DoD proíbe editá-los naquele momento.
- **Mitigação:** o shim do §3.6.
- **Anti-pattern a evitar:** "resolver" via `NODE_OPTIONS` herdado pelo `spawn`, apostando
  que o hook de `resolve` intercepta o entry point do processo. É comportamento não
  garantido; quando falha, falha como "servidor não sobe" e leva a caçar porta e firewall.

### 7.3 `docker compose build` quebrando por `extends` fora do contexto

- **Risco:** contextos `./client` e `./server` não enxergam `../tsconfig.base.json`. O
  sintoma é confuso: o `tsc` do server falha com "File not found", e o `vite build` do
  client pode **silenciosamente** ignorar o tsconfig e mudar o alvo de transpilação.
- **Mitigação:** contexto na raiz com `dockerfile:` explícito + `.dockerignore` (§3.7),
  provado ainda na fase 2, sobre JavaScript.
- **Anti-pattern a evitar:** copiar o `tsconfig.base.json` para dentro de cada pacote "só
  para o Docker". Duas cópias de `strict` derivam, e é exatamente o que o §3.7 evita.

### 7.4 `setTimeout` tipado como `number`

- **Risco:** com `@types/node` + `DOM` no mesmo programa (§3.8), `setTimeout` devolve
  `NodeJS.Timeout`. Anotar `number` gera erro; e "resolver" com `as unknown as number`
  planta um cast falso em código puro, ferindo o item 12 do DoD.
- **Mitigação:** regra do projeto — `ReturnType<typeof setTimeout>`, sempre. Vale para
  `Room.tsx`, `audioLevels.ts`, `musicSession.ts`, `youtubePlayer.ts`, `iceServers.ts`.
- **Anti-pattern a evitar:** `window.setTimeout` só para ganhar `number` — muda o objeto
  chamado e quebra os módulos que rodam em `node:test` sem DOM.

### 7.5 A tentação de corrigir bugs que a tipagem revela

- **Risco:** `strict: true` sobre 11 mil linhas vai encontrar defeitos reais. Corrigi-los
  aqui torna impossível atribuir uma regressão.
- **Mitigação:** preservar o comportamento, marcar `// TODO(WTK-MEET-XX)`, registrar no
  arquivo de progresso e abrir card. Se o comportamento atual for **impossível** de tipar
  sem mudar, o menor movimento honesto é um `as` com comentário — não uma correção.
- **Anti-pattern a evitar:** "já que estou aqui, extraio essa função". O `Room.tsx` sai
  desta migração com 1600 linhas.

### 7.6 O E2E como falso portão

- **Risco:** o E2E leva ~10 min, tem passos intermitentes por temporização (a D "mesh
  reconectado após reload" e a B3 de `requestAnimationFrame`) e **duas rodadas simultâneas
  derrubam o `node-turn`**, produzindo um sintoma idêntico ao de uma regressão de
  negociação (`conn: failed` em tudo).
- **Mitigação:** rodar sempre em série e nunca em paralelo com build ou com outra sessão;
  antes de investigar uma falha, rodar de novo; para descartar regressão de verdade,
  comparar com o merge-base (receita validada em `claude-progress.md` e em
  `docs/progress/`). Lembrar de symlinkar **três** `node_modules` (client, e2e **e
  server**) no worktree de comparação.
- **Anti-pattern a evitar:** tratar 110/112 como "quase igual". A F4a é a **única** falha
  aceita, e por ser regressão pré-existente conhecida.

### 7.7 `verbatimModuleSyntax` e imports de tipo que somem (ou não somem)

- **Risco:** com transpilação arquivo a arquivo (esbuild e type stripping), um import usado
  só como tipo pode permanecer no bundle (efeito colateral de módulo) ou um import de valor
  pode ser removido.
- **Mitigação:** `verbatimModuleSyntax: true` + `isolatedModules: true` no base (§5.3), e a
  regra de sempre escrever `import type` para tipos. Isso transforma o problema de runtime
  em erro de compilação.
- **Anti-pattern a evitar:** desligar `verbatimModuleSyntax` porque "dá muito erro". O erro
  é o produto.

### 7.8 `git mv` perdido e histórico apagado

- **Risco:** renomear criando arquivo novo destrói o `git log --follow` de arquivos cujos
  comentários são a documentação de decisão do projeto.
- **Mitigação:** §3.2; conferir com `git log --follow --oneline` em `Room`, `webrtcMesh` e
  `micPipeline` ao fim da fase 4.
- **Anti-pattern a evitar:** commit único gigante "migra client para TS".

### 7.9 Auto-commit do harness publicando estado intermediário

- **Risco:** o orquestrador pode fotografar a árvore no meio de uma edição (o
  `chore: sync changes before opening PR` já publicou código quebrado neste projeto), e o
  worktree pode ser removido no meio da sessão com tudo que não foi commitado.
- **Mitigação:** commitar cedo e por grupo pequeno; nunca deixar uma fase de conversão pela
  metade na árvore ao fim de um bloco de trabalho; `node --check` (ou `tsc --noEmit`) antes
  de cada commit.
- **Anti-pattern a evitar:** `git add -A` / `git commit -a` — se outra sessão estiver no
  mesmo worktree, publica o trabalho pela metade dela. `git add <arquivo>` explícito.

### 7.10 Duas sessões na mesma task e no mesmo worktree

- **Risco:** o projeto já teve sobrescrita direta de `Room.jsx`, `App.jsx` e
  `musicSession.js` por sessões concorrentes; `ListAgents` no início **não** garante nada,
  porque o peer costuma chegar depois.
- **Mitigação:** `ListAgents` antes da primeira escrita **e de novo** durante; no mesmo
  worktree, dividir por **artefato desacoplado** (nesta task o corte natural é: fase 1c/1d
  × fase 1a/1b × documentação), nunca por `src` × `test`, porque aqui os testes são a rede
  de segurança do código que o outro está convertendo. Revisor sem permissão de escrita é a
  única fatia que escala para três sessões.
- **Anti-pattern a evitar:** planejar a entrega contando com o que o peer prometeu — as
  sessões somem no meio. O que não estiver escrito na mensagem ou no commit morre com ela.

### 7.11 `index.html` apontando para `main.jsx`

- **Risco:** trivial e caro: o `vite build` **não** falha de forma óbvia, e o app abre em
  branco. Estraga um E2E inteiro (10 min) por uma linha.
- **Mitigação:** o passo 20 trata `main.tsx` e `index.html` como um movimento só.

---

## 8. Critérios de Aceite Técnicos

Numerados para bater um a um com o DoD do board (o mapeamento está no §9.2).

1. `npx tsc --noEmit` fecha com **0 erros** em `client/`, `server/` e `e2e/`, os três com
   `strict: true` efetivo (verificável por `npx tsc --showConfig`).
2. Não resta nenhum `.js`/`.jsx`/`.mjs` de fonte ou de teste em `client/src/`,
   `client/test/`, `server/src/`, `server/test/` e `e2e/`. Exceções permitidas e apenas
   estas: `eslint.config.js` (por pacote) e os hooks de módulo em `tools/`. Se o caminho B
   do §3.10 for necessário, `client/src/lib/noiseSuppressorWorklet.js` é a **única**
   exceção adicional, declarada.
3. Existe um commit — anterior a toda renomeação — em que `git show --stat` mostra apenas
   arquivos de teste novos, e em que as duas suítes passam com contagem **maior** que a da
   fase 0.
4. `npm test` no client passa com **≥ 336** casos mais os novos da fase 1, sem `skip` novo e
   sem nenhum teste removido.
5. `npm test` no server passa cobrindo `turnCredentials` (suíte existente, intocada em
   comportamento) + `rooms` + sinalização.
6. `git diff --stat <commit-fim-fase-1>..<commit-fim-fase-6> -- client/test server/test`
   não mostra alteração em nenhum dos 30 arquivos de teste (mudança em `jsxLoader.mjs` /
   `viteUrlLoader.mjs` é permitida e não conta — não são testes).
7. `node e2e/run.ts` fecha em **111/112**, sendo a única falha a F4a. Nenhuma checagem nova
   quebrada, nenhuma removida, nenhum `console` error novo (checagem G).
8. `npm run lint` no client cobre `.ts`/`.tsx` via flat config e fecha com **0 erros e 0
   warnings**; `.eslintrc.json` não existe mais.
9. `npm run lint` no server existe e fecha com 0 erros.
10. `npm run build` no client gera o bundle sem erro; `npm run build` no server gera `dist/`
    e `node dist/index.js` sobe, responde `/health` com `{ ok: true, turn: { configured } }`
    e loga o aviso de TURN quando as variáveis faltam.
11. `docker compose build` sobe as duas imagens sem nenhum ajuste manual.
12. Nenhum `any`, `as` de contorno ou `@ts-expect-error` sem comentário de uma linha
    justificando a lacuna da lib; **nenhum** deles em `musicVote`, fila de música
    (`musicSession`), `gridLayout`, `spotlightLayout`, `roomSlug`, `roomRouting`,
    `musicProtocol` (verificável por `grep`).
13. `ARCHITECTURE.md` §7 registra a decisão como **revertida**, com data e motivo,
    preservando o texto original como histórico; §8 lista `tools/` e os `tsconfig`;
    `README.md` documenta `typecheck`, o build do server e **Node >= 22.18**.
14. `docs/progress/WTK-MEET-20.md` existe e registra: números da linha de base, o que a
    fase 1 cobriu (e o que deliberadamente não cobriu), o caminho escolhido no §3.10, cada
    bug encontrado-e-não-corrigido, o destino do `probe4.mjs` e a deriva entre
    `docs/architecture.md` §8 e a estrutura real de diretórios.
15. **Comportamento inalterado:** nenhum arquivo de teste existente teve sua *asserção*
    modificada em nenhuma fase; a conversão da fase 7 é sintática.

---

## 9. Notas para os Agentes de Implementação

### 9.1 Divisão de trabalho sugerida

- **Um agente único é o padrão.** `Room.tsx` e `webrtcMesh.ts` precisam de dono único — é a
  mesma conclusão que o documento da WTK-MEET-18 já tinha registrado, e vale aqui com mais
  força ainda porque a fase 3 muda todos os módulos que o `Room` importa.
- Se houver segundo agente, o corte que funciona nesta task é: **agente A** = fase 1a/1b
  (server) + fase 5; **agente B** = fase 1c/1d (client) + fases 3/4. As fases 2, 6, 7 e 8
  são de dono único, sempre.
- Antes da primeira escrita: `ListAgents`. Depois, de novo.

### 9.2 Mapa DoD do board → critérios deste documento

Itens 1–14 do DoD ↔ critérios 1–14 do §8, na mesma ordem. O critério 15 é adicional deste
documento (a garantia de que a migração não mudou comportamento). **Não há conflito entre o
DoD e este documento** — é a segunda task do projeto em que isso acontece.

### 9.3 Ordem de validação após cada fase

```
npx tsc --noEmit          (rápido; primeiro portão)
npm test                  (client e server; a rede de segurança)
npm run lint              (a partir da fase 2)
npm run build             (só nas fases 4, 5 e 8)
node e2e/run.ts           (só nas fases 6 e 8 — em série, saída para arquivo)
```

### 9.4 Divergências entre o escopo do board e este documento (declarar, não esconder)

1. **`docker-compose.yml` não está no escopo declarado**, mas o item 11 do DoD o exige
   (§3.7/§7.3). Vai ser tocado.
2. **`.dockerignore` é arquivo novo** não previsto no escopo. Consequência direta de (1).
3. **`eslint.config.js` aparece no escopo no singular, no grupo da raiz**; a decisão é ter
   **um por pacote** (§3.11), porque flat config resolve plugins a partir do diretório do
   próprio config e o §3.7 decidiu não ter `node_modules` na raiz.
4. **`tools/tsLoader.mjs` ganha um companheiro**, `tools/registerTs.mjs` — exigência
   mecânica da flag `--import`.
5. **O escopo diz "29 arquivos `.test.mjs`"**; a contagem em disco é 29 `.test.mjs` + 2
   hooks (`jsxLoader.mjs`, `viteUrlLoader.mjs`), e os 2 hooks não são testes: podem ser
   alterados sem ferir o item 6.
6. **Shim transitório `server/src/index.js`** (§3.6): existe entre as fases 5 e 7. Quem
   olhar o repo no meio da migração vai ver um `.js` em `server/src/` — é intencional, e o
   critério 2 só vale no estado final.

### 9.5 `client/probe4.mjs`

Script de sondagem de 15 linhas, na raiz do client, que sobe o server e imprime
`process._getActiveHandles()`. Não é importado por ninguém, não está em nenhum script de
`package.json`, usa API interna do Node e aponta para `../server/src/index.js` (que some na
fase 7). Era instrumento de diagnóstico do bug de `SIGTERM` documentado no
`claude-progress.md`. **Recomendação: apagar na fase 7 e registrar no arquivo de
progresso.** Se houver preferência por mantê-lo, ele vira `probe4.ts` e passa a ser
compilado — o que significa tipar `process._getActiveHandles`, uma API sem tipos, com um
`any` justificado. O custo não compensa; a decisão final é de quem revisa.

### 9.6 Pitfalls desta demanda que não estão na documentação geral

- Confirmar `kill('SIGKILL')` nesta branch antes de acusar a suíte de estar quebrada: o
  sintoma de `SIGTERM` não entregue é `Promise resolution is still pending...` com **todos**
  os casos verdes e ~57s de duração.
- O `node_modules` **não persiste** entre sessões neste ambiente. `npm install` nos três
  pacotes é o passo 1 de qualquer verificação — uma suíte vermelha por dependência ausente
  não é linha de base.
- Ao rodar o E2E, redirecionar a saída para **arquivo** com `>`. Um `| tail` segura tudo até
  o EOF e faz o processo parecer travado.
- O `checked` dos itens de DoD **não é gravável** pela API do board, e o
  `definitionOfDone` é imutável depois da criação. A evidência item a item vai em
  `add_task_log`.
- Antes de qualquer `move_task_forward`: **conferir a coluna**. A partir de *Code Review* o
  avanço leva a *Done*, e Code Review é o portão humano — não avançar de lá por conta
  própria.

### 9.7 Primeiro agente a ser acionado

**Agente de desenvolvimento**, na **fase 0** (linha de base) e imediatamente na **fase 1**
(rede de segurança). Nenhum `git mv` antes de a fase 1 estar commitada e verde.

---

## 10. Trabalho futuro registrado (não fazer nesta entrega)

- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` e
  `noPropertyAccessFromIndexSignature` — cada um exige mudança de código real.
- Type-aware linting (`projectService` do typescript-eslint).
- Project references no client (`tsconfig.app` / `tsconfig.test` / `tsconfig.node`),
  separando globais de Node do código de browser.
- Tipos de protocolo compartilhados entre client e server (exige decidir workspace).
- Fechar o outro eixo da deriva com `docs/architecture.md` §8: estrutura `apps/web` +
  `signaling-server` e store tipada.
