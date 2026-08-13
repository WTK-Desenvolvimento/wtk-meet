# Layout de destaque 80/20 para compartilhamento de tela — Documento de Arquitetura Técnica

> Gerado em: 2026-08-12
> Status: Rascunho
> Task: WTK-MEET-6 — Quando alguém compartilhar a tela, a página deve destacar o compartilhamento

---

## 1. Contexto e Objetivo

### Problema atual

Compartilhamento de tela hoje entra na grade como **mais um tile igual aos outros**
(`client/src/pages/Room.jsx`, `tiles` — um item extra `${peerId}-screen` com `badge: 'Tela'`).
A grade (`lib/gridLayout.js` + `components/VideoGrid.jsx`) maximiza um tile **uniforme** que
sirva para todos: com 3 participantes e 1 tela, o palco vira 2×2 e a tela compartilhada
recebe exatamente o mesmo retângulo de uma cabeça falante.

Consequência: o conteúdo que é o motivo da reunião naquele momento — um slide, um código,
uma planilha — fica com ~1/4 do palco, em 16:9 com letterbox, e o texto se torna ilegível.
Pior no caso extremo já exercitado pelo E2E (`e2e/run.mjs`, cenário C5: 3 câmeras + 2 telas
= 5 tiles): cada tela cai para ~1/6 da área.

O layout de viewport fixo entregue na WTK-MEET-5 (ARCHITECTURE §6.7) resolveu "a sala cabe
na tela"; ele não resolve "o que importa aparece maior". São problemas diferentes e a
solução do segundo é hierarquia visual, não mais espaço.

### Comportamento esperado após a entrega

- Assim que **qualquer** participante (inclusive o local) começa a compartilhar, o palco
  troca automaticamente de "grade uniforme" para **modo destaque**: uma tela ocupa ~80% da
  largura útil e uma coluna lateral rolável ocupa os ~20% restantes, com as câmeras de todos
  e as miniaturas das demais telas compartilhadas.
- Com **mais de uma** tela simultânea, cada participante clica na miniatura para escolher
  qual vê em destaque. A escolha é **puramente local** — não muda a tela de mais ninguém.
- Quando a tela em destaque acaba (o dono parou de compartilhar ou saiu), o destaque cai
  para outra tela ativa, se houver; se não houver nenhuma, o palco volta à grade uniforme
  atual, sem nenhuma diferença de comportamento em relação a hoje.
- Em palco estreito, o destaque ocupa a largura inteira e a coluna vira um **painel sob
  demanda**, aberto por um botão sobre o destaque.
- Todas as invariantes da WTK-MEET-5 continuam de pé: a página não rola, os controles e o
  modal de aprovação continuam alcançáveis em qualquer combinação de tiles.

---

## 2. Escopo

**Dentro do escopo:**

- Ativação automática do modo destaque quando existe ≥ 1 tela compartilhada na sala.
- Cálculo do layout destaque + coluna lateral como **módulo puro testável**, no mesmo padrão
  de `lib/gridLayout.js`.
- Seleção local de qual tela fica em destaque, por clique na miniatura, com resolução
  automática de fallback quando a escolhida deixa de existir.
- Coluna lateral rolável com: câmera local, câmeras remotas e miniaturas das telas **não**
  destacadas.
- Modo estreito: destaque em largura cheia + painel de participantes sob demanda.
- Estabilidade do elemento `<video>` ao alternar entre grade e destaque (ver §3.4).
- Testes unitários do novo módulo puro e atualização dos pontos do E2E que assumem grade
  uniforme.
- Atualização de `ARCHITECTURE.md` com uma seção §6.8 descrevendo o modo destaque.

**Fora do escopo (não fazer nesta entrega):**

- Botão de "sair do destaque" / voltar manualmente para a grade uniforme enquanto há
  compartilhamento ativo. O modo é automático nesta entrega; se o usuário quiser a grade,
  a saída é o dono parar de compartilhar.
- Fixar (pin) uma **câmera** em destaque, ou destaque automático por quem está falando.
  A coluna é rolável e as câmeras não são selecionáveis nesta versão.
- Fullscreen nativo (`requestFullscreen`) do tile em destaque.
- Sincronizar a escolha de destaque entre participantes, ou qualquer forma de "apresentador
  controla a visão dos outros".
