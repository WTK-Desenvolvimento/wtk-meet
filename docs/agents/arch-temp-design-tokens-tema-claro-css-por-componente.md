# Design tokens, tema claro/escuro alternável e CSS por componente — Documento de Arquitetura Técnica

> Gerado em: 2026-08-31
> Status: Rascunho
> Task: WTK-MEET-22 — Reformular o design do client

---

## 0. Premissa assumida (e a contradição no pedido)

A resposta de acessibilidade marcou **as três exigências** (mobile, foco visível, contraste AA)
**e também** "Nada disso agora", que é excludente. Este documento assume as três exigências como
escopo e trata "Nada disso agora" como marcação acidental — é a leitura que entrega mais e a que
não desperdiça a passada de design (mexer em toda a paleta e depois voltar para arrumar contraste
custa duas vezes).

**Se a intenção era o contrário**, as fases 5 e 6 (§6) saem inteiras e o resto do plano fica
idêntico: tokens, quebra do CSS e tema claro não dependem delas. Nesse caso o §8 perde os critérios
A1–A7 e o §7 perde os riscos R7 e R8. Decisão do Nicolas — não bloqueia o início.

---

## 1. Contexto e Objetivo

### Problema atual

`packages/client/src/styles.css` tem **1371 linhas** e é o único arquivo de estilo do produto
(`main.tsx:5` é o único `import` de CSS que existe). Consequências mensuradas neste repositório:

- **Base de design inexistente.** O `:root` tem 8 variáveis, todas de cor (`--bg`, `--surface`,
  `--border`, `--text`, `--muted-text`, `--accent`, `--danger`, `--warning`). Não há escala de
  espaçamento, de raio, de sombra nem de tipografia — cada regra escolhe `0.35rem`, `0.6rem`,
  `0.85rem`, `1.25rem` por conta própria, e há **três** raios diferentes (`4px`, `5px`, `6px`,
  `8px`, `12px`, `999px`) sem critério registrado.
- **Cor crua espalhada.** Fora do `:root` existem cores literais que nenhum token controla:
  `rgba(202,165,61,·)` (avisos, 4 ocorrências), `rgba(79,124,255,·)` (halo de fala, item atual da
  fila, voto escolhido), `rgba(0,0,0,0.55/0.6)` (rótulo e chip de conexão sobre vídeo),
  `rgba(15,17,21,0.94)` (painel de participantes), `rgba(26,29,36,0.9)` (botão de participantes),
  `#000` (letterbox), sombras em `rgba(0,0,0,0.35/0.45/0.5)`, e dois *fallbacks* mortos ou errados:
  `var(--card-bg, #23272e)` (token que **não existe**) e `var(--accent, #5b8def)` (fallback que
  **não é** o `--accent` real, `#4f7cff`).
- **`color-scheme: dark` fixo.** Não existe tema claro. Widgets nativos (o `<select>` do modal, o
  `input[type=range]` do volume, o checkbox do lobby com `accent-color`, a barra de rolagem
  `scrollbar-width: thin` da coluna de miniaturas) seguem esse valor — é ele que os deixa legíveis
  hoje, e qualquer mexida precisa mantê-lo coerente com o tema em vigor.
- **Um único breakpoint (`max-width: 720px`)** que trata simultaneamente o padding da sala, a
  direção do palco e a largura dos painéis. Entre 390px e 720px não há nada.
- **Contraste AA reprovado em quatro pontos** (medidos hoje, tema escuro):

  | Par | Razão | Onde | Exige |
  |---|---|---|---|
  | branco sobre `--accent` | **3.71** | `button.primary`, `.badge`, `.tile-badge` | 4.5 (texto pequeno) |
  | branco sobre `--danger` | **3.91** | `button.leave` ("Sair") | 4.5 |
  | `--border` sobre `--surface` | **1.24** | borda de `input`/`button`/`select` | 3.0 (WCAG 1.4.11) |
  | `--border` sobre `--bg` | **1.39** | idem | 3.0 |

  (O que **passa** hoje: `--text`/`--bg` 15.58, `--muted-text`/`--bg` 7.13, `--accent`/`--bg` 5.09,
  `--warning`/`--bg` 8.06, `--danger`/`--bg` 4.83. O `--accent`/`--surface` fica em **4.55** — passa
  por 0.05, o que é margem nenhuma e some ao primeiro ajuste de paleta.)
- **Foco visível só existe em um lugar** (`button.thumb-item:focus-visible`). Todo o resto depende
  do anel padrão do navegador, e o `div role="button" tabIndex={0}` da barra "Tocando agora"
  (`Room.tsx`) não tem indicação de foco nenhuma.

### Comportamento esperado após a entrega

- O estilo nasce de uma **base de tokens** em dois níveis (primitivos → semânticos); nenhuma cor
  literal sobra fora da camada de tokens, exceto a família explicitamente marcada como
  "sobre mídia" (§3.4).
- O CSS vive **um arquivo por componente**, importados em ordem explícita por um barril.
- A pessoa escolhe **Sistema / Claro / Escuro** em Configurações; a escolha persiste no navegador e
  é aplicada **antes do primeiro paint** (sem flash de tema errado).
- Home, PreJoin, sala, palco, tiles, painéis e modais passam por uma revisão visual coerente sobre
  os tokens.
- Nos dois temas: contraste AA em texto e 3:1 em borda de controle, foco visível em tudo que recebe
  foco, e o layout continua utilizável de 320px para cima.
- **Nada do que o E2E dirige muda**: nem classe, nem texto de botão, nem atributo ARIA, nem a
  contagem de `<select>` do modal de configurações.

### Vínculo com o produto

O produto é um link que se manda para alguém. A primeira coisa que essa pessoa vê é a Home ou o
lobby, e é ali que ela decide se confia o suficiente para ligar a câmera. O estilo não é enfeite
aqui: é a única credencial que o produto tem antes de funcionar. Tema claro e contraste AA também
são a diferença entre usável e não usável para quem está num notebook ao sol ou tem baixa visão.

---

## 2. Escopo

**Dentro do escopo:**

- Base de design tokens: primitivos, semânticos, escalas de espaçamento/raio/sombra/tipografia.
- Quebra de `src/styles.css` em `src/styles/*.css`, um arquivo por componente/página, com barril de
  ordem explícita.
- Tema claro completo + alternância manual (Sistema/Claro/Escuro) persistida em `localStorage`.
- Módulo puro de tema (`lib/theme.ts`) com testes em `node:test`, no padrão de `lib/devices.ts` e
  `lib/noiseSuppression.ts`.
- Script inline de aplicação de tema em `index.html` (anti-FOUC).
- Controle de tema no `SettingsModal`, como **grupo de rádio** (§3.6).
- Passada de design sobre Home, PreJoin, sala (fases `waiting`/`denied`/`in-call`), palco, grade,
  destaque, coluna de miniaturas, tiles, chat, player de música, card de votação, toasts e os dois
  modais.
- Foco visível global, contraste AA nos dois temas, e escala de breakpoints acima do único 720px.
- Ajuste do `<meta name="theme-color">` por tema (a barra do navegador em mobile).

