# Sala com layout de viewport fixo, grade automática e modal de aprovação — Documento de Arquitetura Técnica

> Gerado em: 2026-08-12
> Status: Rascunho
> Task: WTK-MEET-5 — Ajustar layout da sala para altura fixa, grade automática e modal de aprovação

---

## 1. Contexto e Objetivo

### Problema atual

A sala (`client/src/pages/Room.jsx` + `.room` / `.video-grid` / `.video-tile` em `client/src/styles.css`) é uma coluna flex com `min-height: 100vh`. Consequências observadas:

- `.video-grid` usa `grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))` e `.video-tile` tem `aspect-ratio: 4 / 3`. Com **um** participante numa tela larga, o tile único ocupa toda a largura da grade e, por proporção, uma altura enorme.
- Como o container é `min-height` (e não `height`), o conteúdo empurra a página: a barra `.controls` e o bloco `.pending-requests` saem da área visível. Para silenciar o mic, sair da sala ou **aprovar alguém que está esperando** é preciso rolar a página.
- O caso de aprovação é o mais crítico: quem está esperando entrada depende de uma ação de outra pessoa que, na prática, está fora da tela — o pedido pode passar despercebido até expirar a paciência do requisitante.
- `object-fit: cover` em 4:3 corta imagem de câmeras 16:9 (a esmagadora maioria) e o compartilhamento de tela em `contain` fica num quadro de proporção errada.

### Comportamento esperado após a entrega

- A sala ocupa exatamente a altura do viewport. **A página nunca rola** — `document.body.scrollHeight` nunca excede `window.innerHeight` na fase `in-call`.
- A grade de vídeos calcula sozinha o número de colunas/linhas e o tamanho de cada tile para **caber no espaço disponível**, com qualquer número de tiles (1 a 8 na prática: 6 participantes + até 2 tiles de tela) e em qualquer proporção de janela.
- Os controles ficam ancorados no rodapé, sempre visíveis e sempre clicáveis, independentemente do estado da grade, do chat aberto ou de banners de erro.
- Pedidos de entrada viram um **modal centralizado** sobre a tela, acima de qualquer outro elemento (inclusive toasts), impossível de perder de vista.
- Vídeos mantêm proporção **16:9 com letterbox** — nada de corte (`cover`) nem de deformação (`fill`).

### Vínculo com o produto

O controle de acesso da sala é social e distribuído: qualquer participante presente aprova (`ARCHITECTURE.md` §4). Se a UI de aprovação é fácil de não ver, o mecanismo de segurança que define o produto degrada para "ninguém entra". Este ajuste é de usabilidade **e** de integridade do fluxo de acesso.

---

## 2. Escopo

**Dentro do escopo:**

- Shell de layout da fase `in-call`: altura fixa de viewport, sem scroll de página, três faixas (topo compacto / palco / rodapé).
- Novo módulo puro de cálculo de grade (colunas, linhas, largura do tile) a partir de dimensões medidas + contagem de tiles + proporção alvo.
- Medição do container do palco em runtime (`ResizeObserver`) e aplicação do resultado via custom properties CSS.
- Mudança de proporção do tile de 4:3 para 16:9 e de `object-fit: cover` para letterbox.
- Promoção dos pedidos de entrada de bloco inline para modal centralizado, renderizado acima de todas as fases da tela.
- Ajuste das fases `waiting` / `denied` / formulário de nome para o mesmo modelo de altura fixa (consistência e ausência de scroll).
- Teste unitário do módulo de cálculo (`node:test`, seguindo a convenção de `client/test/*.test.mjs`).
- Ajuste/extensão do e2e apenas no necessário para cobrir os novos critérios.

**Fora do escopo:**

- Layout "speaker view" / pin / destaque de quem fala ou de quem compartilha tela. A grade continua **uniforme**: todos os tiles com o mesmo tamanho. Um tile de tela maior que os demais é uma demanda separada.
- Qualquer mudança em sinalização, mesh WebRTC, chat, E2EE, níveis de áudio ou protocolo do servidor. **Nenhum evento novo no servidor** (`ARCHITECTURE.md` §6).
- Redesign visual (paleta, tipografia, ícones nos botões). O trabalho é estrutural.
- Reordenação de tiles, paginação de participantes, ou virtualização.
- Responsividade mobile além de manter o layout funcional e sem scroll no breakpoint já existente (`max-width: 720px`).
- Acessibilidade além do mínimo descrito em §5.3 (o modal não precisa de focus trap completo nesta entrega — ver §7).