- Qualquer evento novo no servidor de sinalização ou no data channel.
- Áudio do sistema no `getDisplayMedia` (segue como limitação conhecida, ARCHITECTURE §9).
- Reordenar/arrastar miniaturas.

---

## 3. Decisões Arquiteturais

### 3.1 A escolha do destaque é estado local, derivado, sem nada na rede

- **Decisão:** o participante em destaque vive em um único `useState` local no `Room`
  (`pinnedScreenId`), e o destaque **efetivo** é *derivado* a cada render: se
  `pinnedScreenId` ainda estiver na lista de telas ativas, ele vence; senão, vence a
  primeira tela da lista em ordem determinística. Nenhum evento novo no Socket.IO e nenhum
  tipo novo no data channel.
- **Motivação:** o requisito é explícito ("sem afetar os outros"). Além disso, o projeto tem
  como invariante que a UI de chamada não acrescenta eventos ao servidor (ARCHITECTURE §5 e
  §6) — a única exceção histórica é `join-request-cancelled`, e ela é metadado de sala.
  Derivar o destaque em vez de "corrigir" o estado num efeito elimina a classe inteira de
  bugs de sincronização (tela que some, peer que sai, ordem de chegada de tracks).
- **Alternativas descartadas:**
  - *Anunciar o destaque pelo data channel* — criaria a noção de "apresentador que controla
    a tela dos outros", que o requisito nega, e um estado distribuído a reconciliar.
  - *`useEffect` que escreve `pinnedScreenId` quando a lista de telas muda* — render extra a
    cada mudança, janela de um frame com destaque inválido e, na prática, roubo da escolha
    do usuário quando uma segunda tela entra. Ver anti-pattern em §7.

### 3.2 O layout é calculado em JS, num módulo puro novo

- **Decisão:** criar `client/src/lib/spotlightLayout.js` — puro, sem DOM, no mesmo contrato
  de `gridLayout.js`: recebe a caixa do palco e a contagem de miniaturas, devolve as
  dimensões do destaque, da coluna e de cada miniatura, mais o modo (`spotlight` /
  `spotlight-narrow`). `gridLayout.js` **não é alterado** — ele continua sendo o cálculo do
  modo grade e do interior da coluna quando ela precisa quebrar.
- **Motivação:** é exatamente a mesma razão de §6.7 do ARCHITECTURE: a decisão depende de
  largura, altura e contagem ao mesmo tempo, e CSS não expressa "o destaque é 16:9, cabe na
  altura, e o que sobra vira coluna com miniaturas legíveis". Módulo puro = testável em
  `node:test` sem navegador (o E2E não roda neste ambiente — ver §7).
- **Alternativas descartadas:**
  - *Fazer tudo em CSS (`flex: 4` / `flex: 1`)* — o destaque precisa respeitar 16:9 **e**
    caber na altura; em janela achatada `flex` entrega um destaque que estoura verticalmente
    e ressuscita o scroll de página que a WTK-MEET-5 eliminou.
  - *Estender `computeGridLayout` com um parâmetro `spotlight`* — sobrecarregaria uma função
    já testada e coesa com uma segunda geometria; dois módulos puros pequenos são mais
    baratos de ler e de testar que um com dois modos.

### 3.3 "80/20" é alvo com trava, não proporção rígida

- **Decisão:** a largura da coluna é `clamp(RAIL_MIN, 20% da largura do palco, RAIL_MAX)`,
  com `RAIL_MIN = 160px` e `RAIL_MAX = 280px` (valores iniciais; ficam como constantes
  exportadas do módulo). O destaque recebe o resto, e depois é reduzido para caber na altura
  mantendo 16:9.
- **Motivação:** em um monitor ultrawide, 20% viram 400px de miniatura — desperdício; em um
  laptop com o chat aberto, 20% viram 110px — miniatura ilegível. A trava mantém a intenção
  do requisito na faixa em que ela faz sentido e degrada de forma previsível fora dela.
- **Alternativas descartadas:** 20% puro (quebra nos dois extremos); coluna de largura fixa
  (ignora o requisito em telas médias).

### 3.4 Áudio remoto sai do tile e vira um sink dedicado