**Fora do escopo:**

- **Qualquer renomeação de classe, texto de botão, placeholder, `role` ou `aria-*`.** É restrição
  dura (§3.9) — o E2E dirige a UI real por esses seletores.
- Mudança de estrutura de DOM que altere as relações que o E2E mede: `.chat-panel` irmão de
  `.video-stage` dentro de `.stage`, `.thumb-item` dentro de `.thumb-rail`, `.video-tile` dentro de
  `.spotlight-main`, `.peer-audio-sinks audio` montado e ativo, `.music-youtube-host` presente.
- Sinalização, mesh, E2EE, chat, player, protocolo do servidor. **Zero mudança em `packages/server`.**
- Framework de CSS (Tailwind), CSS Modules, CSS-in-JS, biblioteca de componentes (§3.1).
- Ícones, ilustrações, logo, fonte custom (mantém-se a pilha `system-ui`). Uma família custom
  significa self-hosting de arquivo de fonte e um orçamento de carregamento que esta entrega não vai
  medir.
- Animações e transições novas além das que já existem, salvo as que a passada de design exigir —
  e toda nova transição precisa entrar no bloco `prefers-reduced-motion` do seu arquivo (§7 R9).
- Tema por sala, tema por participante, sincronização de tema entre peers. O tema é **local e
  privado**: não vai para o fio, e nunca é conteúdo de chamada.
- Testes E2E novos. A suíte fecha exatamente com o mesmo conjunto de checagens; o que se prova aqui
  é que **nenhuma** delas regrediu. Checagens novas de contraste/foco viveriam melhor numa task
  própria de tooling (§9).

---

## 3. Decisões Arquiteturais

### 3.1 CSS por componente em arquivos simples, não CSS Modules nem utility-first

- **Decisão:** arquivos `.css` planos em `packages/client/src/styles/`, um por componente/página,
  com os mesmos seletores de classe que existem hoje.
- **Motivação:** os nomes de classe são **contrato público** com `packages/e2e` (§3.9). CSS Modules
  transforma `.chat-panel` em `.chat-panel_a3f9x` — a suíte inteira morre na primeira linha. É
  também a solução mais boring possível: nenhuma dependência nova, nenhum conceito novo, e o
  diff de cada arquivo é revisável isoladamente.
- **Alternativas descartadas:**
  - *CSS Modules / `:global` seletivo*: mantém o contrato só à custa de marcar quase toda regra como
    global, o que anula o benefício do módulo e deixa duas convenções convivendo.
  - *Tailwind*: reescreve o `className` de todos os 17 componentes — exatamente o que o E2E proíbe.
  - *CSS-in-JS (styled-components / emotion)*: custo de runtime numa página que já roda mesh WebRTC,
    E2EE por frame e medição de áudio a 60fps; e reintroduz o FOUC que o §3.5 elimina.
  - *Um `styles.css` só, mas organizado com comentários*: é o estado atual. Não escala e não permite
    revisar a mudança de um componente sem ler o arquivo inteiro.

### 3.2 Ordem de cascata garantida por barril com `@import` explícito, não por ordem de módulo

- **Decisão:** `src/styles.css` continua sendo **o único** `import` de CSS em `main.tsx`, e passa a
  ser um barril que só faz `@import` dos parciais, em ordem escrita à mão e comentada.
- **Motivação:** todo o CSS deste produto é de especificidade 1 (classe única). Isso quer dizer que
  **a ordem decide** quem ganha — e há pelo menos um caso vivo disso: `button { border: 1px solid
  var(--border) }` (elemento) contra `.icon-button { border-color: transparent }` (classe), e
  `.thumb-item { border: 0 }` contra o `button` global. Se cada componente importasse o próprio CSS
  do seu `.tsx`, a ordem de emissão passaria a ser a ordem do grafo de módulos do Rollup — que muda
  quando alguém reordena um `import` em `Room.tsx`, e a quebra apareceria como "o botão do chat
  ficou com borda" três PRs depois, sem relação aparente com a causa.
- **Alternativas descartadas:**
  - *`import './ChatPanel.css'` dentro de cada `.tsx` (co-location)*: mais bonito, mas troca uma
    ordem explícita por uma implícita. Se for adotado no futuro, adote **junto** com `@layer`.
  - *Cascade Layers (`@layer base, components, overlays;`)*: resolve a ordem de forma robusta e é
    suportado em todo navegador que este produto roda. Fica **registrado como opção**, mas não é
    necessário enquanto o barril for a única entrada — e conceito novo é custo.
  - *Um `<link>` por arquivo no `index.html`*: N requisições e ordem frágil em dev.

### 3.3 Tokens em duas camadas: primitivos e semânticos, com os 8 nomes atuais preservados

- **Decisão:** `styles/tokens.css` define **primitivos** (a paleta crua, sem significado:
  `--blue-500`, `--slate-900`, …) e, sobre eles, **semânticos** (o que a UI consome: `--bg`,
  `--surface`, `--text`, …). **Os 8 nomes semânticos que já existem não mudam de nome.** Os novos
  entram ao lado.
- **Motivação:** só o tema troca os semânticos; os primitivos são constantes. Preservar os 8 nomes
  atuais significa que ~200 usos de `var(--accent)` etc. continuam válidos e o diff da fase 1 é
  aditivo — dá para ligar o tema claro sem ter tocado em nenhuma regra de componente ainda.
- **Alternativas descartadas:**
  - *Uma camada só (semânticos com valor literal)*: duplica cada cor entre os dois temas e não
    dá nome ao "azul da marca", que é o que se ajusta quando a paleta muda.
  - *Renomear para um esquema novo (`--color-bg-default`)*: churn de 1371 linhas por ganho estético,
    com risco de deixar um `var()` órfão que só aparece em runtime (CSS não erra, só ignora).

### 3.4 Três famílias de token, e uma delas **não** vira com o tema

- **Decisão:** os semânticos se dividem em:
  1. **Tema** — viram com claro/escuro: superfícies, texto, borda, marca, estados.
  2. **Sobre mídia** (`--on-media-*`) — **fixos nos dois temas**: o scrim do `.video-label`, o fundo
     do `.tile-connection`, o letterbox `#000` do `.video-tile.contain video`, o fundo do
     `.participants-panel` e do `.participants-toggle`.
  3. **Runtime** — **não são tokens de design**: `--grid-cols`, `--tile-w`, `--grid-gap`,
     `--spot-w`, `--spot-h`, `--rail-w`, `--thumb-w`, `--thumb-h`, `--speak-level`, `--mic-level`.
     São escritos por JS (`VideoGrid`, `SpotlightStage`, `VideoTile`, `SettingsModal`) e tipados em
     `src/types/css-vars.d.ts`. **Ninguém os declara em `tokens.css`.**
- **Motivação:** a família 2 é o erro clássico de tema claro. Esses elementos ficam sobre **vídeo**,
  não sobre a página: um `.video-label` com fundo claro no tema claro fica ilegível sobre uma câmera
  clara, e o letterbox branco em volta de um compartilhamento de tela ofusca. O que está sobre mídia
  segue a mídia, não o tema. A família 3 precisa do aviso porque um `--grid-gap: 12px` declarado no
  `:root` "para organizar" cria uma segunda fonte de verdade para um número que **também** existe em
  `lib/gridLayout.ts` (`GRID_GAP = 12`) e alimenta a conta que o E2E mede.