---

## 3. Decisões Arquiteturais

### 3.1 Altura do shell: `100dvh` com fallback para `100vh`, e `overflow: hidden`

- **Decisão:** `.room.in-call` passa a ter altura fixa igual à do viewport, declarada como `height: 100vh` seguida de `height: 100dvh` (a segunda sobrescreve onde suportada), com `overflow: hidden`.
- **Motivação:** `100vh` em navegadores móveis mede o viewport **sem** a barra de endereço retrátil, o que faz o rodapé ficar debaixo da barra do navegador — exatamente o bug que a task quer eliminar, só que em outra forma. `dvh` acompanha a barra dinamicamente. A dupla declaração é degradação graciosa pura, sem `@supports` e sem JS.
- **Alternativas descartadas:**
  - `position: fixed; inset: 0` no container: funciona, mas tira o elemento do fluxo e complica o alinhamento do modal e do formulário de nome; também esconde qualquer estouro de conteúdo em vez de deixá-lo visível em desenvolvimento.
  - Variável `--vh` recalculada no `resize` (a "hack do 1%" pré-`dvh`): adiciona listener global e uma fonte de verdade duplicada de altura. Boring perde do padrão que já existe.

### 3.2 Grade calculada em JS a partir de medição, não por CSS puro

- **Decisão:** um módulo puro `lib/gridLayout.js` recebe `{ width, height, count, aspect, gap, minTileWidth }` e devolve `{ cols, rows, tileWidth, tileHeight, overflow }`. Um componente `VideoGrid.jsx` mede o próprio container com `ResizeObserver`, chama o módulo e escreve o resultado como custom properties CSS no container. Os tiles não recebem estilo inline individual.
- **Motivação:** o problema é bidimensional — o tamanho ótimo do tile depende ao mesmo tempo da largura, da altura e da contagem. CSS não expressa "escolha o número de colunas que maximiza o tile sujeito a caber na altura": `auto-fit`/`minmax` só conhece a largura, e é exatamente por isso que o layout atual quebra. Isolar a matemática num módulo **sem nenhuma dependência de DOM** torna a regra determinística e testável em `node:test`, que é o padrão já usado no projeto para lógica sensível (`client/test/audioLevels.test.mjs` fixa a histerese do indicador de fala do mesmo jeito).
- **Alternativas descartadas:**
  - CSS puro com container queries / unidades `cqw`: a contagem de participantes não é um eixo que container query enxerga; exigiria uma cascata de regras por contagem (`:has(> :nth-child(5))`), frágil e ilegível, e ainda assim sem resolver janelas muito baixas.
  - Biblioteca de layout de vídeo pronta: dependência nova para ~40 linhas de aritmética, num projeto que declara explicitamente evitar SDKs de terceiros (`ARCHITECTURE.md` §7).
  - Medir via `window.innerWidth/innerHeight` e subtrair alturas conhecidas de rodapé/topo: acopla o cálculo a constantes mágicas que quebram quando um banner aparece ou o chat abre. `ResizeObserver` no container real é imune a isso por construção.

### 3.3 Proporção 16:9 com letterbox para todos os tiles

