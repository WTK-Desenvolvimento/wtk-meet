# Classificação do erro do YouTube e recuperação de falha transitória — Documento de Arquitetura Técnica

> Gerado em: 2026-08-21
> Status: Rascunho
> Task: WTK-MEET-13 — "Classificar o código de erro do YouTube e recuperar falhas
> transitórias em vez de pular a faixa"
> Branch: `agent/wtk-meet-13-classificar-o-c-digo-de-erro-do-youtube-`

---

## 1. Contexto e Objetivo

### O sintoma

Uma faixa do YouTube entra na fila, toca ~2 segundos, pula sozinha, e a sala
inteira vê *"'X' não pode ser tocada aqui (vídeo indisponível ou sem
incorporação)"*. É **intermitente**: o mesmo vídeo às vezes toca inteiro.

### A causa, na ordem em que ela acontece

1. **O código do erro é emitido, mas cai no parâmetro errado.**
   `client/src/lib/youtubePlayer.js:247` emite
   `this.onError?.('youtube-error', event?.data)` — o segundo argumento é o
   **código numérico** da IFrame API (2, 5, 100, 101, 150, 153).

2. **Do outro lado, o segundo parâmetro se chama `entryId`.**
   `client/src/lib/useMusicRoom.js:270` declara `handlePlayerError(code, entryId)`
   e faz `typeof entryId === 'string' ? entryId : playback.entryId`. Como o
   código é um número, a guarda o descarta em silêncio e o handler cai no
   fallback. **O código nunca é lido, nunca é logado, nunca influencia nada.**

3. **Logo, todos os erros recebem o mesmo tratamento:** aviso genérico +
   `advanceFrom(id, 'error')`, que tira a faixa da fila da sala inteira. Só que os
   códigos significam coisas diferentes:

   | Código | Significado (IFrame API) | Natureza | Tratamento correto |
   |---|---|---|---|
   | 2 | Parâmetro inválido — `videoId` malformado | permanente | pular; avisar que o link não é um vídeo válido |
   | 5 | Falha do player HTML5 | **transitório** | recarregar e tentar de novo |
   | 100 | Vídeo removido ou privado | permanente | pular; avisar indisponibilidade |
   | 101 / 150 | Dono do vídeo bloqueou a incorporação | permanente | pular; avisar que **só toca no YouTube** |
   | 153 | Referrer recusado | **transitório / configuração** | recarregar e tentar de novo |
   | outro / ausente | Não documentado | desconhecido | pular com mensagem genérica, **e logar o código** |

   Hoje um soluço de player custa a faixa para todo mundo, sem nenhuma tentativa
   de recuperação. E como o erro 5 e o 153 são justamente os que aparecem "às
   vezes", eles explicam o caráter intermitente do relato.

4. **Hipótese secundária, ainda não confirmada:** `playerVars`
   (`youtubePlayer.js:218`) não passa `origin`. A IFrame API documenta `origin`
   como recomendado e sua ausência é causa conhecida de erro 153 intermitente.
   Isto **não é premissa desta entrega** — o log do item 3 é justamente o
   instrumento que fecha o diagnóstico. `origin` e `enablejsapi` entram de
   qualquer forma, por conformidade com a API documentada.

### Comportamento esperado depois da entrega

- Todo erro do player YouTube chega ao handler **com o código** e vira uma linha
  de `console.warn` com `videoId`, `entryId`, código e classificação.
- Erro permanente (2, 100, 101, 150) pula a faixa **na hora**, com uma mensagem
  em pt-BR que diz o que de fato aconteceu — em especial 101/150, que passa a
  dizer que o vídeo só pode ser ouvido no YouTube, informação acionável.
- Erro transitório (5, 153) provoca **uma única** recarga do player na posição
  corrente, no peer que errou. Deu certo, a sala nem percebe. Deu errado de novo,
  cai no caminho de pular, com a mensagem genérica.
- A retentativa **nunca** vira laço: o contador é por `entryId` e trocar de faixa
  o zera.
- Quem pula a faixa continua sendo **exclusivamente o dono** (`isOwner()`).

---

## 2. Escopo

**Dentro do escopo:**