- **Alternativas descartadas:** *deixar a família 2 virar com o tema e "escurecer um pouco no
  claro"* — é adivinhação sobre o conteúdo do vídeo, que pode ser qualquer coisa.

### 3.5 Tema resolvido em JS e escrito como `data-theme` no `<html>`; CSS tem exatamente dois blocos

- **Decisão:**
  - O `localStorage` guarda a **preferência** (`system` | `light` | `dark`).
  - Um script **inline e síncrono** no `<head>` do `index.html`, antes do `<script type="module">`,
    lê a preferência, resolve `system` via `matchMedia('(prefers-color-scheme: dark)')` e escreve
    `document.documentElement.dataset.theme` com o valor **já resolvido** (`light` ou `dark`).
  - O CSS tem só dois blocos de token: `:root[data-theme='dark']` e `:root[data-theme='light']`,
    cada um declarando também o seu `color-scheme`.
  - Enquanto a preferência for `system`, um listener de `matchMedia` reescreve o atributo quando o
    SO muda.
- **Motivação:** resolver em JS elimina a terceira combinação de CSS (`@media prefers-color-scheme`
  + `:not([data-theme])`), que é onde mora a maioria dos bugs de "escolhi claro e voltou pro escuro
  ao recarregar". Script **inline e síncrono** é o que impede o flash: o bundle é `type="module"`,
  portanto adiado, e um tema aplicado no `useEffect` do React pisca escuro→claro em toda navegação.
  O `color-scheme` por bloco é o que mantém `<select>`, `input[type=range]`, `accent-color` e a
  barra de rolagem `thin` legíveis — hoje é `dark` fixo no `:root`, e deixá-lo lá quebraria o tema
  claro nos widgets nativos, que é justamente o tipo de defeito que ninguém vê no screenshot.
- **Alternativas descartadas:**
  - *Só `@media (prefers-color-scheme)`, sem alternância*: o pedido é alternância manual persistida.
  - *Classe `.theme-light` no `<body>`*: `<body>` só existe depois do parse do `<head>`; o atributo
    no `<html>` é o único alvo disponível para o script inline.
  - *Aplicar o tema num `useEffect`*: FOUC garantido, e a Home é a primeira tela de quem chega.
  - *Guardar já resolvido no storage*: perde a informação "eu quero seguir o sistema".

### 3.6 O controle de tema é um **grupo de rádio**, e nunca um `<select>`

- **Decisão:** três `<input type="radio">` (Sistema / Claro / Escuro) num `role="radiogroup"` dentro
  do `SettingsModal`, com rótulos de texto.
- **Motivação — esta é a restrição mais afiada do documento:**
  `packages/e2e/harness.ts:494` bloqueia em
  `selects.length === 3 && [...selects].every(s => s.options.length > 1)`,
  e `run.ts` endereça os seletores por índice (`.settings-modal select` `.nth(0|1|2)`, e o
  destructuring `[video, audio, output]` na linha 1402). **Um quarto `<select>` no modal trava o
  `openSettings` em timeout e derruba praticamente toda a suíte** — não só as checagens de
  dispositivo. Rádio é a única forma de tri-estado que não toca nessa contagem, é navegável por
  teclado sem código nenhum, e casa com os dois checkboxes que já vivem ali (que o E2E endereça
  **por nome acessível**, `getByRole('checkbox', { name: /avisos sonoros/i })`, não por posição —
  logo, acrescentar controles nomeados é seguro).
- **Alternativas descartadas:**
  - *`<select>` de tema*: acima.
  - *Botão de tema na barra `.controls`*: a barra é `flex-wrap` e a altura dela é **medida** pelo
    E2E em 390×844 (L6/L7 exigem `controls.bottom <= innerHeight` e ausência de scroll). Um oitavo
    botão pode adicionar uma linha justamente no viewport mais apertado. Risco desproporcional para
    um controle que se usa uma vez.
  - *Checkbox "tema claro"*: perde o estado `system`, que é o default correto.

### 3.7 Aplicação imediata, fora do contrato Salvar/Cancelar do modal

- **Decisão:** clicar num rádio de tema aplica **e persiste na hora**. O "Cancelar" do modal não
  reverte o tema, e isso fica dito na dica de texto abaixo do grupo.
- **Motivação:** é o comportamento que todo mundo espera de um seletor de tema, e evita duas
  armadilhas concretas: (a) incluir `theme` no payload de `onSave` obriga a mexer nos **dois**
  chamadores (`Home.tsx` e `Room.tsx`) e no tipo do payload, por um campo que nada tem a ver com
  hardware; (b) a variante "aplica ao vivo e reverte no desmonte" quebra no `StrictMode` do React
  19, que monta→desmonta→remonta em desenvolvimento — a limpeza roda logo após o primeiro mount e
  reverte o tema sozinha.
- **Alternativa descartada:** *tema no payload de `onSave`* — consistente com o resto do modal, mas
  sem preview ao vivo, que é metade do valor de escolher um tema.
- **Consequência a respeitar:** `writeTheme` **não** pode ser chamado no carregamento da página. O
  E2E T2 afirma que "antes de qualquer escolha, nada é gravado" para `wtk-meet:audio`; o mesmo
  princípio (ARCHITECTURE.md §6.10 — zero persistência com exceções nomeadas) vale aqui. A chave
  `wtk-meet:theme` só existe depois de um clique.

### 3.8 Chave de storage própria (`wtk-meet:theme`), com valor string cru

- **Decisão:** chave nova, valor `'system' | 'light' | 'dark'` como string simples, sem JSON.
- **Motivação:** `wtk-meet:devices` **não pode** receber o campo. O E2E S7 afirma literalmente
  *"com exatamente as cinco chaves"*
  (`audioInputId,audioOutputId,soundsEnabled,startCameraOff,videoInputId`) — um sexto campo reprova
  a checagem. Chave separada é o precedente já estabelecido por `wtk-meet:audio`
  (`lib/noiseSuppression.ts:34`), pelo mesmo argumento: hardware é uma pergunta, preferência
  perceptual é outra. String crua (e não JSON) porque o script inline do `<head>` precisa ser
  minúsculo e não pode lançar — `JSON.parse` de um valor corrompido é uma exceção a mais para tratar
  no caminho mais crítico da página.
- **Verificação:** as checagens D5 e N10 do E2E varrem `Object.keys(localStorage)` mas filtram por
  regex (`/chat|message/i`, `/music|queue|track|playlist/i`); `wtk-meet:theme` não casa com nenhuma.
  A chave é segura.

### 3.9 O contrato congelado com o E2E

- **Decisão:** a lista abaixo é **imutável** nesta entrega. Ela é o inventário do que
  `packages/e2e/{run,harness}.ts` usa para dirigir a UI.