- **Decisão:** `.video-tile` passa a `aspect-ratio: 16 / 9`; o `<video>` passa a `object-fit: contain` com fundo escuro. A classe `.contain` (hoje usada só para tiles de tela) deixa de ser necessária como diferenciador de `object-fit` — permanece apenas, se útil, para o fundo preto do compartilhamento.
- **Motivação:** 16:9 é a proporção nativa da maioria das webcams e das telas compartilhadas; alinhar o tile à fonte minimiza a área de letterbox no caso comum. `contain` cumpre o requisito explícito de "sem cortes e sem deformações" — a alternativa `cover` corta rosto/cabeça em câmeras com proporção diferente.
- **Trade-off aceito:** câmeras 4:3 (webcams antigas, alguns celulares em retrato) exibem barras laterais. É a consequência direta do requisito, e é preferível a cortar a imagem.
- **Alternativas descartadas:** `object-fit: fill` (deforma — anti-pattern explícito); proporção por tile derivada da resolução real da track (`videoWidth/videoHeight`) — quebraria a uniformidade da grade e faria o layout saltar a cada troca de track (`replaceTrack` de câmera/tela é frequente, ver `ARCHITECTURE.md` §6.1).

### 3.4 Rodapé em faixa de fluxo, não `position: fixed`

- **Decisão:** os controles são a terceira faixa de um container em coluna (`flex: 0 0 auto`), não um elemento fixo sobreposto.
- **Motivação:** o palco é `flex: 1; min-height: 0` — ele cede o espaço que o rodapé precisa, e a grade se recalcula automaticamente porque o `ResizeObserver` observa o palco. Um rodapé `fixed` sobreporia a grade e exigiria um `padding-bottom` mágico sincronizado à mão com a altura real da barra (que muda quando os botões quebram linha).
- **Alternativas descartadas:** `position: sticky; bottom: 0` — resolve o mesmo problema só quando há scroll, e aqui não haverá scroll de página.

### 3.5 Pedidos de entrada como modal, renderizado fora do switch de fase

- **Decisão:** novo componente `JoinRequestModal.jsx`, overlay centralizado com backdrop, `z-index` acima dos toasts, listando **todos** os pedidos pendentes (um por linha, cada um com Aprovar/Negar). É montado num wrapper comum, **antes** dos `return` antecipados de fase em `Room.jsx`, junto com `<Toasts />`.
- **Motivação:** "aparece sobre qualquer estado da tela" só é garantido se a renderização não estiver dentro de um dos ramos de fase. Hoje `<Toasts />` e o bloco de pedidos vivem apenas no ramo `in-call`; qualquer fase futura os perderia silenciosamente. Listar todos os pedidos (em vez de um carrossel "1 de N") evita uma máquina de estado de fila e mantém o comportamento de aprovação múltipla que o e2e já exercita (`approveAll` clica no primeiro "Aprovar" até a contagem zerar).
- **Alternativas descartadas:**
  - `<dialog>` nativo com `showModal()`: dá focus trap e backdrop de graça, mas exige um `useEffect` imperativo para sincronizar abrir/fechar com o estado do React, e o `::backdrop` não herda as custom properties do tema. Overlay em div é mais previsível aqui.
  - Portal para `document.body`: desnecessário, já que nenhum ancestral cria contexto de empilhamento ou recorta o overlay — o overlay é `position: fixed`. Se algum ancestral ganhar `transform`/`filter` no futuro, revisitar.
  - Manter o bloco inline e só garantir visibilidade com scroll: não atende o requisito e mantém o pedido competindo por espaço vertical com a grade.

### 3.6 Escape hatch de estouro: scroll interno da grade, nunca da página

- **Decisão:** o cálculo respeita um `minTileWidth` (sugerido: 120px). Se nem com o máximo de colunas o tile couber acima desse mínimo, o módulo devolve `overflow: true`, a grade fixa o tile no mínimo e o **próprio container da grade** ganha `overflow-y: auto`.
- **Motivação:** com 8 tiles numa janela muito baixa (ex.: 1280×400), forçar tudo a caber produziria tiles ilegíveis. O escape é local, previsível, e preserva a invariante que interessa: a **página** não rola, os controles não somem.
- **Alternativas descartadas:** deixar o tile encolher sem limite (ilegível, e eventualmente com altura zero); paginar participantes (complexidade fora de escopo).

---

## 4. Componentes Afetados

### Frontend — novos arquivos