- Trocar a assinatura do callback de erro dos dois tocadores
  (`YouTubeTrackPlayer` e `MusicEngine`) por um **objeto**, eliminando a classe de
  bug de argumento posicional.
- Classificação pura do código do YouTube, exportada e testável.
- Política pura de decisão (retentar / pular / só avisar), incluindo o contador
  por `entryId` e a guarda de propriedade.
- Retentativa única, local ao peer, na posição estimada da faixa.
- Mensagens em pt-BR distintas por classe de erro.
- `console.warn` de diagnóstico com contexto.
- `origin` e `enablejsapi` em `playerVars`, com guarda para ambiente sem `window`.
- Testes unitários em `client/test/youtubePlayer.test.mjs`; ajuste dos testes
  existentes que assertam a assinatura posicional
  (`youtubePlayer.test.mjs`, `musicEngine.test.mjs`).

**Fora do escopo:**

- Validar o link do YouTube **antes** de entrar na fila (é a WTK-MEET-14).
- O bug de buffering no heartbeat de posição (task própria).
- Qualquer forma de replicar o erro entre peers ("avisar a sala que o meu player
  falhou"). O erro é local e continua local.
- Retentativa para as origens arquivo/URL (`MusicEngine`): elas migram para o
  payload em objeto, mas o tratamento delas não muda.
- Backoff progressivo, mais de uma retentativa, ou fila de retentativas.
- Mudar o texto do aviso de privacidade da origem YouTube.

---

## 3. Decisões Arquiteturais

### D1 — O evento de erro vira um objeto, nos dois tocadores

- **Decisão:** `onError` passa a receber um único argumento:
  `{ reason, code, entryId, videoId }`, com os campos ausentes simplesmente
  omitidos. `YouTubeTrackPlayer` emite `{ reason: 'youtube-error', code, videoId }`;
  `MusicEngine` emite `{ reason: 'media-error' | 'missing-file' |
  'unsupported-kind' | 'no-audio-context' | 'graph-error', entryId }`.
- **Motivação:** o bug desta task é *exatamente* um erro de posição de argumento,
  silencioso porque o tipo passou na guarda. Nomear os campos elimina a classe
  inteira, não só a instância. É o que o `scope` do card pede em 1.
- **Alternativas descartadas:**
  - *Só inverter a ordem dos parâmetros* — conserta o caso e mantém a armadilha
    viva para o próximo campo que alguém acrescentar.
  - *Manter compatibilidade aceitando os dois formatos no handler* — dois
    formatos vivos ao mesmo tempo é o que garante que o antigo nunca morre. São
    sete pontos de emissão, todos neste repo: migram juntos.

### D2 — A tabela de códigos mora em `youtubePlayer.js`, pura e exportada

- **Decisão:** `classifyYouTubeError(code)` é função pura exportada de
  `client/src/lib/youtubePlayer.js`.
- **Motivação:** o cabeçalho do arquivo declara que a dependência de terceiro é
  "confinada de propósito num arquivo só, que dá para desligar inteiro por flag".
  A tabela de códigos **é** conhecimento sobre esse terceiro — mora com ele.
  Sendo pura e exportada, `client/test/youtubePlayer.test.mjs` a cobre sem DOM e
  sem `window`, que é onde o DoD 1 pede a cobertura.
- **Alternativas descartadas:**
  - *`musicSources.js`* — módulo de validação de entrada hostil, sem relação.
  - *Inline no handler do hook* — é o formato de hoje, e é o que impede o teste:
    `useMusicRoom.js` é um hook React e o cliente não tem test renderer nas
    devDependencies (`npm test` é `node --test`).

### D3 — A política de decisão também é pura, e recebe `isOwner` como entrada

- **Decisão:** `planYouTubeError({ code, entryId, title, isOwner, attempts })`
  devolve `{ kind, code, action, notice, attempts }`, onde `action` é
  `'retry' | 'skip' | 'notice-only'`. Vive ao lado de `classifyYouTubeError`, em
  `youtubePlayer.js`. O hook não decide nada: ele lê a decisão e age.
- **Motivação:** é o mesmo desenho já usado no repo para a fila —
  `planAdvance` (`musicSession.js`) decide, `advanceFrom` (`useMusicRoom.js`) age.
  Com `isOwner` **entrando na função pura**, "peer não-dono nunca gera pulo" vira
  uma asserção de teste unitário (DoD 2) em vez de uma inspeção de código. Mesma
  coisa para o contador (DoD 3).
- **Nota de leitura do DoD:** o DoD 1–3 pede esses testes em
  `client/test/youtubePlayer.test.mjs`. Com D2/D3 isso é literalmente possível,
  porque a decisão inteira é pura e vive naquele módulo. O que **não** fica
  coberto por `node:test` é a camada de ação dentro do hook (chamar `showNotice`,
  `advanceFrom`, `player.load`) — ela é deliberadamente fina, sem ramificação
  própria, e se verifica no E2E/manual. Registrar isso no `claude-progress.md`.

### D4 — A política de decisão vale para os erros do YouTube; o resto segue o caminho genérico

- **Decisão:** `planYouTubeError` trata `reason === 'youtube-error'`. Os erros do
  `MusicEngine` continuam com o comportamento de hoje (aviso genérico + pulo se
  for o dono), agora lendo `entryId` de um campo nomeado.
- **Motivação:** só o YouTube tem código transitório conhecido. Um `media-error`
  de arquivo/URL não é recuperável por recarga (o arquivo é o mesmo, a URL é a
  mesma) e retentar ali é gastar segundos de silêncio sem chance de sucesso.
- **Alternativa descartada:** uma política única para os dois tocadores. Custaria
  um vocabulário artificial de "transitório" para casos que não são.

### D5 — A retentativa recarrega o envelope diretamente, sem passar pela reconciliação

- **Decisão:** o hook ganha uma função de retentativa que chama
  `youtubeRef.current.load(entry.sourceRef, { startSeconds, autoplay })`
  diretamente, com `startSeconds = estimatePosition(playback, performance.now())`
  e `autoplay = playback.playing`, protegida pelo `loadTokenRef` já existente e
  por uma reconferência de `entryId`. **`loadedRef` não é invalidado** — a faixa é
  a mesma, e a assinatura carregada continua verdadeira.
- **Motivação:** o caminho "óbvio" (zerar `loadedRef` e deixar `reconcilePlayback`
  recarregar) tem um laço escondido: o dono republica posição a cada 5s, cada
  republicação incrementa `playback.version`, e `version` está nas dependências do
  efeito de reconciliação. Com `loadedRef` nulo, todo heartbeat do dono viraria
  uma recarga nova no peer que falhou — recarga infinita a cada 5 segundos, que é
  exatamente o "laço infinito de reload" que o `scope` 4 proíbe, só que por uma
  porta lateral.
- **Alternativas descartadas:**
  - *Invalidar `loadedRef` + um contador nas dependências do efeito* — acima.
  - *Colocar o retry dentro do `YouTubeTrackPlayer`* — o envelope não conhece
    `entryId` nem o estado replicado, e a posição correta para retomar é a
    **estimada pelo estado da sala**, não a do player que acabou de morrer.

### D6 — Existe uma janela de silêncio de publicação entre o erro e o fim da retentativa

- **Decisão:** enquanto houver erro sendo tratado ou retentativa em andamento, o
  temporizador de 5s do dono **não publica**. O hook mantém uma marca em `ref`
  para essa janela; o efeito de publicação sai cedo quando ela está ativa, do
  mesmo jeito que já sai quando `player.loading` é verdadeiro.
- **Motivação:** um `YT.Player` que acabou de emitir erro devolve
  `getPlayerState() !== 1`, ou seja `playing === false`, e uma posição congelada.
  Publicar isso é anunciar **`playing: false` como estado autoritativo para a sala
  inteira** — a mesma falha que a WTK-MEET-12 corrigiu, reintroduzida por outra
  porta. `player.loading` cobre só o intervalo do `load()`; a janela entre o erro
  e o disparo da recarga fica descoberta sem essa marca.
- **Alternativa descartada:** recarregar de forma síncrona no próprio handler
  para não ter janela. Uma recarga imediata sobre o iframe que acabou de falhar
  tem a menor chance de sucesso de todas — a espera curta é o que dá valor à
  retentativa.

### D7 — Uma retentativa, com atraso curto, contada por `entryId`

- **Decisão:** no máximo **uma** retentativa por `entryId`, disparada depois de um
  atraso curto (~700 ms, constante nomeada no módulo do hook). O estado do
  contador é `{ entryId, count }` — um só, porque só existe uma faixa corrente:
  se o `entryId` do erro não é o do contador, o contador reinicia em zero.
- **Motivação:** cobre o soluço de player, que é o caso relatado, sem transformar
  um vídeo que erra sempre em segundos de tentativa. O formato `{ entryId, count }`
  faz "trocar de faixa zera o contador" (DoD 3) cair de graça, sem varredura de
  `Map` nem limpeza.
- **Alternativa descartada:** `Map` de `entryId → tentativas`. Cresce sem limite
  ao longo da sessão e exige política de expiração para um dado que só interessa
  para a faixa que está tocando **agora**.

### D8 — O timer da retentativa é cancelável, e a troca de faixa cancela

- **Decisão:** o `setTimeout` da retentativa fica num `ref`, é cancelado quando a
  faixa corrente muda, quando o componente desmonta, e é reconferido ao disparar
  (`entryId` corrente ainda é o mesmo? o token de carga ainda é o meu?).
- **Motivação:** sem isso, uma retentativa agendada durante a faixa A dispara
  depois de a faixa B já estar tocando e **carrega o vídeo A por cima do B** — um
  bug intermitente, difícil de reproduzir, e do mesmo gênero do `ENDED` atrasado
  que a `generation` do envelope existe para conter.

### D9 — `origin` derivado de `window.location`, nunca fixo

- **Decisão:** `playerVars` ganha `enablejsapi: 1` e `origin`, este último
  **apenas** quando `typeof window !== 'undefined'`, `window.location?.origin`
  existe e é uma origem `http`/`https` de verdade (não `"null"`, que é o que um
  contexto `file://` produz). Sem isso, a chave `origin` simplesmente não entra no
  objeto.
- **Motivação:** conformidade com a API documentada, e é a hipótese em teste para
  o 153. A guarda existe porque a suíte roda em `node:test` com um `window`
  dublê — os testes atuais montam `globalThis.window = { YT }`, **sem `location`**.
- **Anti-pattern explícito:** `origin` com o domínio de produção escrito à mão.
  Um `origin` que não bate com a página faz a IFrame API recusar **todos** os
  vídeos — trocaria um erro intermitente por uma quebra total, inclusive em
  `localhost`.

---

## 4. Componentes Afetados

### `client/src/lib/youtubePlayer.js`

| O que muda | Por quê |
|---|---|
| Novo export puro `classifyYouTubeError(code)` | D2 — a tabela de códigos vive junto do terceiro e fica testável |
| Novo export puro `planYouTubeError({...})` | D3 — decisão fora do hook, e por isso verificável em `node:test` |
| Novas constantes de mensagem em pt-BR por classe de erro | DoD 6 — texto acionável, coberto por teste |
| `onError` do `YT.Player` passa a emitir o objeto `{ reason: 'youtube-error', code, videoId }` | D1 — fim do argumento posicional |
| `playerVars` ganha `enablejsapi: 1` e `origin` condicional | D9 — conformidade e hipótese do 153 |

Não mudam: `generation`, `_teardown`, `load`, `stop`, `destroy`, `loading`,
`fetchYouTubeTitle`, `isYouTubeEnabled`. O envelope **não** ganha retentativa
própria (D5).

### `client/src/lib/musicEngine.js`

| O que muda | Por quê |
|---|---|
| Os cinco `this.onError?.(...)` passam a emitir `{ reason, entryId }` | D1 — um formato só de evento de erro para os dois tocadores |

Nenhuma mudança de comportamento (D4).

### `client/src/lib/useMusicRoom.js`

| O que muda | Por quê |
|---|---|
| `handlePlayerError` recebe **um objeto**; resolve o `entryId` por `videoId` quando o evento vem do YouTube | corrige o descarte silencioso do código e evita agir sobre a faixa errada |
| `handlePlayerError` chama `planYouTubeError` e apenas executa a decisão | D3 |
| `console.warn` com `videoId`, `entryId`, código e classificação | `scope` 7 — instrumento de diagnóstico |
| Novo `ref` do contador `{ entryId, count }` | D7 |
| Novo `ref` do timer de retentativa + cancelamento na troca de faixa/desmonte | D8 |
| Novo `ref` da janela "erro em tratamento" e saída antecipada no efeito de publicação de posição | D6 |
| Nova função de retentativa (carrega direto no envelope, com token e reconferência de `entryId`) | D5 |
| `advanceFrom(id, 'error')` continua atrás de `isOwner()` | restrição do card, inegociável |

### `client/test/youtubePlayer.test.mjs`

| O que muda | Por quê |
|---|---|
| O caso "vídeo privado, removido ou com incorporação bloqueada…" passa a assertar o **objeto** | D1 |
| O caso AC6 (evento de player derrubado) idem | D1 |
| Bloco novo cobrindo classificação, política, contador, propriedade e mensagens | DoD 1–3, 6 |
| Caso novo: `playerVars` com e sem `window.location` | D9 |

### `client/test/musicEngine.test.mjs`

| O que muda | Por quê |
|---|---|
| As asserções `[['no-audio-context','e1']]`, `[['media-error','e1']]` e a de `['missing-file','unsupported-kind']` passam a comparar objetos | D1 |

### Documentação

| O que muda | Por quê |
|---|---|
| `claude-progress.md`: registro critério a critério | DoD 8 |
| `ARCHITECTURE.md` §6.9: parágrafo curto com a tabela de códigos e a regra de retentativa local | o comportamento de erro do player passa a ser uma regra do sistema, não um detalhe de implementação (recomendado, não exigido pelo DoD) |

---

## 5. Contratos de Interface

Não há endpoint REST, evento de rede nem schema de banco nesta entrega — **nada
disto trafega entre peers**. O que segue é o contrato interno entre módulos.

### Evento de erro dos tocadores (interno, callback `onError`)

| Campo | Tipo | Quem preenche | Observações |
|---|---|---|---|
| `reason` | string | ambos | `'youtube-error'` \| `'media-error'` \| `'missing-file'` \| `'unsupported-kind'` \| `'no-audio-context'` \| `'graph-error'` |
| `code` | number \| null | só YouTube | o `event.data` cru da IFrame API; `null` quando ausente |
| `videoId` | string | só YouTube | permite ao hook conferir se o erro é da faixa corrente |
| `entryId` | string | só `MusicEngine` | o YouTube não conhece `entryId`; quem resolve é o hook |

### `classifyYouTubeError(code)` — pura

| Entrada | Saída |
|---|---|
| `code: number \| null \| undefined` | `{ code, kind, transient }` |

| `code` | `kind` | `transient` |
|---|---|---|
| 2 | `'invalid-id'` | `false` |
| 5 | `'html5'` | `true` |
| 100 | `'unavailable'` | `false` |
| 101, 150 | `'not-embeddable'` | `false` |
| 153 | `'referrer'` | `true` |
| qualquer outro, `null`, `undefined`, não-numérico | `'unknown'` | `false` |

> `'unknown'` é deliberadamente **não** transitório: sem evidência de que
> recarregar ajuda, o comportamento conservador é o de hoje (pular), e o
> `console.warn` com o código é o que permite reclassificar depois com dado real.

### `planYouTubeError({ code, entryId, title, isOwner, attempts })` — pura

| Entrada | Tipo | Observações |
|---|---|---|
| `code` | number \| null | vem do evento |
| `entryId` | string \| null | já resolvido pelo hook |
| `title` | string \| null | título da faixa; ausente vira "A faixa" na mensagem |
| `isOwner` | boolean | resultado de `isOwner()` no hook |
| `attempts` | `{ entryId, count }` | estado corrente do contador |

| Saída | Tipo | Observações |
|---|---|---|
| `kind`, `code` | — | repassados para o log |
| `action` | `'retry'` \| `'skip'` \| `'notice-only'` | ver tabela de decisão |
| `notice` | string | mensagem pt-BR pronta, já com o título embutido |
| `attempts` | `{ entryId, count }` | **novo** estado do contador; o hook só guarda |

**Tabela de decisão:**

| Situação | `action` |
|---|---|
| `transient` e `attempts.entryId !== entryId` (faixa nova) | `'retry'` (contador vai a 1) |
| `transient` e `attempts.entryId === entryId` e `count === 0` | `'retry'` (contador vai a 1) |
| `transient`, mesmo `entryId`, `count >= 1` **e** `isOwner` | `'skip'` |
| `transient`, mesmo `entryId`, `count >= 1` **e não** é dono | `'notice-only'` |
| permanente/desconhecido **e** `isOwner` | `'skip'` |
| permanente/desconhecido **e não** é dono | `'notice-only'` |
| `entryId` ausente | `'notice-only'` |

> `'skip'` **nunca** aparece com `isOwner: false`. Essa é a asserção que trava a
> restrição de arquitetura do card no nível do teste unitário.

### Mensagens (pt-BR) — texto observável, coberto por teste

| Classe | Mensagem |
|---|---|
| `'retry'` (qualquer classe transitória) | *"Falhou ao carregar “X”. Tentando de novo…"* |
| `'invalid-id'` | *"O link de “X” não é um vídeo válido do YouTube."* |
| `'unavailable'` | *"“X” não está mais disponível no YouTube (vídeo removido ou privado)."* |
| `'not-embeddable'` | *"O dono de “X” não permite tocar o vídeo fora do YouTube."* |
| `'html5'` / `'referrer'` esgotados, `'unknown'` | *"Não consegui tocar “X” aqui."* |

> Redação exata é do agente de implementação; o que o teste trava é que as
> classes produzem textos **distintos** e que 101/150 diz explicitamente que o
> vídeo só toca no YouTube.

### Linha de diagnóstico

`console.warn('[music] erro do player YouTube:', { videoId, entryId, code, kind, action })`
— prefixo `[music]`, que é a convenção já usada no arquivo.

---

## 6. Dependências e Ordem de Implementação

1. **`classifyYouTubeError` + `planYouTubeError` + constantes de mensagem** em
   `youtubePlayer.js` — puras, sem dependência de nada. Fundação de tudo.
2. **`playerVars` com `origin`/`enablejsapi`** (D9) — independente do item 1,
   pode ir em paralelo.
3. **Payload em objeto no `onError` do envelope** (D1) — independente do item 1.
4. **Payload em objeto no `musicEngine.js`** (D1) — paralelo ao item 3.
5. **Testes unitários novos e ajuste dos existentes** — depende de 1–4. Rode-os
   aqui, antes de mexer no hook: é o ponto em que a entrega já está provada, e é o
   que o DoD 1–3 cobra.
6. **`handlePlayerError` consumindo objeto + política + `console.warn`** no hook —
   depende de 1, 3 e 4.
7. **Contador, timer de retentativa, cancelamento e janela de silêncio de
   publicação** (D6, D7, D8) — depende de 6.
8. **`npm run lint --prefix client` e `npm test --prefix client`** — depende de
   tudo.
9. **`claude-progress.md` critério a critério, §6.9 do `ARCHITECTURE.md`, PR** —
   por último.

Os itens 2, 3 e 4 são independentes entre si; 1 pode ser escrito junto com os
testes do item 5.

---

## 7. Riscos e Armadilhas

### R1 — Recarga infinita pelo heartbeat de posição

- **Risco:** invalidar `loadedRef` para forçar a recarga faz o efeito de
  reconciliação disparar a cada `playback.version`, que o dono incrementa a cada
  5 segundos. O peer que falhou recarregaria o vídeo para sempre.
- **Mitigação:** D5 — a retentativa chama `load()` diretamente e **não** mexe em
  `loadedRef`.
- **Anti-pattern a evitar:** "é só zerar o `loadedRef` que a reconciliação
  resolve". Parece o caminho limpo, reusa código existente, e é o laço.

### R2 — Publicar `playing: false` durante o erro

- **Risco:** o dono erra, o player devolve estado parado, o temporizador de 5s
  publica `{ playing: false }` como estado autoritativo e **a sala inteira pausa**.
- **Mitigação:** D6 — janela de silêncio de publicação do momento do erro até o
  fim da retentativa.
- **Anti-pattern a evitar:** confiar só em `player.loading`. Ele cobre o `load()`,
  não o intervalo entre o erro e o disparo da recarga.

### R3 — Retentativa que carrega a faixa errada

- **Risco:** a retentativa é agendada na faixa A e dispara depois de a faixa B
  entrar; o vídeo A volta a tocar por cima.
- **Mitigação:** D8 — cancelar na troca de faixa e reconferir `entryId` e
  `loadTokenRef` no disparo **e** depois do `await`.
- **Anti-pattern a evitar:** achar que a `generation` do envelope basta. Ela
  protege contra evento **de** player velho; não contra um `load()` novo pedindo
  o vídeo velho.

### R4 — Agir sobre uma faixa que não é a do erro

- **Risco:** o fallback atual (`playback.entryId` quando o segundo argumento não é
  string) pula a faixa **corrente** por causa de um erro que veio de outra.
- **Mitigação:** resolver o `entryId` pelo `videoId` do evento (o hook já tem
  `currentIfVideo`); não casou com a faixa corrente, só loga e sai — sem aviso e
  sem pulo.
- **Anti-pattern a evitar:** manter o fallback "se não veio `entryId`, use o
  corrente". É metade da causa raiz desta task.

### R5 — Um emissor de `onError` esquecido na migração

- **Risco:** são sete pontos de emissão. Um esquecido passa a string antiga para
  um handler que espera objeto e produz aviso com `undefined` — silencioso.
- **Mitigação:** varrer `onError?.(` no `client/src` antes de fechar; o handler
  trata payload sem `reason` reconhecido pelo ramo genérico, nunca lançando.
- **Anti-pattern a evitar:** aceitar string *e* objeto no handler "por
  segurança" — mantém o formato antigo vivo para sempre (D1).

### R6 — `origin` errado quebra tudo

- **Risco:** um `origin` que não bate com a página faz a IFrame API recusar
  qualquer vídeo — de intermitente para 100% quebrado, inclusive em `localhost`.
- **Mitigação:** D9 — derivar de `window.location.origin`, omitir a chave quando
  não houver origem `http`/`https` real.
- **Anti-pattern a evitar:** domínio fixo no código; `origin: 'null'` em contexto
  `file://`.

### R7 — O peer não-dono que desistiu fica mudo

- **Risco:** esgotada a retentativa, um peer que não é dono não pode pular. Ele
  fica sem áudio até a faixa terminar.
- **Mitigação:** é o comportamento correto e desejado — ele recebe o aviso local
  explicando, e a sala segue. A entrega **melhora** o caso: hoje ele nem tenta de
  novo.
- **Anti-pattern a evitar:** deixar o não-dono chamar `advanceFrom` "porque
  ninguém mais vai". Dois escritores na mesma transição é o que a §6.9 do
  `ARCHITECTURE.md` proíbe, e o resultado é fila divergindo entre peers.

### R8 — Aviso repetido na cara do usuário

- **Risco:** erro transitório → aviso "tentando de novo" → falha → aviso de pulo.
  Dois toasts em ~1s.
- **Mitigação:** aceitável e informativo, desde que sejam textos diferentes. O que
  não pode é o **mesmo** texto duas vezes: o `showNotice` só troca o estado, e um
  texto idêntico não dá sinal nenhum de progresso ao usuário.

### R9 — Regressão nos testes que assertam a assinatura antiga

- **Risco:** `musicEngine.test.mjs` (linhas ~206, 327, 338, 481) e
  `youtubePlayer.test.mjs` (~478, 543) comparam tuplas posicionais. O DoD 4 exige
  a suíte inteira verde.
- **Mitigação:** atualizar essas asserções faz parte da entrega (item 5 da ordem),
  não é dano colateral.
- **Anti-pattern a evitar:** afrouxar a asserção para `assert.ok(errors.length)`
  só para ela passar. O que se está provando ali é justamente **o que** chega no
  callback.

---

## 8. Critérios de Aceite Técnicos

- **AC1.** Quando o `YT.Player` emite `onError` com `data: 150`, o callback do
  envelope recebe um objeto com `reason: 'youtube-error'`, `code: 150` e o
  `videoId` da faixa carregada.
- **AC2.** `classifyYouTubeError` devolve `transient: true` **apenas** para 5 e
  153; para 2, 100, 101, 150, `null`, `undefined` e valores fora da tabela devolve
  `transient: false` e o `kind` correspondente.
- **AC3.** Para código permanente e peer dono, a decisão é `'skip'` e a mensagem é
  específica da classe — em especial 101/150 menciona explicitamente que o vídeo
  não toca fora do YouTube.
- **AC4.** Para código transitório com contador zerado, a decisão é `'retry'` e o
  contador devolvido é `{ entryId, count: 1 }`.
- **AC5.** Para o mesmo `entryId` com `count: 1` e código transitório, a decisão é
  `'skip'` (dono) ou `'notice-only'` (não-dono) — **nunca** `'retry'`. Não existe
  entrada na tabela de decisão que produza duas retentativas para o mesmo
  `entryId`.
- **AC6.** Com `isOwner: false`, nenhuma combinação de código, contador e título
  produz `action: 'skip'`.
- **AC7.** Um erro com `entryId` diferente do contador reinicia o contador: a
  primeira decisão para a faixa nova é `'retry'` mesmo que a anterior tenha
  esgotado.
- **AC8.** As mensagens produzidas para `'invalid-id'`, `'unavailable'`,
  `'not-embeddable'`, retentativa e esgotamento/desconhecido são **cinco textos
  distintos**, todos em pt-BR, todos contendo o título quando ele existe e
  degradando para um genérico quando não existe.
- **AC9.** `playerVars` da construção do player contém `enablejsapi: 1`; contém
  `origin` igual a `window.location.origin` quando a página tem origem
  `http`/`https`; **não** contém a chave `origin` quando `window.location` não
  existe — e a construção não lança nesse caso (é o ambiente da suíte).
- **AC10.** Os cinco erros do `MusicEngine` chegam ao callback como objeto com
  `reason` e, quando aplicável, `entryId`.
- **AC11.** Em uma sala com três participantes, um erro transitório no player de
  um peer não altera a fila da sala, não muda `playback.version` por conta do erro
  e não produz `playing: false` para os demais.
- **AC12.** `npm test --prefix client` passa inteiro e `npm run lint --prefix
  client` não acusa erro.

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida:** entrega única, um agente. O acoplamento entre a política
pura, o payload do evento e o hook é alto demais para dividir sem retrabalho.

**Ordem de validação depois de implementar:**

1. `npm test --prefix client` — a suíte inteira, não só `youtubePlayer.test.mjs`.
   `musicEngine.test.mjs` **vai** falhar até as asserções serem migradas (R9);
   essa falha é esperada e faz parte da entrega.
2. `npm run lint --prefix client`.
3. E2E, se o ambiente permitir: é regressão, não cobertura nova desta task. O
   bloco F4a falha por uma regressão pré-existente, alheia a este diff — não
   tente consertá-la aqui.
4. `claude-progress.md`: registro critério a critério do DoD, na convenção das
   tasks anteriores. Incluir a nota de leitura da D3 (o que ficou coberto por
   `node:test` e o que ficou na camada fina do hook).

**Pitfalls desta demanda que não estão na documentação geral:**

- O `window` dos testes é um dublê literal `{ YT }`, **sem `location`**. Toda
  leitura de `window.location` precisa de guarda opcional, senão a suíte inteira
  do YouTube quebra (D9).
- `loadYouTubeApi` guarda a promessa em módulo; os testes que exercitam o
  carregamento importam uma instância nova via `?n=` no specifier. Se precisar de
  um caso novo que toque a API, siga esse padrão — reusar o módulo faz o teste
  passar por engano.
- O envelope **não** deve ganhar retentativa própria. Quem sabe a posição correta
  para retomar é o hook, via `estimatePosition` sobre o estado replicado — a
  posição do player que acabou de morrer não serve.
- O `console.warn` do `scope` 7 não é enfeite: é o instrumento que confirma ou
  derruba a hipótese do `origin`/153. Se ele sair sem o código, a task entrega
  metade do valor.

**O que esta task não resolve, e não deve tentar resolver:** um vídeo que nunca
pode ser incorporado continua entrando na fila e só falhando na hora de tocar. A
recusa no ato é a WTK-MEET-14 — não antecipe validação de link aqui.