- **Motivação:** a suíte E2E é o único gate que enxerga CSS neste projeto — não há teste unitário de
  estilo. Ela também é a única prova de que o layout de viewport fixo continua de pé.

**Classes usadas como seletor** (não renomear, não remover do DOM, não esconder com `display: none`):
`.home` (via `main.home`), `.prejoin`, `.prejoin-toggle input`, `.local-preview video.mirrored`,
`.room.in-call`, `.controls`, `.controls button`, `.stage` (implícito), `.video-stage`,
`.video-grid`, `.video-tile`, `.video-tile video`, `.video-tile.speaking`,
`.video-tile.conn-warn`, `.video-tile.conn-bad`, `.video-label`, `.video-placeholder`,
`.tile-connection`, `.spotlight-stage`, `.spotlight-layout`, `.spotlight-main`, `.thumb-rail`,
`.thumb-item`, `.thumb-select`, `.thumb-item:not(.thumb-select)`, `.thumb-select[aria-pressed]`,
`.participants-toggle`, `.participants-panel`, `.chat-panel`, `.chat-message`, `.chat-text`,
`.toast`, `.warning`, `.error`, `.modal-backdrop`, `.modal-backdrop.settings`,
`.join-request-modal`, `.join-request`, `.join-request-hint`, `.settings-modal`,
`.settings-modal select`, `.settings-preview video`, `.music-panel`, `.music-panel button.audio-blocked`,
`.music-composer`, `.music-now`, `.music-now-title`, `.music-queue-item .music-queue-title`,
`.music-vote-card`, `.peer-audio-sinks audio`, `.audio-blocked`.

**Propriedades computadas que o E2E lê:** `--grid-cols` em `.video-grid`, `object-fit` em
`.video-tile video` (precisa continuar `contain`), `z-index` de `.modal-backdrop` e de
`.modal-backdrop.settings` (o de aprovação **acima** do de configurações), `position: fixed` do
backdrop.

**Textos e nomes acessíveis:** botões `Aprovar`, `Negar`, `Silenciar` / `Ativar mic`, `Chat`
(prefixo — `/^Chat/`), `Música`, `Sair`, `Configurações`, `Entrar na sala`; placeholder
`Como te chamam`; rótulos `Mensagem`, `Adicionar faixa por link`; checkboxes por nome
`Entrar com a câmera ligada`, `/avisos sonoros/i`, `/supressão de ruído/i`; `role="dialog"`,
`aria-modal`, `aria-labelledby`, `aria-pressed`.

**Invariantes estruturais:** `PreJoin` continua com `className="home prejoin"` (o E2E usa
`main.home` no lobby); `.chat-panel` e `.music-panel` continuam **irmãos** de `.video-stage` dentro
de `.stage` (L7 mede `chat.top >= stage.bottom`); `.settings-modal` continua com **exatamente três**
`<select>`, na ordem câmera → microfone → saída.

### 3.10 Escala de breakpoints ancorada nos viewports que o E2E exercita

- **Decisão:** três larguras — `≤ 480px` (compacto), `≤ 720px` (empilhamento, **preservado**),
  `≥ 1200px` (folga). Declaradas como comentário/constante no topo de `tokens.css` e repetidas nos
  arquivos que as usam.
- **Motivação:** o E2E mede em **390×844** (L6/L7), **500×820** (destaque estreito) e no viewport
  padrão do Playwright (1280×720). Qualquer regra nova em `≤480` cai sobre o teste de 390 e precisa
  manter `noPageScroll`. O 720 fica onde está porque é ele que faz o chat empilhar — mudá-lo reprova
  L7 diretamente.
- **Cuidado explícito:** `NARROW_STAGE_WIDTH = 720` em `lib/spotlightLayout.ts` é **outro** 720. Ele
  mede a largura do **palco**, não do viewport, e é decidido em JS. Coincidência de número, não
  relação. **Não** unifique os dois num token.

### 3.11 Foco visível por regra global sobre elementos interativos, com escape onde `outline` já trabalha

- **Decisão:** uma regra `:focus-visible` em `base.css` alcançando `a, button, input, select,
  textarea, [tabindex]`, usando `outline: 2px solid var(--focus-ring); outline-offset: 2px`.
  Onde o `outline` já carrega significado, o anel de foco usa `box-shadow`.
- **Motivação:** `.video-tile` usa `outline` para **três** coisas ao mesmo tempo — o anel de "está
  falando" (`outline: 3px solid transparent` sempre presente, para não empurrar layout),
  `.conn-warn` e `.conn-bad`. Um `:focus-visible { outline: … }` genérico apagaria o estado de
  conexão do tile focado. O `.thumb-item` já resolve isso hoje (o foco fica no `<button>`, o
  `outline` de estado fica no `.video-tile` filho) e serve de modelo.
- **Ganho não óbvio:** a regra cobre o `div role="button" tabIndex={0}` da barra "Tocando agora",
  que hoje é focável e **invisível** quando focado.

---

## 4. Componentes Afetados

### 4.1 Camada de estilo (nova estrutura de arquivos)

`packages/client/src/styles.css` deixa de ter regras e vira barril. Os parciais vivem em
`packages/client/src/styles/`:

| Arquivo | O que migra do `styles.css` atual | Por quê |
|---|---|---|
| `tokens.css` | o `:root` inteiro | Fundação: primitivos, semânticos por tema, escalas, `color-scheme` |
| `base.css` | `*`, `body`, `button`, `input`, `code`, `@keyframes` compartilhados | Reset e elementos; ganha a regra de `:focus-visible` (§3.11) |
| `home.css` | `.home`, `.tagline`, `.field`, `.actions`, `.join-block`, `.hint`, `.error`, `.optional`, `.occupied-room`, `.occupied-actions` | Home; reusado pelo lobby |
| `prejoin.css` | `.prejoin-preview`, `.prejoin-toggle`, `.prejoin-toggle + .hint` | O que é só do lobby |
| `room.css` | `.room`, `.phase-content`, `.local-preview`, `.warning`, `button.warning.audio-blocked`, `.stage`, `.controls`, `.badge`, `.invite-hint` | Casca da sala e rodapé |
| `video-stage.css` | `.video-stage`, `.video-grid` (+`.unmeasured`/`.overflowing`), `.spotlight-layout`, `.spotlight-main`, `.thumb-rail`, `.thumb-item`, `.participants-toggle`, `.participants-panel` | Geometria do palco — **a área de maior risco** (§7 R5) |
| `video-tile.css` | `.video-tile` (+ estados), `.video-placeholder`, `.avatar-initial`, `.video-label`, `.mic-off`, `.tile-connection`, `.tile-badge`, variante `.compact` | O tile e tudo que fica **sobre** ele |
| `chat-panel.css` | `.chat-*` | Painel de chat, incl. a regra de ≤720px |
| `music-panel.css` | `.music-panel`, `.music-header`…`.music-composer`, `.music-youtube-host`, `.remote-music-audio` | Painel do player |
| `music-controls.css` | `.music-button`, `.music-button-track`, `.now-playing-bar`, `.now-playing-*`, `@keyframes pulse-dot` | Fica no rodapé/palco, não no painel |
| `music-vote-card.css` | `.music-vote-*` | Overlay próprio, camada própria |
| `toasts.css` | `.toasts`, `.toast`, `.toast-*`, `@keyframes toast-in` | Overlay |
| `modal.css` | `.modal-backdrop`, `.modal-backdrop.settings`, e a casca comum dos dois modais | Onde as camadas z são decididas **em um lugar só** |
| `join-request-modal.css` | `.join-request-*` | Modal de aprovação |
| `settings-modal.css` | `.settings-*`, `.mic-meter`, `button.primary`, `button.secondary` | Modal de configurações; ganha o grupo de rádio de tema |
| `peer-audio.css` | `.peer-audio-sinks` | Três linhas, mas é um contrato ("`display: contents`, nunca `none`") que merece arquivo com o comentário |