| Arquivo | O que é | Por quê |
|---|---|---|
| `client/src/lib/gridLayout.js` | Módulo puro, sem DOM: dada a caixa disponível, a contagem de tiles e a proporção alvo, devolve colunas/linhas/tamanho do tile. | Núcleo da decisão 3.2. Puro para ser testável em `node:test` sem navegador. |
| `client/src/components/VideoGrid.jsx` | Componente que renderiza a lista de tiles, mede o próprio container com `ResizeObserver` e aplica o resultado do módulo acima. | Tira ~20 linhas de JSX e toda a preocupação de medição de `Room.jsx`, que já tem 614 linhas. |
| `client/src/components/JoinRequestModal.jsx` | Modal centralizado de pedidos de entrada. | Decisão 3.5. |
| `client/test/gridLayout.test.mjs` | Testes do módulo de cálculo. | Fixa a regra de layout como contrato, no mesmo padrão de `audioLevels.test.mjs`. |

### Frontend — arquivos modificados

| Arquivo | O que muda | Por quê |
|---|---|---|
| `client/src/pages/Room.jsx` | (a) `<Toasts />` e `<JoinRequestModal />` sobem para um wrapper comum, renderizado em todas as fases, antes dos `return` antecipados; (b) o bloco `.pending-requests` inline é removido do ramo `in-call`; (c) `.video-grid` inline é substituída por `<VideoGrid tiles={...} audioLevels={...} />`; (d) o texto do link de convite passa a ocupar uma faixa de altura fixa (linha única, truncada). Nenhuma mudança em estado, handlers, mesh ou sinalização. | Estrutura do shell e promoção do modal. |
| `client/src/styles.css` | `.room` ganha altura de viewport e `overflow: hidden`; nova estrutura de faixas (topo/palco/rodapé); `.video-grid` passa a grade dirigida por custom properties com conteúdo centrado; `.video-tile` muda para 16:9; `<video>` passa a `contain`; novas regras `.modal-backdrop` / `.join-request-modal`; `.pending-requests` / `.pending-request` são reescritas ou removidas; `.invite-hint` vira linha única truncada; ajuste do breakpoint 720px. | Toda a mudança visual/estrutural mora aqui. |
| `client/src/components/VideoTile.jsx` | Possivelmente nenhuma mudança de comportamento; no máximo a simplificação da prop `contain`, que deixa de controlar `object-fit` e passa a controlar apenas o fundo. **A estrutura de classes (`video-tile`, `speaking`, `video-label`) e o `<video>` sempre montado não podem mudar.** | O e2e e o indicador de fala dependem dessas classes; o `<video>` montado é o que mantém o áudio do peer com a câmera desligada. |
| `client/src/components/ChatPanel.jsx` | Nenhuma mudança esperada. Verificar apenas que o painel já tem scroll interno próprio (`.chat-messages { overflow-y: auto }` — tem) e não força altura no palco. | O chat divide o palco com a grade; ele não pode ser o vazamento de altura. |

### Backend / banco / infra

Nada. Esta demanda é 100% de camada de apresentação no client. Nenhum endpoint, nenhum evento Socket.IO, nenhum schema — coerente com `ARCHITECTURE.md` §5 e §6.

---

## 5. Contratos de Interface

Não há endpoints REST, eventos de tempo real ou schema de banco novos ou alterados. Os contratos relevantes são internos ao client.

### 5.1 Contrato do módulo de cálculo — `lib/gridLayout.js`

**Entrada** (objeto único):

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `width` | número (px) | sim | Largura útil do container da grade (já descontado o chat, se aberto). |
| `height` | número (px) | sim | Altura útil do container da grade. |
| `count` | inteiro ≥ 0 | sim | Quantidade de tiles a acomodar. |
| `aspect` | número | não (default 16/9) | Proporção largura/altura do tile. |
| `gap` | número (px) | não (default 12) | Espaçamento entre tiles, nos dois eixos. |
| `minTileWidth` | número (px) | não (default 120) | Piso de legibilidade; abaixo dele o layout declara estouro. |

**Saída:**

| Campo | Tipo | Descrição |
|---|---|---|
| `cols` | inteiro ≥ 1 | Número de colunas. |
| `rows` | inteiro ≥ 1 | `ceil(count / cols)`. |
| `tileWidth` | número (px) | Largura de cada tile. Sempre ≥ `minTileWidth` quando `count > 0`. |
| `tileHeight` | número (px) | `tileWidth / aspect`. |
| `overflow` | booleano | `true` quando o piso de largura foi aplicado e o conjunto não cabe na altura disponível. |