- **Decisão:** introduzir um componente invisível de áudio (um `<audio>` por participante
  remoto, montado uma única vez, fora do palco, junto dos overlays). Todos os `<video>` dos
  tiles passam a ser `muted`.
- **Motivação:** entrar e sair do modo destaque **move** o tile de um container para outro na
  árvore React (grade → coluna lateral). React desmonta e remonta o `<video>`, e hoje é esse
  mesmo `<video>` que reproduz o áudio do peer (ver o comentário em `VideoTile.jsx`: "o
  `<video>` nunca é desmontado"). O remonte produz um corte audível a cada início/fim de
  compartilhamento e a cada troca de destaque — um bug de áudio causado por uma mudança de
  layout, que é exatamente o acoplamento que se quer eliminar. Separar o transporte de áudio
  do posicionamento do vídeo custa poucas linhas e torna qualquer rearranjo futuro de layout
  gratuito.
- **Alternativas descartadas:**
  - *Renderizar todos os tiles num único container com posicionamento absoluto calculado* —
    resolveria o remonte, mas mata o scroll independente da coluna lateral (requisito
    explícito) e obrigaria a reimplementar scroll em JS.
  - *Aceitar o corte de áudio* — regressão perceptível numa funcionalidade que hoje funciona.
  - *`display: none` no tile antigo em vez de movê-lo* — dobra o número de elementos `<video>`
    decodificando e não elimina o remonte no caso da troca de destaque.

### 3.5 O modo estreito é decidido pela caixa medida, não por media query

- **Decisão:** a virada para "destaque em largura cheia + painel sob demanda" é decidida pela
  **largura do palco medida pelo `ResizeObserver`**, com um limiar constante do módulo puro
  (`NARROW_STAGE_WIDTH`, valor inicial 720px), e não por `@media (max-width: …)`.
- **Motivação:** o palco encolhe com o chat aberto (`.stage` divide espaço com `.chat-panel`,
  320px). Uma media query de viewport diria "desktop" enquanto o palco real tem 400px, e a
  coluna ficaria com 80px. A largura medida já é a fonte da verdade do resto do layout —
  manter uma só evita dois comportamentos discordando na mesma tela.
- **Alternativas descartadas:** media query (dessincroniza com o chat); container queries
  (suporte adequado hoje, mas o limiar precisa ser visível ao módulo puro para ser testado
  sem navegador — a decisão precisa estar no JS de qualquer forma).

### 3.6 Só telas são selecionáveis, e a seleção é um controle real

- **Decisão:** a miniatura de uma tela compartilhada é envolvida por um `<button>` com
  `aria-pressed`, rótulo acessível do tipo "Ver a tela de Fulano em destaque". Miniaturas de
  câmera não são clicáveis e não entram na ordem de tabulação.
- **Motivação:** teclado e leitor de tela sem código de acessibilidade artesanal; `<div
  onClick>` exigiria `tabindex`, handlers de Enter/Espaço e `role` manuais, e é a fonte usual
  de regressão silenciosa.
- **Alternativas descartadas:** clique no tile inteiro via `onClick` no `div`; menu de
  contexto (esconde a ação principal).

### 3.7 Ordem determinística da coluna

- **Decisão:** ordem fixa — (1) sua câmera, (2) telas não destacadas, na mesma ordem em que
  aparecem na lista de telas, (3) câmeras remotas na ordem de inserção do `Map` de
  participantes (que é a ordem de chegada). A lista de telas é: sua tela (se houver), depois
  as telas remotas na ordem de chegada dos participantes.
- **Motivação:** a ordem precisa ser estável entre renders para o fallback de destaque ser
  previsível ("cai para a próxima tela ativa" só significa algo com ordem definida) e para as
  miniaturas não dançarem a cada atualização de estado.
- **Alternativas descartadas:** ordenar por quem está falando (miniaturas trocando de lugar
  no meio de um clique — alvo móvel) ou por nome (muda quando alguém entra).

---

## 4. Componentes Afetados

### Camada de lógica pura (`client/src/lib/`)

| Componente | O que muda | Por quê |
|---|---|---|
| `spotlightLayout.js` **(novo)** | Módulo puro que decide o modo (`spotlight` / `spotlight-narrow`) e devolve a geometria do destaque, da coluna e das miniaturas. Exporta as constantes de trava (`RAIL_MIN_WIDTH`, `RAIL_MAX_WIDTH`, `RAIL_TARGET_RATIO`, `NARROW_STAGE_WIDTH`). | §3.2, §3.3, §3.5 |
| `gridLayout.js` | **Sem alteração.** Continua sendo o cálculo do modo grade (sem compartilhamento). | Regressão zero no caminho atual |

### Camada de apresentação (`client/src/components/`)

| Componente | O que muda | Por quê |
|---|---|---|
| `SpotlightStage.jsx` **(novo)** | Mede o palco com `ResizeObserver` (mesmo padrão de `VideoGrid`), chama `computeSpotlightLayout`, e renderiza: tile de destaque + `ThumbnailRail`. No modo estreito, renderiza o destaque em largura cheia + botão/painel de participantes. | Núcleo da entrega |
| `ThumbnailRail.jsx` **(novo)** | Coluna rolável de miniaturas; envolve as miniaturas de tela em `<button>` com `aria-pressed`; recebe `onSelectScreen`. Também é o conteúdo do painel sob demanda no modo estreito (mesmo componente, container diferente). | §3.6; evita duplicar a lista em dois lugares |
| `VideoTile.jsx` | Ganha duas props opcionais: uma variante compacta (rótulo/badge menores, sem halo de fala pesado) e a supressão do áudio (todos os tiles passam a ser `muted`, já que o som sai pelo sink de §3.4). O `<video>` e o placeholder seguem como estão. | Reuso; §3.4 |
| `PeerAudio.jsx` **(novo)** | Sink de áudio invisível: um elemento de áudio por participante remoto com stream, montado fora do palco. | §3.4 |
| `VideoGrid.jsx` | **Sem alteração de comportamento.** Continua sendo usado quando não há nenhuma tela ativa. | Regressão zero |

### Página (`client/src/pages/Room.jsx`)

| O que muda | Por quê |
|---|---|
| Novo estado local `pinnedScreenId` (string ou `null`) e handler de seleção. | §3.1 |
| A montagem de `tiles` é dividida em duas listas derivadas: **telas ativas** (`screens`) e **participantes** (`people`), ambas com chaves estáveis idênticas às de hoje (`local`, `local-screen`, `<peerId>`, `<peerId>-screen`). | Necessário para o destaque; chaves estáveis evitam remonte |
| Destaque efetivo derivado no render (`pinned` válido → ele; senão → `screens[0]`). | §3.1 |
| O palco passa a renderizar `SpotlightStage` quando `screens.length > 0`, e `VideoGrid` caso contrário. | Ativação automática |
| Montagem dos sinks de áudio junto do bloco de overlays. | §3.4 |
| Estado local do painel de participantes no modo estreito (aberto/fechado). | §3.5 |

### Estilos (`client/src/styles.css`)

| O que muda | Por quê |
|---|---|
| Bloco novo para `.spotlight-stage`, `.spotlight-main`, `.thumb-rail`, `.thumb-item`, `.thumb-select` e o painel sob demanda, seguindo o padrão vigente: **as dimensões vêm de custom properties escritas pelo componente** (`--spot-w`, `--spot-h`, `--rail-w`, `--thumb-w`, `--thumb-h`), nunca estilo inline no tile. | Consistência com §6.7 |
| A coluna rola com `overflow-y: auto`; o **destaque nunca rola**. | Requisito |
| Variante compacta do `.video-tile` (rótulo menor, raio menor). | Legibilidade em ~200px |
| Estado selecionado da miniatura (contorno de destaque) e `:focus-visible` no botão. | §3.6 |

### Testes

| Arquivo | O que muda |
|---|---|
| `client/test/spotlightLayout.test.mjs` **(novo)** | Fixa a aritmética: proporção alvo e travas da coluna, destaque cabendo na caixa em janela achatada, virada para o modo estreito, geometria da miniatura, contagem 0 de miniaturas. |
| `e2e/run.mjs` | Cenário C (compartilhamento) hoje afirma "grade de Alice cresce para 5 tiles" e conta `.tile-badge`. Precisa passar a afirmar o modo destaque: existe 1 tile em destaque, sua largura é ≥ ~3× a largura da miniatura, clicar na segunda miniatura troca o destaque **só** na aba que clicou, e parar de compartilhar volta à grade. |

### Documentação

| Arquivo | O que muda |
|---|---|
| `ARCHITECTURE.md` | Nova §6.8 "Destaque de compartilhamento de tela": ativação automática, seleção local, geometria e a razão do sink de áudio. Uma linha em §8 citando o novo módulo. |

---

## 5. Contratos de Interface

> Nenhum endpoint REST, evento de WebSocket, mensagem de data channel ou schema de banco é
> criado ou alterado por esta entrega. As tabelas de §5 do template não se aplicam — o
> contrato relevante aqui é interno ao client, descrito abaixo em prosa.

### 5.1 Módulo puro `lib/spotlightLayout.js`

**Entrada** — objeto com: largura e altura úteis do palco (px), quantidade de miniaturas, e
opcionalmente proporção do tile, espaçamento, e as travas da coluna. Todos os opcionais têm
default exportado pelo módulo.

**Saída** — objeto com:

- `mode`: `'spotlight'` (coluna lateral visível) ou `'spotlight-narrow'` (destaque em largura
  cheia, coluna vira painel sob demanda).
- `spotlight`: largura e altura em px do tile de destaque, já em 16:9 e já reduzido para caber
  na altura disponível.
- `rail`: largura da coluna, largura e altura de cada miniatura, e um booleano indicando se as
  miniaturas excedem a altura da coluna (isto é, se ela rola).
- Como em `gridLayout.js`, entrada não medida (largura ou altura ≤ 0, ou não finita) devolve
  uma estrutura neutra com dimensões `0`, que o componente usa para não pintar com tamanho
  errado no primeiro frame.

**Invariantes que o módulo deve garantir** (e que os testes fixam):

1. `spotlight.width ≤ width - rail.width - gap` e `spotlight.height ≤ height`, sempre.
2. `spotlight.width / spotlight.height` ≈ 16/9 (tolerância de subpixel).
3. No modo `spotlight`, `rail.width` está dentro de `[RAIL_MIN_WIDTH, RAIL_MAX_WIDTH]` e o
   destaque nunca é menor que a miniatura.
4. Arredondamento sempre **para baixo**, pela mesma razão de `gridLayout.js`: arredondar para
   cima cria o pixel de estouro que ressuscita o scroll.
5. Função pura e determinística: mesma entrada, mesma saída, sem leitura de DOM, `window` ou
   relógio.

### 5.2 Contrato de props (pseudo-assinatura)

- **`SpotlightStage`** recebe: a tela em destaque (um descritor de tile), a lista ordenada de
  miniaturas (descritores de tile, cada um sinalizando se é uma tela selecionável e o id da
  tela), o mapa de níveis de áudio (para o anel de fala nas miniaturas de câmera), e o
  callback de seleção.
- **`ThumbnailRail`** recebe: a lista de miniaturas, a geometria vinda do módulo puro, o id da
  tela em destaque (para marcar `aria-pressed`) e o callback de seleção.
- **Descritor de tile**: a mesma forma já usada hoje em `Room.jsx` (`key`, `audioId`,
  `stream`, `label`, `muted`, `mirrored`, `contain`, `badge`, `cameraOff`, `micOff`),
  acrescida de `screenId` (presente somente em tiles de tela).

### 5.3 Custom properties de CSS escritas pelos componentes

`--spot-w`, `--spot-h` (destaque); `--rail-w`, `--thumb-w`, `--thumb-h` (coluna). Mesma
convenção de `--grid-cols` / `--tile-w` / `--grid-gap` já em uso.

---

## 6. Dependências e Ordem de Implementação

1. **`lib/spotlightLayout.js`** — fundação; não depende de nada.
2. **`client/test/spotlightLayout.test.mjs`** — imediatamente após o passo 1, antes de
   qualquer UI. É o único ponto onde a aritmética é verificável neste ambiente.
3. **`PeerAudio.jsx` + `muted` em todos os tiles + montagem no `Room`** — pode rodar **em
   paralelo** com 1–2, por ser independente do layout. Deve entrar **antes** do passo 5:
   fazer o contrário significa introduzir o corte de áudio e depois removê-lo.
4. **`VideoTile.jsx`: variante compacta** — depende de 3 (a supressão de áudio é a mesma
   mudança de props).
5. **`ThumbnailRail.jsx`** — depende de 4.
6. **`SpotlightStage.jsx`** — depende de 1 e 5.
7. **`Room.jsx`: listas derivadas `screens`/`people`, `pinnedScreenId`, troca de palco** —
   depende de 6.
8. **`styles.css`** — pode andar **em paralelo** a partir do passo 5, mas só fecha depois de 7
   (é onde o modo estreito é ajustado no visual).
9. **Modo estreito: botão + painel sob demanda** — depende de 7 e 8.
10. **`e2e/run.mjs`: cenário C reescrito** — depende de 9. Não bloqueia o merge se o Chromium
    não subir no ambiente (ver §7), mas o arquivo deve ficar coerente com o novo layout.
11. **`ARCHITECTURE.md` §6.8** — por último, descrevendo o que foi de fato entregue.

---

## 7. Riscos e Armadilhas

**R1 — Corte de áudio ao entrar/sair do destaque**
*Risco:* mover o tile de container remonta o `<video>` e interrompe o áudio do peer.
*Mitigação:* §3.4 — sink de áudio dedicado, aplicado **antes** de mexer no palco.
*Anti-pattern a evitar:* manter o áudio no `<video>` do tile e "resolver" com uma `key`
diferente ou com `video.play()` manual após o remonte — trata o sintoma e falha de novo na
próxima mudança de layout.

**R2 — `ResizeObserver` loop**
*Risco:* a coluna é rolável e está **dentro** do palco medido; se o elemento observado for
dimensionado pelo próprio conteúdo, a medição realimenta o layout e o navegador dispara
"ResizeObserver loop completed with undelivered notifications".
*Mitigação:* repetir exatamente o padrão de `VideoGrid.jsx` — observar um elemento cujo
tamanho vem **do pai** (`flex: 1; min-width: 0; min-height: 0; position: relative`), com o
conteúdo em `position: absolute` dentro dele; e só chamar `setState` quando as dimensões
**inteiras** mudarem.
*Anti-pattern a evitar:* observar o `.thumb-rail` (o elemento que rola) ou derivar a largura
da coluna de `getBoundingClientRect` do conteúdo.

**R3 — O destaque escolhido some (dono parou de compartilhar / saiu da sala)**
*Risco:* `pinnedScreenId` aponta para uma tela que não existe mais → destaque em branco.
*Mitigação:* §3.1 — o destaque efetivo é derivado no render, com fallback para a primeira tela
ativa; `pinnedScreenId` pode ficar "sujo" à vontade, porque nunca é lido sem validação.
*Anti-pattern a evitar:* `useEffect(() => { if (!screens.find(...)) setPinnedScreenId(null) },
[screens])` — render extra, um frame com destaque inválido e, quando uma segunda tela entra,
o efeito acaba sobrescrevendo a escolha deliberada do usuário.

**R4 — Escolha local vazando para os outros**
*Risco:* alguém "resolver" o caso de múltiplas telas anunciando o destaque pelo data channel.
*Mitigação:* revisar que a entrega não acrescenta nenhum `type` novo em `webrtcMesh.js` nem
nenhum evento em `server/src/index.js`. O requisito é explícito: a escolha é local.
*Anti-pattern a evitar:* reaproveitar `setLocalState` para carregar um campo de destaque —
sequestra um canal de estado de mídia para uma preferência de UI e quebra a tabela de §5 do
ARCHITECTURE.

**R5 — Regressão da invariante "a página não rola"**
*Risco:* o destaque em 16:9 numa janela achatada, ou a coluna com muitas miniaturas, empurra a
altura e faz os controles saírem da tela — exatamente o bug que a WTK-MEET-5 corrigiu.
*Mitigação:* invariantes 1 e 4 de §5.1, fixadas em teste; `min-height: 0` em **todos** os
níveis novos da coluna flex; rolagem sempre interna (`.thumb-rail`), nunca do documento.
*Anti-pattern a evitar:* `height` em `vh`/`%` dentro do palco (o palco já tem altura
resolvida; percentuais aninhados reintroduzem o estouro) e `flex: 4 / flex: 1` em vez da
geometria calculada.

**R6 — Miniatura ilegível ou coluna gorda demais**
*Risco:* 20% puro quebra nos extremos de largura.
*Mitigação:* travas de §3.3 + virada para o modo estreito abaixo de `NARROW_STAGE_WIDTH`.
*Anti-pattern a evitar:* deixar a coluna encolher indefinidamente "porque cabe".

**R7 — Oscilação de layout durante o resize**
*Risco:* perto do limiar de modo estreito, um pixel de arrasto alterna entre dois layouts
completamente diferentes, e cada alternância remonta subárvores.
*Mitigação:* limiar único e constante, comparação em pixels inteiros e — se o E2E ou a
inspeção manual mostrarem tremulação — histerese explícita (entra em estreito abaixo de
`NARROW`, só volta acima de `NARROW + 40px`), no módulo puro e coberta por teste. Adotar a
histerese apenas se o problema aparecer: é estado a mais.

**R8 — Chat aberto + modo estreito**
*Risco:* em palco estreito com o chat aberto, o painel de participantes e o chat podem se
sobrepor ou empilhar até engolir o destaque.
*Mitigação:* o painel de participantes é um **overlay sobre o destaque** (não uma terceira
faixa de fluxo), com z-index abaixo dos toasts (20). Abrir um não fecha o outro, mas o painel
nunca rouba altura do palco.
*Anti-pattern a evitar:* transformar o painel em mais um item flex de `.stage` — em 400px de
largura sobra nada para o destaque.

**R9 — O painel de participantes copiando as regras do modal de aprovação**
*Risco:* o `JoinRequestModal` deliberadamente **não** fecha por `Esc` nem por clique no
backdrop (ARCHITECTURE §6.7); copiar isso para o painel prende o usuário.
*Mitigação:* o painel de participantes **deve** fechar por `Esc` e por clique fora. A regra do
modal existe porque outra pessoa depende da decisão; aqui não depende ninguém.

**R10 — Custo de decodificação**
*Risco:* nenhuma mudança aumenta o número de streams, mas renderizar a mesma stream em dois
elementos (destaque + miniatura) dobraria o custo de decode.
*Mitigação:* a tela em destaque **não** aparece também como miniatura — a coluna lista apenas
as telas **não** destacadas. Cada stream tem exatamente um `<video>` no palco.

**R11 — E2E não executável neste ambiente**
*Risco:* o Chromium não sobe no sandbox (registrado na memória do projeto), então o cenário C
reescrito não pode ser validado aqui.
*Mitigação:* toda a aritmética verificável fica no módulo puro com `node:test`
(`npm test` em `client/`), que roda. A alteração do `e2e/run.mjs` entra como coerência de
código, e o agente deve declarar explicitamente no PR que o E2E não foi executado.
*Anti-pattern a evitar:* afirmar que o E2E passou porque o arquivo foi atualizado.

---

## 8. Critérios de Aceite Técnicos

**Ativação e reversão**

1. Sem nenhuma tela compartilhada, o palco renderiza a grade atual e o comportamento é
   idêntico ao de hoje, para qualquer contagem de participantes.
2. Assim que a primeira tela entra (local ou remota), o palco troca para o modo destaque, sem
   nenhuma ação do usuário.
3. Quando a última tela ativa termina, o palco volta à grade uniforme, e o `<video>` de cada
   participante continua reproduzindo áudio durante e depois da transição.

**Geometria**

4. Em palco largo (≥ `NARROW_STAGE_WIDTH`), a largura da coluna está dentro de
   `[RAIL_MIN_WIDTH, RAIL_MAX_WIDTH]` e o destaque ocupa toda a largura restante, respeitada a
   proporção 16:9.
5. O destaque nunca excede a caixa do palco em nenhum eixo, em nenhuma proporção de janela —
   inclusive em janelas achatadas (ex.: 1600×220).
6. `document.documentElement.scrollHeight` não excede `window.innerHeight` em nenhuma
   combinação de participantes, telas compartilhadas e chat aberto.
7. Com miniaturas suficientes para exceder a altura, quem rola é a coluna; o destaque e a
   página permanecem imóveis.

**Seleção**

8. Com duas ou mais telas ativas, clicar na miniatura de uma tela a coloca em destaque e move
   a anterior para a coluna, **na aba que clicou apenas** — as demais abas permanecem
   exatamente como estavam.
9. A miniatura de tela é alcançável por `Tab` e ativável por Enter/Espaço, com estado
   `aria-pressed` refletindo o destaque atual. Miniaturas de câmera não são focáveis.
10. Se a tela em destaque termina enquanto outra continua ativa, o destaque passa
    automaticamente para a outra, sem tela em branco intermediária.
11. Uma segunda tela entrando na sala **não** altera o destaque de quem já havia escolhido
    manualmente.

**Modo estreito**

12. Abaixo do limiar de largura do palco, o destaque ocupa a largura inteira e as miniaturas
    não aparecem em coluna fixa.
13. O botão de participantes indica a quantidade de itens; abrir mostra a mesma lista da
    coluna (câmeras + telas não destacadas), com scroll e seleção funcionando igual.
14. O painel fecha por `Esc`, por clique fora e pelo próprio botão, e nunca cobre a barra de
    controles.

**Não-regressão de rede**

15. Nenhum evento novo em `server/src/index.js` e nenhum `type` novo de payload em
    `webrtcMesh.js`. A tabela de §5 do `ARCHITECTURE.md` continua verdadeira sem alteração.

**Verificação executável**

16. `cd client && npm test` passa, incluindo o novo arquivo de testes do módulo de destaque.
17. `cd client && npm run lint` passa sem novos avisos.

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida**

- *Agente A (lógica pura):* passos 1–2 de §6. Entregável fechado e verificável sozinho:
  `spotlightLayout.js` + testes. Espelhe o estilo de `gridLayout.js` — cabeçalho explicando
  *por que* o cálculo não é CSS, constantes exportadas, estrutura neutra para entrada não
  medida, arredondamento para baixo.
- *Agente B (áudio + tile):* passos 3–4. Independente de A; pode ir em paralelo.
- *Agente C (UI do palco):* passos 5–9, depois de A e B.
- *Agente D (E2E + docs):* passos 10–11.

Se um único agente executar tudo, mantenha a ordem de §6 — em especial, o sink de áudio
**antes** de mexer no palco.

**Pitfalls específicos desta demanda (não estão na documentação geral)**

- As chaves dos tiles (`local`, `local-screen`, `<peerId>`, `<peerId>-screen`) já existem em
  `Room.jsx` e são a identidade usada para o destaque. **Não as renomeie** — mudar a chave
  remonta o `<video>` a cada render.
- `onRemoteScreen` é chamado com `null` quando o peer anuncia `screenOn: false`
  (`webrtcMesh.js`, `_handleChannelMessage`). A lista de telas ativas deve tratar
  `screenStream` nulo como "sem tela", não como "tela vazia" — senão o destaque fica preto em
  vez de cair para o fallback.
- A tela local não passa pelo mesh: ela vem de `screenStreamRef.current` + `sharingScreen`.
  Mantenha o `useMemo` com as mesmas dependências e o comentário que explica por que um ref
  aparece dentro dele.
- `AudioLevelMonitor` é indexado por `audioId` (`'local'` ou `peerId`) e é indiferente ao
  layout — o anel de fala deve continuar funcionando nas miniaturas de câmera. Não introduza
  um segundo `AudioContext`.
- `.stage` já é `flex-direction: column` abaixo de 720px por media query. Ao adicionar o modo
  estreito baseado em medição, verifique que as duas regras não brigam — o palco em coluna com
  o chat embaixo continua sendo o container que o `SpotlightStage` mede.

**Ordem de validação após implementar**

1. `cd client && npm test` — aritmética do módulo puro.
2. `cd client && npm run lint`.
3. Manual/`npm run dev` com duas abas: iniciar compartilhamento numa e conferir os critérios
   2, 3, 8 e 11; arrastar a janela para conferir 5 e 6; abrir o chat com destaque ativo para
   conferir 12–13.
4. `node e2e/run.mjs` **se** o ambiente permitir subir o Chromium; caso contrário, declarar
   explicitamente que não foi executado.
5. Ler `ARCHITECTURE.md` §5 e confirmar, linha a linha, que nada na tabela "o que o servidor
   sabe" mudou (critério 15).