> A tabela de camadas `z-index` (toasts 20, participantes 15, votação 25, configurações 28/29,
> aprovação 30/31) hoje está espalhada em comentários de cinco lugares. Ela passa a viver
> **comentada em um bloco só, no topo de `modal.css`**, e os valores continuam nos arquivos de quem
> os usa. Não converta as camadas em tokens numéricos: o comentário que explica *por que* aprovação
> ganha de configurações vale mais que a indireção.

### 4.2 Client — código

| Componente | O que muda | Por quê |
|---|---|---|
| `index.html` | `<script>` inline síncrono no `<head>` que resolve e escreve `data-theme`; `<meta name="theme-color">` (dois, por `media`) | Anti-FOUC (§3.5); barra do navegador em mobile |
| `src/lib/theme.ts` **(novo)** | Módulo **puro**: constantes, `readTheme`, `writeTheme`, `resolveTheme`, `applyTheme(element, resolvido)` | Padrão de `devices.ts`/`noiseSuppression.ts`: testável em `node:test` sem jsdom |
| `src/main.tsx` | Assina `matchMedia` para reagir à mudança do SO enquanto a preferência for `system` | O script inline resolve uma vez; o listener cobre o resto da sessão |
| `src/components/SettingsModal.tsx` | Grupo de rádio de tema + dica de "aplica na hora"; `onChange` chama `applyTheme` + `writeTheme` | §3.6, §3.7. **Não** entra no payload de `onSave` |
| `src/styles.css` | Vira barril de `@import` | §3.2 |
| Demais componentes/páginas | **Nenhuma mudança de `className`, texto ou ARIA.** Só se a passada de design exigir um wrapper novo — e aí a classe é **adicionada**, nunca substituída | §3.9 |
| `src/types/css-vars.d.ts` | Inalterado | A assinatura `--${string}` já cobre qualquer variável nova passada por `style` |

### 4.3 Testes

| Arquivo | O que muda |
|---|---|
| `packages/client/test/theme.test.ts` **(novo)** | `resolveTheme` nas 6 combinações (3 preferências × `prefersDark` true/false); `readTheme` com storage vazio, com valor válido, com valor lixo, e com `getItem` que **lança** (Safari privado); `writeTheme` não chamado no default; `applyTheme` sobre um elemento falso |
| `packages/client/test/themeInlineScript.test.ts` **(novo)** | Lê `index.html` e afirma que a chave literal ali é a mesma de `THEME_STORAGE_KEY`. Precedente direto: o teste que prende `PROCESSOR_NAME` entre `noiseSuppression.ts` e o worklet (§7 R6) |
| Demais testes | Inalterados. Nenhum deles importa CSS |

---

## 5. Contratos de Interface

### Endpoints REST / Eventos em tempo real / Schema de banco

**Nenhum.** Esta entrega não toca no servidor, no protocolo Socket.IO nem no data channel. O tema é
estado local do navegador e **não sai da máquina** — nem para o servidor de sinalização, nem para os
peers. Isso é requisito, não detalhe: o ARCHITECTURE.md §5 lista o que o servidor sabe, e nada aqui
acrescenta uma linha àquela tabela.

### Persistência local (`localStorage`)

| Chave | Tipo | Valores | Default (não gravado) | Observações |
|---|---|---|---|---|
| `wtk-meet:theme` | `string` cru | `system` \| `light` \| `dark` | `system` | Chave própria — **não** pode entrar em `wtk-meet:devices` (E2E S7 exige exatamente cinco chaves lá). Só é escrita após escolha explícita (E2E T2, ARCHITECTURE.md §6.10). Valor desconhecido ou storage indisponível ⇒ `system` |

### Contrato de DOM (o que o CSS observa)

| Alvo | Atributo | Valores | Quem escreve |
|---|---|---|---|
| `<html>` | `data-theme` | `light` \| `dark` (**sempre resolvido**, nunca `system`) | Script inline do `index.html` no boot; `applyTheme` depois |
| `<html>` | — | `color-scheme` vem do bloco de token do tema em vigor | `tokens.css` |

### Contrato do módulo `lib/theme.ts` (pseudo-assinatura, sem implementação)

```
THEME_STORAGE_KEY : 'wtk-meet:theme'
THEME             : { SYSTEM: 'system', LIGHT: 'light', DARK: 'dark' }
DEFAULT_THEME     : THEME.SYSTEM
type ThemePreference = 'system' | 'light' | 'dark'
type ResolvedTheme   = 'light' | 'dark'

readTheme(storage: PreferenceStorage) -> ThemePreference
    // nunca lança; valor ausente, inválido ou storage que lança ⇒ DEFAULT_THEME

writeTheme(storage: PreferenceStorage, pref: ThemePreference) -> ThemePreference
    // nunca lança; devolve o que efetivamente vale

resolveTheme(pref: ThemePreference, prefersDark: boolean) -> ResolvedTheme
    // 'system' ⇒ prefersDark ? 'dark' : 'light'; caso contrário, a própria pref

applyTheme(element: { dataset: Record<string,string> }, resolved: ResolvedTheme) -> void
    // única função que toca o DOM; recebe o elemento por parâmetro para ser testável
```

`PreferenceStorage` é a mesma interface mínima já definida em `devices.ts` e `noiseSuppression.ts`
(`getItem?`, `setItem?`, ambos opcionais). **Reuse-a; não declare uma terceira cópia.**

### Contrato de tokens semânticos (nomes que os arquivos de componente podem consumir)

| Grupo | Tokens | Vira com o tema? |
|---|---|---|
| Superfície | `--bg`, `--surface`, `--surface-raised` | sim |
| Traço | `--border` (separador decorativo), `--border-strong` (**limite de controle — mín. 3:1**) | sim |
| Texto | `--text`, `--muted-text`, `--text-on-accent`, `--text-on-danger` | sim |
| Marca | `--accent` (texto/borda/anel), `--accent-strong` (**fundo sólido, ≥4.5:1 com `--text-on-accent`**), `--accent-soft` (wash) | sim |
| Estados | `--danger`, `--danger-strong`, `--danger-soft`, `--warning`, `--warning-text`, `--warning-soft` | sim |
| Cromo | `--focus-ring`, `--overlay-backdrop`, `--shadow-1`, `--shadow-2`, `--shadow-3` | sim |
| Sobre mídia | `--on-media-scrim`, `--on-media-text`, `--media-letterbox`, `--panel-over-media` | **não** |
| Escalas | `--space-1…6`, `--radius-sm/md/lg/pill`, `--text-xs…xl`, `--font-family` | não |