**Pseudológica** (descrição, não implementação):

1. Se `count` for 0, ou `width`/`height` não forem números finitos e positivos (caso do primeiro render, antes da primeira medição), devolver um resultado neutro: `cols = 1`, `tileWidth = 0`, `overflow = false`. O componente trata `tileWidth = 0` como "ainda não medido" e não pinta a grade com tamanho errado.
2. Para cada candidato de colunas `c` de 1 até `count`:
   - `r = ceil(count / c)`
   - largura disponível por tile: `(width - gap * (c - 1)) / c`
   - altura disponível por tile: `(height - gap * (r - 1)) / r`
   - largura efetiva do tile nessa configuração: `min(larguraDisponível, alturaDisponível * aspect)`
   - descartar candidatos com largura efetiva ≤ 0.
3. Escolher o candidato de maior largura efetiva. **Empate desempata pelo menor número de colunas** (grades mais "quadradas" e estáveis; sem esse critério o resultado oscila entre configurações equivalentes a cada pixel de resize).
4. Se nenhum candidato produziu largura positiva, ou se a largura vencedora ficou abaixo de `minTileWidth`: fixar `tileWidth = minTileWidth`, recalcular `cols` como o máximo de colunas que cabem nessa largura (mínimo 1) e marcar `overflow = true`.
5. `tileHeight = tileWidth / aspect`; arredondar para baixo (evita que erro de arredondamento de subpixel force uma linha extra).

### 5.2 Contrato de estilo — custom properties escritas pelo `VideoGrid`

O componente escreve **apenas** estas propriedades no container `.video-grid` (via `style`), e o CSS consome:

| Propriedade | Valor | Consumo no CSS |
|---|---|---|
| `--grid-cols` | inteiro | `grid-template-columns: repeat(var(--grid-cols), var(--tile-w))` |
| `--tile-w` | comprimento (px) | largura da coluna |
| `--grid-gap` | comprimento (px) | `gap` |

O container é `display: grid` com `justify-content: center` e `align-content: center`, para que a grade fique centrada quando sobra espaço. Estado de estouro é sinalizado por uma classe no container (ex.: `.video-grid.overflowing`) que habilita `overflow-y: auto`. Tiles não recebem estilo inline — a altura vem de `aspect-ratio` no `.video-tile`.

### 5.3 Contrato do modal — `JoinRequestModal.jsx`

| Aspecto | Contrato |
|---|---|
| Props | `requests` (array de `{ requesterId, displayName }`), `onApprove(requesterId)`, `onDeny(requesterId)`. |
| Renderização | Não renderiza nada quando `requests` está vazio. |
| Rótulos dos botões | Exatamente **"Aprovar"** e **"Negar"** — texto acessível preservado (o e2e depende de `getByRole('button', { name: 'Aprovar' })`). |
| Semântica | `role="dialog"` + `aria-modal="true"` + `aria-labelledby` apontando para o título do modal. |
| Foco | Ao abrir, foco no primeiro botão "Aprovar". |
| Fechamento | **Não fecha** por `Esc` nem por clique no backdrop. O modal só some quando a fila esvazia por decisão explícita (aprovar/negar cada pedido). Um fechamento acidental deixaria alguém esperando indefinidamente. |
| Empilhamento | `z-index` acima dos toasts (hoje `20`). Sugerido: backdrop `30`, conteúdo `31`. |
| Interação | O backdrop escurece e bloqueia cliques na UI de trás; o conteúdo do modal recebe cliques normalmente. |

---

## 6. Dependências e Ordem de Implementação

1. **`lib/gridLayout.js`** — módulo puro. Não depende de nada. Fundação de tudo.
2. **`client/test/gridLayout.test.mjs`** — pode ser escrito junto com (1); serve de validação imediata antes de qualquer CSS existir.
3. **CSS do shell** (`.room` altura fixa, faixas topo/palco/rodapé, `overflow: hidden`) — independente de (1) e (2); **pode rodar em paralelo**.
4. **`VideoGrid.jsx`** + CSS da grade e do tile 16:9 — depende de (1) e de (3).
5. **`JoinRequestModal.jsx`** + CSS do modal — depende apenas de (3); **pode rodar em paralelo com (4)**.
6. **Reestruturação de `Room.jsx`** — depende de (4) e (5): monta o wrapper comum, remove o bloco inline de pedidos, troca a grade pelo componente.
7. **Ajuste das fases `waiting` / `denied` / formulário de nome** — depende de (3) e (6).
8. **Validação**: lint → teste unitário → e2e (ver §9).

---

## 7. Riscos e Armadilhas

### Risco: loop de `ResizeObserver`

- **Risco:** medir um elemento cujo tamanho depende do próprio conteúdo produz o clássico `ResizeObserver loop completed with undelivered notifications` — a medição muda os tiles, os tiles mudam o container, e assim por diante.
- **Mitigação:** o container observado deve ter tamanho **imposto pelo pai**, nunca pelos filhos: `flex: 1; min-height: 0; min-width: 0`, dentro de um palco que já é `min-height: 0`. Além disso, só chamar `setState` quando as dimensões arredondadas (inteiros) mudarem — subpixel de scrollbar/zoom gera oscilação infinita se comparado como float.
- **Anti-pattern a evitar:** observar `document.body` ou o `.room` inteiro e derivar a caixa da grade por subtração de constantes. Parece equivalente e é o caminho mais curto para o layout quebrar quando um banner de erro aparece ou o chat abre.

### Risco: `min-height: 0` esquecido em algum nível da cadeia flex

- **Risco:** um item flex tem `min-height: auto` por padrão; basta um nível sem `min-height: 0` para o conteúdo voltar a empurrar a coluna e ressuscitar o scroll de página — o bug original, agora escondido atrás de `overflow: hidden` (conteúdo simplesmente clipado e invisível).
- **Mitigação:** `min-height: 0` em **todos** os containers intermediários entre `.room` e o `.video-grid`. `.stage` já tem; o novo nível da grade precisa também.
- **Anti-pattern a evitar:** resolver o vazamento colocando `overflow: hidden` em nós intermediários. Isso esconde o sintoma e faz o tile ser cortado em silêncio.

### Risco: `100vh` em mobile deixa o rodapé sob a barra do navegador

- **Risco:** entrega "sem scroll" no desktop e com controles inalcançáveis no celular — a mesma dor, outro dispositivo.
- **Mitigação:** decisão 3.1 (`100vh` seguido de `100dvh`). Validar no breakpoint de 720px com o chat aberto.

### Risco: quebrar seletores dos quais o e2e depende

- **Risco:** a suíte e2e (`e2e/run.mjs`, `e2e/harness.mjs`) é o único teste de integração real do projeto e depende de detalhes de DOM que não são óbvios:
  - `.video-tile` como contagem de tiles (linhas 132, 304, 310, 327, 565) e `.video-tile.speaking` (163);
  - `document.querySelector('.video-tile')` (202) assume que o **primeiro** tile do DOM é o local — a ordem da lista em `Room.jsx` (local, tela local, remotos) precisa ser preservada;
  - `[...document.querySelectorAll('.controls button')].find(b => b.textContent === 'Silenciar' || b.textContent === 'Ativar mic')` (204) faz comparação **exata** de `textContent`;
  - `getByRole('button', { name: 'Aprovar' })` em `harness.mjs:205`, iterado até a contagem zerar.
- **Mitigação:** manter as classes `video-tile`, `speaking`, `controls`; manter a ordem dos tiles; manter os textos dos botões **sem** acrescentar ícones, `<span>`s ou espaços dentro do botão de mic; manter "Aprovar"/"Negar" como nome acessível no modal. Se algum desses precisar mudar, atualizar o e2e no mesmo commit.
- **Anti-pattern a evitar:** "melhorar" os botões com ícone/emoji junto do texto. `textContent` vira `'🔇Silenciar'` e o e2e falha longe da causa.

### Risco: modal bloqueia cliques do Playwright