> **`--warning` e `--warning-text` são dois tokens de propósito.** Hoje `.warning` usa a mesma cor
> para borda e para texto (`#caa53d`), o que funciona no escuro (8.06:1) e **falha feio no claro**
> (~2.2:1 sobre branco). No claro, a borda continua âmbar e o texto vira um âmbar bem mais escuro.
> O mesmo raciocínio vale para `--accent`/`--accent-strong` e `--danger`/`--danger-strong`.

---

## 6. Dependências e Ordem de Implementação

As fases são **sequenciais**, exceto onde marcado. Cada fase termina com a suíte verde — não empilhe
duas antes de rodar (§9).

**Fase 1 — Base de tokens (só aditiva, aparência idêntica).**
Cria `styles/tokens.css` com primitivos, escalas e os semânticos do **tema escuro com os valores de
hoje**, byte a byte. `styles.css` passa a importá-lo. Nenhuma regra de componente muda ainda.
*Critério de saída:* a UI está pixel-idêntica e `npm run build` passa.

**Fase 2 — Quebra em arquivos por componente.**
Move as regras para `styles/*.css` conforme §4.1, **sem editar nenhuma declaração**. Move junto os
blocos `@media` e `prefers-reduced-motion` para o arquivo do dono. `styles.css` vira barril.
*Critério de saída:* diff é 100% movimentação; a UI continua pixel-idêntica.
*Depende de:* 1.

**Fase 3 — Motor de tema.**
`lib/theme.ts` + testes; script inline no `index.html`; listener de `matchMedia` no `main.tsx`;
bloco `:root[data-theme='light']` em `tokens.css` com uma primeira paleta clara; `color-scheme` sai
do `:root` genérico e passa para os dois blocos. Nesta fase o tema claro **já vai parecer errado**
nos pontos de cor crua — é esperado, e a fase 4 é quem conserta.
*Critério de saída:* `data-theme` alterna corretamente por `localStorage` e por preferência do SO,
sem flash ao recarregar.
*Depende de:* 1. **Pode correr em paralelo com a 2** (arquivos disjuntos), mas só entra depois dela
para não gerar conflito no `styles.css`.

**Fase 4 — Controle de tema + erradicação de cor crua.**
Grupo de rádio no `SettingsModal`; substituição de **todas** as cores literais dos parciais por
tokens, classificando cada uma entre "tema" e "sobre mídia" (§3.4); morte do `var(--card-bg,
#23272e)` e do `var(--accent, #5b8def)`.
*Critério de saída:* `grep` por `#[0-9a-f]{3,6}` e por `rgba(` nos `styles/*.css` só encontra
resultados dentro de `tokens.css`. Tema claro coerente em todas as telas.
*Depende de:* 2 e 3.

**Fase 5 — Passada de design.**
Aplicação das escalas de espaçamento/raio/sombra/tipografia; revisão visual de Home, PreJoin, fases
da sala, tiles, painéis, modais e overlays. É aqui que o produto muda de cara.
*Critério de saída:* sem regressão de layout no E2E (L1–L7, U7, W-*), nos dois temas.
*Depende de:* 4.

**Fase 6 — Acessibilidade.**
Foco visível global (§3.11); acerto de contraste AA nos **dois** temas, priorizando os quatro
reprovados de hoje (§1); escala de breakpoints (§3.10) e verificação a 320px.
*Critério de saída:* §8, A1–A7.
*Depende de:* 5. **A6/A7 (breakpoints) podem correr em paralelo com A1–A5 (foco/contraste)** — são
arquivos e propriedades diferentes.

---

## 7. Riscos e Armadilhas

**R1 — Um `<select>` no modal de configurações derruba a suíte inteira.**
- *Risco:* `harness.ts:494` espera `selects.length === 3`; `run.ts` indexa por `.nth(0|1|2)` e
  destrutura `[video, audio, output]`. Um quarto `<select>` trava `openSettings` em timeout — e como
  quase todo cenário passa por lá, a suíte inteira cai de uma vez.
- *Mitigação:* grupo de rádio (§3.6). Antes de mexer no modal, releia `harness.ts:485–503`.
- *Anti-pattern:* "é só um `<select>` a mais, e o E2E busca por classe". Ele busca por **contagem**.

**R2 — Cor crua sobre mídia virando com o tema.**
- *Risco:* trocar `rgba(0,0,0,0.55)` do `.video-label` por `var(--surface)` deixa o nome do
  participante ilegível sobre uma câmera clara no tema claro. Idem letterbox e painel de
  participantes.
- *Mitigação:* família `--on-media-*` fixa nos dois temas (§3.4).
- *Anti-pattern:* tratar "está dentro da minha página" como "está sobre o meu fundo". O
  `.video-tile` é uma janela para conteúdo que o produto não controla.

**R3 — Quebrar o CSS em arquivos muda a ordem da cascata sem avisar.**
- *Risco:* todo o CSS é especificidade 1. Mover `.icon-button` para depois — ou antes — do `button`
  global muda quem ganha, e o sintoma aparece longe da causa.
- *Mitigação:* barril com `@import` em ordem escrita (§3.2); a fase 2 é **só movimentação**, com
  diff verificável (`git show --stat` deve mostrar linhas movidas, não reescritas).
- *Anti-pattern:* "aproveitar que estou mexendo" e ajustar uma declaração durante a mudança de
  arquivo. Se algo estiver errado, anote e conserte na fase 4 ou 5, num commit próprio.

**R4 — Alterar a altura da barra `.controls` em viewport móvel.**
- *Risco:* L2, L6 e L7 medem `controls.bottom <= innerHeight` e `noPageScroll` em 390×844. Um botão
  novo, um `gap` maior ou um `padding` maior podem adicionar uma linha de quebra e reprovar.
- *Mitigação:* nenhum controle novo na barra (§3.6); ao mexer em `gap`/`padding` da `.controls`,
  medir em 390px antes de commitar.
- *Anti-pattern:* validar só em desktop porque "o mobile é um `@media` separado".

**R5 — Dessincronizar CSS e os módulos puros de geometria.**
- *Risco:* `lib/gridLayout.ts` (`GRID_GAP = 12`, `TILE_ASPECT = 16/9`, `MIN_TILE_WIDTH = 120`) e
  `lib/spotlightLayout.ts` (`RAIL_MIN_WIDTH`, `RAIL_MAX_WIDTH`, `RAIL_GUTTER = 10`,
  `MIN_THUMB_WIDTH`, `NARROW_STAGE_WIDTH = 720`) calculam a geometria que o CSS **consome** via
  `--grid-gap`, `--tile-w`, `--rail-w`, `--thumb-w/h`. Trocar o `gap` no CSS por um token de
  espaçamento produz um layout onde a conta e o desenho discordam — e o sintoma é `tileFitsStage:
  false` no E2E, que se lê como bug de grade.