- **Risco:** o backdrop cobrindo o conteúdo do modal (ordem de empilhamento invertida, ou backdrop declarado depois com `z-index` maior) faz o clique em "Aprovar" ser interceptado — o Playwright reporta "element is not clickable / intercepted", e o e2e trava no fluxo de entrada.
- **Mitigação:** backdrop e conteúdo em `z-index` explícitos e distintos; conteúdo por cima. Validar clicando "Aprovar" com dois pedidos pendentes simultâneos.

### Risco: `overflow: hidden` esconder conteúdo de fases não-`in-call`

- **Risco:** o formulário de nome, a tela de "acesso não liberado" e a de "aguardando aprovação" compartilham a classe `.room`. Com altura fixa e `overflow: hidden`, texto longo (ex.: mensagem de erro em janela baixa) some.
- **Mitigação:** aplicar altura fixa + `overflow: hidden` ao ramo `in-call` e permitir scroll **interno** (não de página) nas telas de fase textual, ou aplicar `overflow: auto` no bloco de conteúdo dessas fases.

### Risco: link de convite empurrando o rodapé

- **Risco:** `.invite-hint` renderiza a URL completa com `word-break: break-all` no `<code>`. Em janelas estreitas isso vira 3–4 linhas e rouba altura do palco a cada resize.
- **Mitigação:** faixa de linha única com `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`, mantendo a URL completa acessível via `title`. Altura previsível, e a grade recalcula do mesmo jeito se ela mudar.

### Risco: letterbox excessivo em compartilhamento de tela

- **Risco:** telas ultrawide ou em retrato ficam com barras grandes dentro de um tile 16:9 do mesmo tamanho dos demais.
- **Mitigação:** aceito nesta entrega — a grade é uniforme por decisão (§2, fora de escopo). Se virar dor real, a resposta é um layout de destaque, não uma proporção especial por tile.

---

## 8. Critérios de Aceite Técnicos

**Layout de viewport fixo**

1. Na fase `in-call`, em qualquer viewport entre 360×640 e 2560×1440, `document.body.scrollHeight` não excede `window.innerHeight` e `document.scrollingElement.scrollTop` permanece 0 (não há como rolar).
2. O `getBoundingClientRect()` da barra `.controls` está inteiramente dentro do viewport (`bottom <= window.innerHeight`) com 1, 2, 3 e 6 participantes, com chat aberto e fechado, e com o banner de erro de mídia visível.
3. Abrir e fechar o chat não gera scroll de página e faz a grade recalcular: a largura do tile diminui ao abrir e volta ao valor anterior ao fechar.

**Grade automática**

4. Com 1 tile, a grade é 1×1 e o tile ocupa o maior retângulo 16:9 que cabe no palco — sem exceder a altura disponível (o bug reportado deixa de reproduzir).
5. Com 2 tiles num palco em paisagem, o resultado é 2 colunas × 1 linha; com o mesmo palco em retrato, 1 coluna × 2 linhas.
6. Para qualquer entrada válida, `cols * tileWidth + gap * (cols - 1) <= width` e `rows * tileHeight + gap * (rows - 1) <= height`, exceto quando `overflow` for `true`.
7. Quando o espaço não permite o tamanho mínimo de tile, o container da grade rola internamente e **a página continua sem rolar**; os controles continuam visíveis.
8. Antes da primeira medição (`width`/`height` iguais a 0), a grade não pinta tiles com tamanho inválido nem lança exceção.

**Proporção**

9. Todo `.video-tile` tem razão largura/altura de 16:9 (tolerância de ±1px de arredondamento) e todo `<video>` dentro dele usa `object-fit: contain` — nenhuma parte da imagem da câmera é cortada e nenhuma é esticada.

**Modal de aprovação**

10. Quando chega um `join-request`, um modal centralizado aparece sobreposto ao conteúdo, com `role="dialog"` e `aria-modal="true"`, visível sem qualquer rolagem, em qualquer estado da tela (grade cheia, chat aberto, banner de erro presente).
11. Com N pedidos pendentes simultâneos, o modal lista os N, cada um com botões de nome acessível "Aprovar" e "Negar"; aprovar/negar remove aquela linha; o modal desaparece quando a última é resolvida.
12. Pressionar `Esc` ou clicar no backdrop **não** fecha o modal.
13. Ao abrir, o foco está no primeiro botão "Aprovar".
14. Os toasts continuam visíveis e o modal fica **acima** deles quando ambos coexistem.

**Não-regressão**

15. `npm run lint` e `npm test` em `client/` passam; a suíte e2e completa passa sem alteração de comportamento em: contagem de tiles, indicador de fala, compartilhamento de tela (início e fim, incluindo o botão da barra do navegador), chat e saída de participante.
16. Nenhum evento novo no servidor de sinalização; `server/` permanece intocado.

---

## 9. Notas para os Agentes de Implementação

### Divisão sugerida

- **Agente de frontend (único responsável):** todos os itens de §6. A demanda é coesa demais para dividir entre agentes — o CSS do shell, o cálculo da grade e a reestruturação de `Room.jsx` só fazem sentido validados juntos.
- Se houver um agente de QA/e2e separado, ele assume o item 8 de §6 e a validação de §8.

### Pitfalls específicos desta demanda (não estão em `ARCHITECTURE.md`)

- `Room.jsx` tem três `return` antecipados (sem nome, `DENIED`, `CONNECTING`/`WAITING_APPROVAL`) antes do JSX principal. `<Toasts />` e `<JoinRequestModal />` precisam ser içados para **antes** deles, num fragmento comum — caso contrário o requisito "sobre qualquer estado da tela" não é atendido.
- `tiles` é um `useMemo` cujas deps incluem `sharingScreen`, `cameraOff` e `muted` porque lê refs (`localStreamRef`, `screenStreamRef`). Ao mover o `map` para `VideoGrid`, **não** mexer nessa lista de dependências nem no comentário que a justifica: mudar isso quebra a atualização do tile local ao ligar/desligar câmera.
- O `<video>` do `VideoTile` nunca pode ser desmontado nem receber `display: none` — é ele que reproduz o áudio do peer com a câmera desligada (há comentário no arquivo explicando). Se o tile virar `overflow` fora da área visível do container rolável, ele continua montado — está correto.
- `object-fit` do tile e o fundo: `contain` sobre `var(--surface)` deixa as barras cinzas; para compartilhamento de tela o fundo preto atual é melhor. Manter a distinção pelo fundo, não pelo `object-fit`.
- O `gap` usado no CSS e o `gap` passado ao módulo de cálculo têm que ser **o mesmo número**. Definir uma constante única no módulo e injetá-la no CSS via `--grid-gap` (contrato §5.2) — duas fontes de verdade aqui produzem um erro de alguns pixels que só aparece com 6 participantes em janela apertada.
- Arredondar `tileWidth`/`tileHeight` para baixo. Arredondar para cima produz exatamente o overflow de uma linha que esta task existe para eliminar.

### Ordem recomendada de validação

1. `cd client && npm test` — o módulo de grade deve estar verde antes de qualquer ajuste visual.
2. `cd client && npm run lint`.
3. Verificação manual no navegador, nesta ordem: 1 participante em janela larga (o caso do bug), depois 2, 3 e 6 (abas), depois janela redimensionada para muito baixa (estouro), depois com chat aberto, depois em viewport móvel (~390×844) com a barra de endereço visível e escondida.
4. Modal: abrir a sala em duas abas, entrar com a segunda, confirmar que o modal aparece centralizado na primeira sem rolagem, com toast simultâneo, e que `Esc`/clique no backdrop não fecham.
5. Suíte e2e completa (`cd e2e && npm test`). Ela é sensível a texto de botão e à ordem dos tiles — ver §7. Se o ambiente headless bloquear a execução, registrar o bloqueio explicitamente em vez de declarar a validação feita (há precedente disso em `claude-progress.md`).
6. Atualizar `ARCHITECTURE.md` com uma subseção curta sobre o layout da sala (o documento cobre presença, chat e indicador de fala em §6, mas nada sobre layout) e registrar o progresso em `claude-progress.md`.