- *Mitigação:* **não** tokenize `--grid-gap` nem o `12px` de fallback. Se o gap tiver mesmo que
  mudar, mude o `GRID_GAP` no módulo puro (que tem teste unitário) e deixe o CSS seguir a variável.
- *Anti-pattern:* declarar `--grid-gap: var(--space-3)` em `tokens.css` "para padronizar".

**R6 — A chave de storage passa a existir em dois lugares.**
- *Risco:* o script inline do `index.html` não pode importar `lib/theme.ts` (roda antes de qualquer
  módulo), então o literal `'wtk-meet:theme'` existe duas vezes. Renomear um lado dá "o tema não
  persiste" — silencioso, e só em produção.
- *Mitigação:* teste que lê o `index.html` e compara com `THEME_STORAGE_KEY`. É exatamente a defesa
  já usada para `PROCESSOR_NAME` entre `noiseSuppression.ts` e o worklet.
- *Anti-pattern:* gerar o script inline por plugin do Vite para "não duplicar". A complexidade do
  plugin custa mais que um teste de três linhas — e o `vite.config.ts` já carrega dois plugins
  caseiros.

**R7 — Perder o `color-scheme` e quebrar os widgets nativos.**
- *Risco:* `color-scheme: dark` hoje mora no `:root`. Ao movê-lo para os blocos de tema, é fácil
  esquecer um. O efeito não aparece no layout: aparece no `<select>` do modal, no
  `input[type=range]` do volume, no `accent-color` do checkbox do lobby e na barra de rolagem
  `scrollbar-width: thin` da `.thumb-rail` — todos com texto escuro sobre fundo escuro.
- *Mitigação:* `color-scheme` é declarado nos **dois** blocos, e a verificação inclui abrir o modal
  de configurações em cada tema.
- *Anti-pattern:* verificar tema claro só na Home, que não tem widget nativo nenhum.

**R8 — O anel de foco global apagar estados que usam `outline`.**
- *Risco:* `.video-tile` usa `outline` para "falando", `conn-warn` e `conn-bad`. Um
  `:focus-visible { outline: … }` que alcance o tile apaga o estado de conexão de quem está focado —
  e o E2E lê `.video-tile.conn-warn, .video-tile.conn-bad` por classe, então **passa** enquanto a
  pessoa não vê nada.
- *Mitigação:* regra restrita a elementos interativos; `box-shadow` onde `outline` já trabalha
  (§3.11). O `.thumb-item` de hoje é o modelo.
- *Anti-pattern:* `*:focus-visible { outline: 2px solid }`.

**R9 — Fragmentar `prefers-reduced-motion`.**
- *Risco:* hoje há dois blocos (`.toast`/`.video-tile` e `.mic-meter-fill`). Ao espalhar o CSS, uma
  transição nova na fase 5 nasce sem o bloco correspondente, e ninguém percebe — a checagem é
  humana.
- *Mitigação:* cada arquivo de componente termina com o seu próprio bloco `prefers-reduced-motion`,
  imediatamente abaixo das regras que ele neutraliza. Se um arquivo tem `transition` ou `animation`
  e não tem o bloco, é bug de revisão.
- *Anti-pattern:* um `@media (prefers-reduced-motion) { * { animation: none !important } }` no
  `base.css`. `!important` global torna impossível a exceção legítima (um indicador de carregamento).

**R10 — Confundir regressão desta task com a falha pré-existente do E2E.**
- *Risco:* a suíte fecha com uma falha conhecida (a checagem **F4a**, regressão anterior a esta
  task) e o total de checagens cresce a cada entrega. Comparar com um número lembrado de outra task
  leva a "eu quebrei" quando não quebrou — ou ao contrário.
- *Mitigação:* rodar o E2E **antes de tocar em qualquer arquivo** e guardar a linha de base
  (aprovadas/total, e o nome de cada falha) no arquivo de progresso da task. Comparar sempre com
  **essa** linha, e por nome de checagem, não por contagem.
- *Anti-pattern:* aceitar "falhou uma, deve ser a de sempre" sem conferir o nome.

**R11 — Achar que os testes unitários protegem o CSS.**
- *Risco:* `npm test` (56 server + 520 client) não carrega uma linha de CSS. Verde ali não diz nada
  sobre esta entrega.
- *Mitigação:* o gate real é `npm run test:e2e`. Rode ao fim de **cada fase** — não só no fim.
- *Anti-pattern:* empilhar as fases 2 a 5 e rodar o E2E uma vez no final. Se quebrar, são quatro
  suspeitos e ~1400 linhas de diff.

**R12 — Tema claro com fundo claro e sombra pensada para o escuro.**
- *Risco:* as sombras atuais (`rgba(0,0,0,0.35/0.45/0.5)`) são calibradas para separar superfícies
  escuras. No claro, elas ficam sujas e o modal parece flutuar num borrão cinza.
- *Mitigação:* `--shadow-1/2/3` são tokens **de tema**: no claro, sombras mais suaves e mais
  espalhadas, apoiadas em `--border-strong` para o limite.
- *Anti-pattern:* reusar a mesma sombra nos dois temas "porque é preto transparente".

---

## 8. Critérios de Aceite Técnicos

**Estrutura e tokens**

- T1. `packages/client/src/styles.css` não contém nenhuma regra — só `@import` comentados, em ordem
  explícita, e continua sendo o único `import` de CSS de `main.tsx`.
- T2. Uma busca por literal de cor (`#rgb`, `#rrggbb`, `rgb(`, `rgba(`, `hsl(`) em
  `packages/client/src/styles/*.css` retorna resultados **apenas** em `tokens.css`.
- T3. Nenhum `var(--…)` referencia token inexistente. Em particular, `--card-bg` não é mais
  referenciado, e nenhum `var(--accent, …)` tem fallback diferente do valor real do token.
- T4. `--grid-cols`, `--tile-w`, `--grid-gap`, `--spot-w`, `--spot-h`, `--rail-w`, `--thumb-w`,
  `--thumb-h`, `--speak-level` e `--mic-level` **não** aparecem declarados em `tokens.css`.

**Tema**

- T5. Sem nada em `localStorage`, o app abre no tema do sistema, e `document.documentElement`
  carrega `data-theme="light"` ou `data-theme="dark"` — **nunca** `"system"`, nunca ausente.
- T6. Com `wtk-meet:theme = 'light'` e o SO em escuro, o app abre claro; e vice-versa.
- T7. Ao recarregar com o tema claro escolhido, **nenhum frame** é pintado com as cores do escuro (o
  atributo já está no `<html>` quando o primeiro paint acontece).
- T8. Escolher um tema no modal aplica a mudança imediatamente, sem clicar em Salvar; fechar por
  Cancelar, Esc ou backdrop **mantém** o tema escolhido.
- T9. Com a preferência em "Sistema", alternar o tema do SO com a aba aberta troca o tema sem
  recarregar.
- T10. `localStorage` só ganha a chave `wtk-meet:theme` **depois** de uma escolha explícita; antes
  disso ela não existe.
- T11. `localStorage['wtk-meet:devices']`, após salvar preferências, continua com exatamente
  `audioInputId, audioOutputId, soundsEnabled, startCameraOff, videoInputId`.
- T12. Com `localStorage` indisponível (acesso lança), o app carrega no tema do sistema e o seletor
  funciona pela sessão, sem erro no console.
- T13. `getComputedStyle(document.documentElement).colorScheme` é `dark` no tema escuro e `light` no
  claro; no modal de configurações, os três `<select>` e o `input[type=range]` de volume são
  legíveis nos dois.

**Contrato com o E2E**

- T14. `document.querySelectorAll('.settings-modal select').length === 3`, na ordem câmera →
  microfone → saída de áudio.
- T15. Todas as classes de §3.9 continuam existindo no DOM nas mesmas condições de hoje, e
  `.peer-audio-sinks` continua `display: contents` (nunca `none`).
- T16. `getComputedStyle` de `.video-tile video` devolve `object-fit: contain`; `.video-tile`
  continua `aspect-ratio: 16 / 9`.
- T17. `z-index` de `.modal-backdrop` (aprovação) > `.modal-backdrop.settings` > `.music-vote-card` >
  `.toasts` > `.participants-panel`, e o backdrop continua `position: fixed`.
- T18. Os textos de botão e nomes acessíveis listados em §3.9 são idênticos, caractere a caractere.
- T19. `npm run test:e2e` fecha com **exatamente** o mesmo conjunto de falhas da linha de base
  medida antes da fase 1 (hoje: apenas F4a), nos dois temas.

**Acessibilidade** *(cai fora se a premissa do §0 estiver invertida)*

- A1. Em ambos os temas, todo par texto/fundo do produto atinge **4.5:1** (ou 3:1 para texto ≥24px
  ou ≥19px negrito). Cobrir explicitamente: `button.primary`, `button.leave`, `.badge`,
  `.tile-badge`, `.music-queue-kind`, `.tile-connection`, `.warning`, `.error`, `.hint`,
  `.chat-time`, `.music-vote-quorum` e todo texto em `--muted-text`.
- A2. O limite visual de todo controle (`input`, `select`, `button`, checkbox, `input[type=range]`)
  atinge **3:1** contra a superfície em que está — em ambos os temas.
- A3. Navegando só por `Tab`, **todo** elemento focável mostra um anel de foco visível em ambos os
  temas, incluindo `.now-playing-bar`, `.icon-button`, `.thumb-item`, os botões dos dois modais e o
  `button.warning.audio-blocked`.
- A4. O anel de foco não apaga nem encobre os estados `speaking`, `conn-warn` e `conn-bad` do
  `.video-tile`.
- A5. `.music-vote-actions button.chosen`, `.music-queue-item.current` e
  `.thumb-item[aria-pressed='true']` continuam distinguíveis por algo além de cor (borda, peso ou
  marcador), nos dois temas.
- A6. A 320×568, 390×844 e 500×820: a página não rola, `.controls` fica inteira dentro do viewport,
  o tile cabe no palco e nenhum texto é cortado sem reticências.
- A7. Com `prefers-reduced-motion: reduce`, nenhuma transição ou animação nova roda — incluindo
  qualquer uma introduzida na fase 5.

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida.** Uma fase por commit, na ordem do §6. Não há paralelismo seguro entre 2 e 4:
as duas mexem nos mesmos arquivos. Se houver dois agentes, a divisão natural é
*fases 1–2 (estrutura)* e *fase 3 (motor de tema + testes)*, que só encostam em `styles.css` no
final — e aí é a fase 2 quem merge primeiro.

**Leia antes de escrever, nesta ordem:**
1. `packages/e2e/harness.ts:485–503` (`openSettings` — a contagem de `<select>`).
2. `packages/e2e/harness.ts:538–586` (`roomLayout` / `noPageScroll` — o que "layout correto"
   significa aqui, em números).
3. `packages/e2e/run.ts:283–300, 520–535, 925–935, 1885–1935` (as checagens L1–L7).
4. `packages/e2e/run.ts:1236–1250` (S7 — as cinco chaves de `wtk-meet:devices`).
5. `packages/client/src/lib/noiseSuppression.ts:1–60` (o padrão de módulo puro + chave própria que
   `lib/theme.ts` deve espelhar).

**Sequência de validação após cada fase:**
```
npm run typecheck && npm run lint && npm test && npm run test:e2e
```
O E2E é o único que enxerga CSS. Rode-o **em cada fase**, não só no fim (§7 R11), e compare com a
linha de base tomada antes da fase 1 — por **nome de checagem**, não por contagem (§7 R10).

**Verificação de contraste.** Não existe ferramenta de contraste no repositório e esta entrega não
adiciona uma. Meça os pares com qualquer calculadora WCAG 2.x (a razão é
`(L_claro + 0.05) / (L_escuro + 0.05)` sobre luminância relativa) e **registre a tabela dos dois
temas no arquivo de progresso da task** — é o artefato que prova A1/A2 e o que a próxima pessoa vai
consultar em vez de remedir. Os números do tema escuro de hoje já estão no §1 e servem de ponto de
partida: quatro pares reprovam.

**Pitfalls desta demanda que não estão na documentação geral:**
- A fase 2 deve produzir um diff de **movimentação pura**. Se `git diff` mostrar declarações
  reescritas, algo saiu do plano.
- Ao mover uma regra, **leve o comentário junto**. Os comentários deste CSS explicam decisões caras
  (`min-height: 0` na cadeia flex, `dvh` depois de `vh`, `visibility: hidden` antes da medição,
  `display: contents` no sink de áudio). Um comentário perdido vira uma regra "inútil" que alguém
  apaga em seis meses e reintroduz um bug já resolvido.
- `PreJoin` renderiza `className="home prejoin"` e o E2E busca `main.home` no lobby. Se a passada de
  design quiser separar as duas telas, **adicione** uma classe; nunca troque `home` por outra.
- O `Room` compõe a classe da sala como `` `room in-call${chatOpen ? ' with-chat' : ''}${musicOpen ?
  ' with-music' : ''}` ``. `.with-chat` e `.with-music` **não têm nenhuma regra** no CSS de hoje —
  são ganchos vazios. Ou dê uso a eles na fase 5, ou deixe-os quietos; não os remova do `.tsx` (o
  E2E casa `.room.in-call`, e mexer na expressão é risco sem ganho).
- `.thumb-item` recebe `thumb-select` **só** quando é clicável. O E2E distingue os dois casos
  (`.thumb-item:not(.thumb-select)`). Estilizar `.thumb-item` como se fosse sempre botão apaga a
  diferença visual entre "escolha" e "só está aqui".
- Commite cedo e por fase. O harness deste ambiente faz um auto-commit ("sync changes before opening
  PR") que pode fotografar uma edição pela metade; um `styles.css` capturado no meio da quebra é uma
  página em branco.

**Encerramento.** Ao terminar, registre no arquivo de progresso da task: a linha de base do E2E
(antes/depois, por nome de checagem), a tabela de contraste dos dois temas, e a lista final de
arquivos em `src/styles/` com uma linha do que cada um cobre.
