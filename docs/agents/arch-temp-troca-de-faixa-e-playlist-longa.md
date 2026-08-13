# Troca de faixa do player de música — Documento de Arquitetura Técnica

> Gerado em: 2026-08-13
> Status: Rascunho
> Task: WTK-MEET-12 — "Corrigir a troca de faixa do player de música e cobrir com
> testes de playlist longa"
> Branch: `agent/wtk-meet-12-temos-um-problema-no-momento-que-avan-am`

---

## 1. Contexto e Objetivo

### O sintoma

Ao pular uma faixa, o player fica inutilizável: `Pausar`/`Tocar` e o volume param
de responder e o vídeo do YouTube continua tocando. Às vezes só se recupera
trocando de sala.

### A causa, na ordem em que ela acontece

O `YouTubeTrackPlayer` (`client/src/lib/youtubePlayer.js`) tem dois estados que
saem de sincronia com a realidade:

1. **`load()` no caminho de reuso zera `this.ready` e nunca o restaura.**
   Linhas 98–103: quando já existe `this.player`, o envelope faz
   `this.ready = false` e chama `loadVideoById`. Só que `onReady` **é um evento de
   construção do `YT.Player`** — ele não dispara de novo em `loadVideoById`. A
   partir daí `this.ready` fica `false` para sempre.

2. **Todo comando é guardado por `this.ready`.** `play`, `pause`, `seek`,
   `setVolume` e `stop` viram no-op. É exatamente o sintoma: o botão responde
   (o React re-renderiza, o estado replicado muda), mas nada chega ao iframe.

3. **Todo *getter* também é guardado por `this.ready`.** `positionSec` devolve
   `0`, `durationSec` devolve `null`, `playing` e `buffering` devolvem `false`.
   E aí o dano se espalha para fora do arquivo:

   - O temporizador de 5s do dono (`useMusicRoom.js`, efeito do
     `POSITION_PUBLISH_MS`) publica
     `{ positionSec: 0, playing: player.playing !== false }` → como `playing` é
     `false`, ele publica **`playing: false`** a cada 5 segundos, para a sala
     inteira. O estado replicado passa a dizer "pausado" enquanto o iframe
     continua tocando. Esse é o "o vídeo continua tocando" do relato, e é
     também por que a sala inteira sente o problema, não só quem pulou.
   - A correção de deriva do modo `local` compara `estimatePosition()` com
     `positionSec === 0` e tenta corrigir; o `seek` é no-op; a deriva nunca
     fecha.
   - A barra de progresso congela em 0.

4. **`stop()` zera `videoId` sem derrubar o iframe.** Linhas 179–182. Na
   transição YouTube→arquivo/URL, o `reconcilePlayback` chama
   `youtubeRef.current?.stop()`: `stopVideo()` para o áudio, mas o `YT.Player` e o
   iframe continuam vivos e `this.ready` continua `true` com `videoId: null`.
   Quando a próxima faixa de YouTube chegar, ela cai no caminho de reuso — e volta
   ao item 1. É por isso que o problema também aparece em transições que não são
   YouTube→YouTube.

5. **Corridas.** `load()` é assíncrono (espera a API e o `onReady`). Dois pulos
   rápidos disparam dois `load()` concorrentes; o `reconcilePlayback` já tem um
   `loadTokenRef`, mas **não o confere depois do `await player.load(...)`** no
   ramo do YouTube (o ramo de arquivo/URL confere). Dois `new YT.Player` sobre o
   mesmo host = dois iframes, dois áudios.

### Comportamento esperado depois da entrega

Pular uma faixa (botão, voto de skip, fim natural, erro do vídeo ou saída do
dono) deixa a faixa seguinte **completamente operável**: play/pause responde,
volume altera o som de verdade, a posição anda, não sobra áudio da faixa
anterior, e os três participantes convergem para a mesma faixa corrente e a mesma
fila restante — 15+ vezes seguidas, sem degradar.

Junto: o título real do vídeo (via oEmbed no momento de enfileirar) em vez de
`YouTube · <id>`.

---

## 2. Escopo

**Dentro do escopo:**

- Ciclo de vida do `YouTubeTrackPlayer`: destruir e recriar o player a cada
  faixa, com o mount do iframe sob responsabilidade do envelope.
- Fechar a corrida de `load()` concorrente (uma geração/token dentro do
  envelope + conferência do token no `reconcilePlayback`).
- Intenção de reprodução durante a janela de carregamento (`play`/`pause`/volume
  pedidos antes do `onReady` valem quando ele chegar).
- Não publicar posição/estado enquanto o player está carregando.
- Extrair a decisão de avanço (`advanceFrom`) para uma função **pura** em
  `musicSession.js`, para que `skipped`, `ended`, `error` e `owner-left` tenham
  teste sem navegador.
- Título real do vídeo via oEmbed no enfileiramento, com fallback e respeito a
  `VITE_ENABLE_YOUTUBE=false`.
- Suíte unitária nova (`youtubePlayer.test.mjs` reescrito, `musicTransitions.test.mjs`
  novo) e seção e2e de playlist longa (15+ faixas) com dublê da IFrame API.
- Documentação: `ARCHITECTURE.md` §6.9, `README.md` (exceção do YouTube),
  `claude-progress.md`.

**Fora do escopo:**

- Reordenar a fila pela UI (`applyReorder` existe no modelo, sem UI — continua
  assim).
- Novo tipo de mensagem no protocolo `music-*`. **Nenhuma** mensagem nova, nenhum
  campo novo no `music-queue-add`. O título já viaja no campo `title` da entrada.
- Qualquer coisa no servidor de sinalização. Continua valendo o §6.9: zero rota,
  zero evento, zero estado.
- Trocar a origem YouTube por outra biblioteca ou por `<iframe>` cru sem a IFrame
  API.
- Repetir/embaralhar a fila, histórico de faixas tocadas.

---

## 3. Decisões Arquiteturais

### D1. Destruir e recriar o `YT.Player` a cada faixa

- **Decisão:** `load(videoId)` sempre derruba o player anterior (`destroy()` do
  YT + remoção do nó de mount) e constrói um `YT.Player` novo. O caminho de reuso
  via `loadVideoById` **deixa de existir**.
- **Motivação:** o único momento em que a IFrame API garante um estado íntegro é
  o `onReady` da construção. Reuso obriga o envelope a manter, à mão, um espelho
  de um estado que a API não reexpõe — e foi exatamente esse espelho que
  divergiu. Recriar transforma "faixa nova" no mesmo caminho de código que "a
  primeira faixa", que é o caminho já testado e que funciona.
- **Custo aceito:** um handshake de iframe por faixa (~centenas de ms). É
  irrelevante perto do buffering do próprio vídeo, e a troca de faixa já é uma
  operação com latência visível.
- **Alternativas descartadas:**
  - *Restaurar `this.ready` no `onStateChange` após `loadVideoById`.* Devolve
    parte da função, mas mantém o espelho manual e não resolve o `stop()`
    (item 4 do §1) nem o vídeo anterior que continua carregado no mesmo iframe.
    Conserta o sintoma, deixa a classe de bug.
  - *Remover as guardas `this.ready` dos comandos.* Chamar `playVideo()` antes de
    o player existir estoura; e os getters continuariam mentindo.

### D2. O envelope passa a ser dono do nó de mount

- **Decisão:** o construtor recebe **`host`** (o `<div className="music-youtube-host">`
  que o React renderiza em `Room.jsx:952`), não `container`. O envelope cria um
  `<div>` filho novo a cada `load()` e o remove no teardown, deixando o host
  vazio.
- **Motivação:** `YT.Player` **substitui** o elemento que recebe por um `<iframe>`,
  e `destroy()` remove esse iframe. Com um container fixo capturado na
  construção, o segundo `load()` receberia um nó que não está mais no documento —
  o player nem sobe. Quem recria precisa poder montar de novo.
- **Consequência:** `ensureYouTube()` em `useMusicRoom.js` deixa de criar o
  `<div>` de mount; passa só o `youtubeHostRef.current`. A regra que já estava
  documentada continua valendo e fica mais forte: **o React cuida do host, o
  envelope cuida de tudo que estiver dentro dele.**

### D3. `stop()` é teardown completo; `destroy()` é terminal

- **Decisão:** duas operações distintas.
  - `stop()` → derruba o `YT.Player`, remove o iframe, zera `videoId`/`ready`, e
    **deixa o envelope reutilizável** (`destroyed` continua `false`).
  - `destroy()` → mesmo teardown + `destroyed = true`, e nenhum `load()` futuro
    é aceito.
- **Motivação:** `stop()` é chamado em duas situações (faixa corrente virou nula;
  transição YouTube→arquivo/URL) e nas duas o resultado desejado é **zero iframe
  no DOM e zero áudio**. Um `stopVideo()` que deixa o iframe de pé é justamente o
  que produz "áudio órfão" e o que quebra o próximo `load()`.
- **Efeito no teste existente:** `client/test/youtubePlayer.test.mjs` tem hoje
  dois casos que **fixam o comportamento antigo** e precisam ser reescritos, não
  ajustados:
  - `'a faixa seguinte reaproveita o mesmo iframe, sem construir outro player'`
    → vira o oposto: cada faixa constrói um player e o anterior é destruído.
  - `'parar a faixa larga o vídeo corrente sem derrubar o player'` → vira
    "parar derruba o iframe e o envelope continua utilizável".
  Isso é esperado e é o sinal de que a decisão foi aplicada de fato. Está listado
  aqui para o agente de implementação **não** tentar preservar esses dois testes.

### D4. Geração monotônica dentro do envelope

- **Decisão:** cada `load()` incrementa `this.generation`. Todo callback da API
  (`onReady`, `onStateChange`, `onError`) confere a geração e o `this.player`
  antes de agir. Um `load()` cuja geração ficou obsoleta ao resolver destrói o
  player que acabou de construir e devolve `false`.
- **Motivação:** sem isso, o `ENDED` do iframe que está sendo derrubado chega
  depois e chama `onEnded` — que em `useMusicRoom` lê
  `sessionRef.current.playback.entryId`, ou seja, **a faixa nova**. O resultado é
  a playlist pulando duas faixas de uma vez, de forma intermitente. Numa
  playlist de 15+ faixas isso deixa de ser hipótese e vira certeza estatística.
- **Complemento em `useMusicRoom`:** o ramo do YouTube em `reconcilePlayback`
  passa a conferir `token !== loadTokenRef.current` depois do `await`, como o
  ramo de arquivo/URL já faz.

### D5. Intenção de reprodução sobrevive à janela de carregamento

- **Decisão:** o envelope guarda `desiredPlaying` e `volume`. `play()`/`pause()`
  chamados antes do `onReady` **não são descartados**: atualizam `desiredPlaying`,
  e o `onReady` aplica o valor mais recente. `load()` inicializa `desiredPlaying`
  com o `autoplay` recebido. O envelope expõe `loading` (true entre o início do
  `load()` e o `onReady`).
- **Motivação:** com recriação por faixa, a janela "player ainda não pronto"
  passa a existir em **toda** troca. Sem essa memória, um `Pausar` clicado 200ms
  depois do skip é engolido, e o usuário vê de novo o sintoma que estamos
  consertando.
- **Complemento em `useMusicRoom`:** o temporizador de publicação de posição
  **pula o tique** enquanto `player.loading` for `true`. Publicar
  `{ positionSec: 0, playing: false }` durante o carregamento é o mecanismo do
  item 3 do §1 e não pode voltar por outra porta.

### D6. A decisão de avanço vira função pura em `musicSession.js`

- **Decisão:** extrair de `useMusicRoom.advanceFrom` a parte que **decide** para
  uma função pura, e deixar no hook apenas a parte que **age**:

  ```
  planAdvance({ session, finishedEntryId, reason, presentIds, selfId, delivery })
    → { removedEntryId, broadcastRemove, publish }   // publish: patch ou null
  ```

  `ownerFor(entry, presentIds)` (hoje um helper local do hook) desce junto, por
  ser pura e ser regra de convergência.
- **Motivação:** é o item mais direto do DoD 7. Hoje `advanceFrom` é uma closure
  dentro de um hook React, e o projeto **não tem** renderer de DOM em `node --test`
  (só `react-dom/server`, ver `client/test/jsxLoader.mjs` e o cabeçalho de
  `spotlightRail.test.mjs`). Sem extrair, cobrir `ended`/`error`/`owner-left` só
  seria possível no e2e — e no e2e o `owner-left` custa uma saída de participante,
  que colide com a seção F. Extraído, os quatro motivos ficam a três linhas de
  teste cada.
- **Alinhamento com o projeto:** é literalmente o que o cabeçalho de
  `useMusicRoom.js` já promete — "as regras de convergência estão todas nos
  módulos puros; o que este arquivo acrescenta é *quem age*". `advanceFrom` era a
  exceção.
- **Invariante a preservar ao extrair (não é refactor cosmético):** a ordem de
  hoje é `capturar a chave da faixa que acabou` → `remover` → `nextEntryAfterKey`.
  Inverter isso quebra o avanço quando a faixa corrente já virou tombstone, que é
  o caso de `owner-left` e do skip vindo pelo canal.

### D7. `parseSource` continua puro; a rede fica em `youtubePlayer.js`

- **Decisão:** três peças.
  1. `parseSource()` continua **síncrono e sem rede**, devolvendo
     `title: 'YouTube · <id>'` como hoje.
  2. `musicSources.js` ganha `resolveSourceTitle(parsed, { fetchTitle })` —
     assíncrona, mas **pura por injeção**: o buscador é parâmetro. Ela só decide
     "usar o título resolvido ou manter o fallback", com `clampTitle` aplicado.
  3. O `fetch` de verdade — `fetchYouTubeTitle(videoId, { signal })`, oEmbed em
     `https://www.youtube.com/oembed?...&format=json` — mora em
     `youtubePlayer.js`, que já é "a única parte do player que depende de um
     terceiro, confinada de propósito num arquivo só", e já tem
     `isYouTubeEnabled()`.
- **Motivação:** `musicSources.js` abre com a invariante "Módulo **puro**: sem
  DOM, sem rede, sem WebAudio", e é o módulo que valida entrada hostil vinda do
  data channel. Botar `fetch` ali quebra a invariante e obriga os testes desse
  arquivo a dublar rede. Botar em `youtubePlayer.js` mantém a promessa que a
  `VITE_ENABLE_YOUTUBE` faz: **um arquivo só para desligar**.
- **Leitura do DoD 5, declarada:** o item diz "`parseSource` de um link do
  YouTube resolve o título via oEmbed". Entregamos o **efeito observável** exigido
  (o caminho de enfileiramento resolve o título; a UI mostra o nome do vídeo;
  falha mantém o fallback com o id), sem colocar rede dentro da função pura. Se a
  intenção literal for `parseSource` assíncrono e fazendo `fetch` por conta
  própria, é uma decisão a reverter com o Nicolas antes de implementar — mas a
  recomendação técnica é a acima.

### D8. O título é decidido por quem enfileira, e só por ele

- **Decisão:** o título resolvido entra na entrada **antes** do
  `music-queue-add`, e viaja replicado. Nenhum participante reescreve o título de
  uma entrada depois que ela existe. Em particular, o callback `onTitle` do
  envelope (que hoje só faz `setNowPlayingTick`) **não** passa a escrever no
  `session`.
- **Motivação:** só quem adiciona faz a chamada à Google; os outros dois recebem
  o nome pelo data channel sem nenhuma requisição extra — é uma redução real da
  exposição de privacidade, não um detalhe. E título é a **identidade visível da
  linha na fila**: se cada cliente reescrevesse com o que o seu iframe reportou,
  a fila divergiria entre participantes (fere o DoD 4 e a checagem N5 do e2e) e
  linhas mudariam de nome sob o dedo do usuário.
- **Contraste com `applyDuration`:** duração *é* escrita localmente e diverge por
  alguns segundos. Tolerável porque é cosmética e converge. Título não é
  cosmético — é como a pessoa reconhece a faixa que ela mesma adicionou.
- **Segurança:** `sanitizeEntry` já recorta o título em `MAX_TITLE` e recusa
  entrada com título vazio; `MusicPanel` renderiza como texto (React escapa).
  Título hostil vindo do canal continua tratado pelo caminho que já existe.

### D9. `VITE_ENABLE_YOUTUBE=false` corta a chamada oEmbed na origem

- **Decisão:** `fetchYouTubeTitle` devolve `null` imediatamente quando
  `isYouTubeEnabled()` é falso — **sem tocar em `fetch`**. Isso é redundante com o
  fato de `parseSource` já recusar links de YouTube com a flag desligada, e a
  redundância é intencional: a promessa "nenhuma requisição à Google" precisa ser
  garantida no ponto onde a requisição nasceria, não só no chamador de hoje.
- **Como se prova:** teste unitário que injeta a flag desligada e um `fetch`
  dublê que **falha o teste se for chamado**. No e2e, gravação de todas as
  requisições da página (`page.on('request')`) e asserção de que nenhuma sai para
  domínio da Google além do oEmbed dublado.

### D10. O e2e dubla a IFrame API; nada sai para a Google

- **Decisão:** o dublê é injetado por `addInitScript` (antes de qualquer script da
  app) definindo `window.YT` completo. `loadYouTubeApi()` já resolve na hora
  quando `window.YT?.Player` existe — nenhum `<script>` de terceiro é injetado.
  A rota do oEmbed é interceptada com `context.route` e respondida com um título
  conhecido; qualquer outra rota `**://*.youtube.com/**` e `**://*.google.com/**`
  é **abortada**, para que uma regressão vire falha e não vire tráfego silencioso.
- **Motivação:** e2e que depende de rede de terceiro é e2e que falha por motivo
  errado. E o dublê é o que torna as asserções do DoD 3 (contagem de iframes) e
  do DoD 2 (volume real) verificáveis.
- **O dublê registra `loadVideoById` como violação:** se alguém reintroduzir o
  caminho de reuso, o e2e acusa em vez de passar por acidente.

---

## 4. Componentes Afetados

### `client/src/lib/youtubePlayer.js` — o núcleo da correção

| O que muda | Por quê |
|---|---|
| Construtor recebe `host` em vez de `container` | D2 — o envelope precisa montar de novo a cada faixa |
| Campos novos: `generation`, `loading`, `desiredPlaying`, `mount` | D4, D5 |
| `load()` sempre faz teardown + `new YT.Player`; o ramo `loadVideoById` some | D1 |
| `load()` confere a geração ao resolver e desfaz o que construiu se ficou obsoleto | D4 |
| `_teardown()` interno: `player.destroy()` em `try/catch`, remove o mount, esvazia o host, `ready = false`, `player = null` | D3 |
| `stop()` chama `_teardown()` e mantém o envelope utilizável | D3 |
| `destroy()` chama `_teardown()` e marca `destroyed` | D3 |
| `play`/`pause` atualizam `desiredPlaying` mesmo com `loading` | D5 |
| Callbacks (`onReady`/`onStateChange`/`onError`) conferem geração antes de agir | D4 |
| `onEnded` continua reportando o `videoId` da geração corrente | D4 |
| Getter `loading` exposto | D5 |
| `fetchYouTubeTitle(videoId, { signal })` — oEmbed, guardado por `isYouTubeEnabled()` | D7, D9 |

### `client/src/lib/musicSources.js`

| O que muda | Por quê |
|---|---|
| `resolveSourceTitle(parsed, { fetchTitle })` — assíncrona, pura por injeção, aplica `clampTitle` e mantém o fallback em erro/vazio | D7 |
| `parseSource` **não muda de assinatura nem de pureza** | D7 |

### `client/src/lib/musicSession.js`

| O que muda | Por quê |
|---|---|
| `ownerFor(entry, presentIds)` exportada (movida do hook) | D6 |
| `planAdvance({...})` — decisão pura do avanço, com o `reason` repassado | D6 |

### `client/src/lib/useMusicRoom.js`

| O que muda | Por quê |
|---|---|
| `advanceFrom` vira executor de `planAdvance` (remove, envia `queue-remove`, publica se o plano mandar) | D6 |
| `ensureYouTube()` passa `youtubeHostRef.current` como `host`; para de criar o `<div>` de mount | D2 |
| Ramo YouTube do `reconcilePlayback` confere `loadTokenRef` depois do `await` | D4 |
| Temporizador de publicação de posição pula o tique enquanto `player.loading` | D5 |
| `addToQueue` resolve o título por oEmbed **na mesma posição** em que já faz a sonda de CORS (antes de ler o estado para publicar) | D7 + armadilha R4 |
| `onTitle` continua **sem** escrever no `session` | D8 |

### `client/src/components/MusicPanel.jsx`

| O que muda | Por quê |
|---|---|
| Nada de estrutura. `.music-now-title` e `.music-queue-title` já renderizam `entry.title` | O título correto chega pelo modelo; a UI já é projeção |

> Se ao implementar aparecer necessidade de mexer no `MusicPanel`, é sinal de que
> o título está sendo resolvido no lugar errado. Reveja D8 antes de editar.

### Testes

| Arquivo | O que muda |
|---|---|
| `client/test/youtubePlayer.test.mjs` | Reescreve os dois casos de reuso (D3); adiciona ciclo de vida, corrida, volume entre faixas, intenção pendente, oEmbed e flag desligada |
| `client/test/musicTransitions.test.mjs` (novo) | `planAdvance` nos quatro motivos + simulação pura de 3 réplicas numa playlist de 15+ |
| `client/test/musicSession.test.mjs` | Casos de `ownerFor` e das invariantes de ordem que `planAdvance` depende |
| `client/test/musicSources.test.mjs` | `resolveSourceTitle` com buscador dublê: sucesso, falha, vazio, título longo demais |
| `e2e/harness.mjs` | Dublê da IFrame API na `INSTRUMENTATION`; gravação de requisições; helper de leitura do estado do player |
| `e2e/run.mjs` | Seção de playlist longa, **dentro do bloco N, antes da seção F** |

### Documentação

| Arquivo | O que muda |
|---|---|
| `ARCHITECTURE.md` §6.9 | Parágrafo novo "Trocar de faixa é reconstruir o player" (D1–D5) e a nota do oEmbed junto da exceção de privacidade já declarada (D7–D9) |
| `ARCHITECTURE.md` §9 / linha 593 | A exceção do YouTube passa a incluir a chamada oEmbed no enfileiramento |
| `README.md` §"Uma exceção declarada: YouTube" | O que a Google passa a ver e quando; `VITE_ENABLE_YOUTUBE=false` corta também o oEmbed |
| `claude-progress.md` | Registro da sessão, conforme convenção do repositório |

---

## 5. Contratos de Interface

### Endpoints REST

Nenhum. Continua valendo o §6.9: nenhuma rota, evento ou estado novo no servidor.

### Chamada externa (nova)

| Destino | Quando | Quem chama | Falha |
|---|---|---|---|
| `GET https://www.youtube.com/oembed?url=<watch-url>&format=json` | No `addToQueue`, só para `kind === 'youtube'`, só se `isYouTubeEnabled()` | Apenas o participante que enfileira | Timeout curto (~2.5s) ou erro → mantém `YouTube · <id>` e **não impede o enfileiramento** |

### Eventos em tempo real (`RTCDataChannel`)

Nenhum tipo novo, nenhum campo novo. O que muda é só o **valor** de um campo que
já existe:

| Tipo de Evento | Payload | Quem emite | Quem consome |
|---|---|---|---|
| `music-queue-add` | `entry.title` passa a conter o título real do vídeo quando o oEmbed responde | Quem enfileira | Todos |

### Contrato de interface — envelope do YouTube

```
new YouTubeTrackPlayer({ host, onEnded, onError, onDurationKnown, onTitle })

  load(videoId, { startSeconds, autoplay }) → Promise<boolean>
      destrói o player anterior; constrói um novo; false se obsoleto/destruído
  play() / pause()          registram a intenção mesmo durante `loading`
  seek(sec) / setVolume(v)  volume persiste entre faixas (0–1)
  stop()                    teardown completo; envelope continua utilizável
  destroy()                 teardown completo; envelope inerte

  get loading   true entre o início do load() e o onReady
  get playing / buffering / positionSec / durationSec
```

### Contrato de interface — decisão de avanço (pura)

```
planAdvance({ session, finishedEntryId, reason, presentIds, selfId, delivery })
  → {
      removedEntryId : string | null,   // a faixa que acabou sai da fila
      broadcastRemove: boolean,         // manda music-queue-remove?
      publish        : {                // patch de playback, ou null se não sou eu
        entryId, playing, positionSec, delivery, endedReason
      } | null
    }
```

`reason` ∈ `'skipped' | 'ended' | 'error' | 'owner-left'`. Ele **não** altera a
decisão — só viaja para `endedReason`. Essa é a razão de os quatro caminhos
produzirem o mesmo estado saudável (DoD 7).

### Schema de Banco

Não se aplica — o projeto não tem banco.

---

## 6. Dependências e Ordem de Implementação

1. **`musicSession.js`: `ownerFor` + `planAdvance`** — puro, sem dependência de
   nada. Fundação do item 7 do DoD.
2. **`musicTransitions.test.mjs` + complementos em `musicSession.test.mjs`** —
   fixa os quatro motivos antes de mexer no hook. *(Pode ir em paralelo com o
   passo 3.)*
3. **`youtubePlayer.js`: ciclo de vida (D1–D5)** — o coração da correção.
   Independente do passo 1.
4. **`youtubePlayer.test.mjs` reescrito** — depende de 3. Aqui os dois casos
   antigos de reuso são invertidos (ver D3).
5. **`useMusicRoom.js`: `advanceFrom` → `planAdvance`, `host`, token, `loading`**
   — depende de 1 e 3.
6. **`musicSources.js`: `resolveSourceTitle` + `fetchYouTubeTitle` em
   `youtubePlayer.js`** — independente de 1–5; pode rodar em paralelo desde o
   início.
7. **`musicSources.test.mjs`** — depende de 6.
8. **`addToQueue` chama o resolvedor** — depende de 5 e 6.
9. **`e2e/harness.mjs`: dublê da IFrame API + gravação de requisições** — depende
   de 3 (o dublê precisa refletir o contrato novo).
10. **`e2e/run.mjs`: seção de playlist longa** — depende de 9 e de 1–8.
11. **`npm test` no client + `node e2e/run.mjs` inteiro** — o e2e completo, não
    só a seção nova (DoD 9).
12. **Documentação** (`ARCHITECTURE.md`, `README.md`, `claude-progress.md`) —
    depois de 11, com os números reais em mãos.

---

## 7. Riscos e Armadilhas

### R1. O teto de 10 faixas por participante engole a playlist longa

- **Risco:** `MAX_PER_PEER = 10` (`musicSession.js`). Enfileirar 15 faixas por um
  único participante faz `enforceLimits` **descartar em silêncio** as 5 de maior
  chave. O e2e ou falha sem explicação óbvia, ou pior, passa medindo uma playlist
  de 10.
- **Mitigação:** distribuir as 15+ faixas entre Alice, Bob e Carol (ex.: 6/5/5) —
  o que é mais realista de qualquer forma, e é o que faz o DoD 4 ("autoria
  preservada") ter o que verificar.
- **Anti-pattern:** aumentar `MAX_PER_PEER` para o teste passar. O teto é trava
  de flood, irmã do `MAX_HISTORY` do chat; mexer nele para acomodar teste é
  mudar produto para acomodar ferramenta.

### R2. Ordem da fila não é ordem de digitação

- **Risco:** a ordem é total por `(lamport, addedBy, id)`, nunca por ordem de
  chegada. Um roteiro que assume "Alice, Bob, Carol, Alice, …" porque foi assim
  que enfileirou vai comparar com a ordem errada.
- **Mitigação:** ler a ordem observada do DOM (`.music-queue-item .music-queue-title`,
  como o N5 já faz) e derivar as asserções dela. A asserção certa é
  "**os três veem a mesma lista**", não "a lista é esta".
- **Anti-pattern:** ordenar a fila por `Date.now()` na UI para o teste ficar
  previsível.

### R3. `sourceRef` duplicado é recusado

- **Risco:** `hasSameSource` bloqueia a segunda faixa com a mesma origem. 15
  faixas precisam de 15 `sourceRef` distintos — e para YouTube, de 15 ids
  **válidos**: exatamente 11 caracteres de `[A-Za-z0-9_-]` (`sanitizeEntry`
  recusa o resto, e recusa em silêncio no merge de snapshot).
- **Mitigação:** gerar ids sinteticamente com largura fixa (ex.: `yt-e2e-0001`,
  11 caracteres) e URLs de áudio distintas por sufixo de query.

### R4. Rede antes de ler o estado — a armadilha que já custou caro aqui

- **Risco:** `addToQueue` tem um comentário explícito: a sonda é rede, então
  **nada de estado é lido antes dela**, porque uma faixa que outro participante
  adicionasse durante o `await` sumiria da fila deste cliente. O oEmbed é uma
  segunda chamada de rede no mesmo caminho e reintroduz exatamente esse risco.
- **Mitigação:** o `await` do oEmbed vai **junto** com o da sonda, antes do
  `bumpLamport(sessionRef.current)`. Tudo que lê `sessionRef.current` para compor
  o que será publicado fica depois de todas as esperas.
- **Anti-pattern:** resolver o título depois de montar a entrada e "corrigir"
  com um segundo `music-queue-add`, ou com uma mensagem nova de update de título.

### R5. Evento do iframe morto avança a faixa nova

- **Risco:** descrito em D4. `ENDED` que chega do player em teardown chama
  `onEnded`, que em `useMusicRoom` lê a faixa **corrente** — pulando duas de uma
  vez, intermitentemente. Em 15 transições, aparece.
- **Mitigação:** conferência de geração nos três callbacks, e `onEnded`
  carregando o `videoId` da geração que o emitiu.
- **Anti-pattern:** `debounce` no `handleEnded`. Esconde a corrida e cria outra.

### R6. Publicar durante o carregamento derruba a sala inteira

- **Risco:** o mecanismo do §1 item 3 pode voltar por outra porta: qualquer
  publicação que use `player.positionSec`/`player.playing` enquanto o player não
  está pronto publica `{0, false}` **como estado autoritativo** — e o dono é o
  escritor único, então todo mundo obedece.
- **Mitigação:** D5. Pular o tique enquanto `loading`. Vale também para
  `requestPause`/`requestResume`/`getMusicSnapshot`, que usam
  `player?.positionSec ?? playback.positionSec` — conferir se o fallback está
  correto quando o player existe mas está carregando (o `??` **não** cai no
  fallback com `0`).
- **Anti-pattern:** confiar no `?.` para proteger. O player existe; o problema é
  que ele responde `0`.

### R7. A ordem dos 4 transceivers é contrato de rede (A2 do e2e)

- **Risco:** o `ARCHITECTURE.md` §6.9 é explícito — a ordem
  **mic, câmera, tela, música** é contrato, e o `_classifyTransceiver` precisa
  andar junto. Nada nesta demanda deveria tocar nisso, e é justamente por isso
  que uma quebra passaria despercebida até o A2 falhar.
- **Mitigação:** o A2 já está no DoD 9. Rodar o e2e **inteiro**, não só a seção
  nova.

### R8. A seção nova precisa caber antes da seção F

- **Risco:** a seção F ("saída e vazamentos") faz a Carol **sair da sala** e mede
  toasts e painéis fechados. Uma seção de playlist com três participantes
  colocada depois de F não tem três participantes; colocada antes mas sem fechar
  o painel de música, muda o palco que F mede.
- **Mitigação:** a seção nova entra logo depois do N10, **antes** do
  "Fecha o player nos três" que já existe, e não altera esse fechamento.
- **Cobertura de `owner-left` no e2e:** fica com o teste unitário (`planAdvance`).
  Forçar uma saída dentro do bloco N para cobri-lo quebraria F.

### R9. Orçamento de tempo do e2e

- **Risco:** 15+ transições × convergência em 3 páginas, com `waitFor` de até 20s
  cada, pode multiplicar o tempo da suíte.
- **Mitigação:** fixtures de áudio curtas; a maioria das transições dirigida por
  clique em "Pular" (determinístico) e apenas uma ou duas por `ended` natural;
  `waitFor` com timeout menor na seção nova, já que a convergência aqui é rápida
  por construção.
- **Anti-pattern:** `sleep` fixo entre faixas. A convergência é assíncrona; o
  `waitFor` do arquivo é o instrumento certo.

### R10. Ambiente do e2e é conhecido por não subir sozinho

- **Risco:** memória do projeto e cabeçalhos dos testes registram que o Chromium
  não inicia sem receita (libs em `/tmp/pwlibs`), e que o worktree pode
  desaparecer no meio da sessão.
- **Mitigação:** commitar cedo e em incrementos; se o e2e não subir, o bloqueio
  vai para `claude-progress.md` com a evidência, e os itens 8/9 do DoD **não**
  são marcados. Testes unitários passando não substituem o e2e nesses dois itens.

---

## 8. Critérios de Aceite Técnicos

### Envelope do YouTube

1. Carregar uma segunda faixa constrói um `YT.Player` novo e o anterior recebe
   `destroy()`; ao final existe **exatamente um** iframe sob o host.
2. Depois da troca, `play()`, `pause()`, `setVolume()` e `seek()` chegam ao
   player corrente — nenhum vira no-op.
3. O volume ajustado antes do `load()` e o ajustado durante o `loading` são
   ambos aplicados quando o player fica pronto; o valor persiste da faixa N para
   a N+1 sem ser reenviado pela UI.
4. `stop()` deixa zero iframe no host e o envelope aceita um `load()` seguinte.
   `destroy()` deixa zero iframe e recusa qualquer `load()` seguinte.
5. Dois `load()` disparados em sequência sem esperar o primeiro terminam com
   **um** player, o da última chamada; o primeiro devolve `false`.
6. Um `ENDED` ou `onError` emitido por um player já derrubado **não** dispara
   `onEnded`/`onError` do envelope.
7. `loading` é `true` entre o início do `load()` e o `onReady`, e `false` depois.
8. `destroy()` sobre um iframe que já sumiu não lança (comportamento atual,
   preservado).

### Título via oEmbed

9. Enfileirar um link do YouTube com oEmbed respondendo `{"title":"X"}` cria a
   entrada com `title === 'X'`, e `.music-now-title` e o item da fila exibem `X`.
10. oEmbed com erro de rede, resposta não-JSON, `title` vazio ou timeout: a
    entrada é criada com `YouTube · <id>` e o enfileiramento **não** falha.
11. Título maior que `MAX_TITLE` é recortado; a entrada continua válida em
    `sanitizeEntry`.
12. Com `VITE_ENABLE_YOUTUBE=false`, nenhuma chamada de rede é feita ao
    enfileirar (nem oEmbed, nem script da IFrame API).
13. Os outros participantes exibem o mesmo título **sem** fazer requisição
    própria à Google.

### Avanço de faixa (`planAdvance`)

14. Para `skipped`, `ended`, `error` e `owner-left`, com a mesma fila e o mesmo
    conjunto de presentes, o plano é o mesmo — muda apenas `endedReason`.
15. Quando o dono da próxima faixa é outro participante, `publish` é `null`
    (exatamente um escritor por transição).
16. Quando a faixa que acabou já não está na fila (tombstone), o avanço ainda
    encontra a seguinte pela chave — `owner-left` e o skip vindo do canal
    dependem disso.
17. Fila vazia depois da remoção: quem estava tocando publica
    `{ entryId: null, playing: false, positionSec: 0 }`; ninguém mais publica.

### Comportamento na sala (e2e, playlist de 15+)

18. Depois de **cada** transição, `Pausar` alterna o estado publicado e o player
    corrente obedece; `Tocar` volta.
19. Depois de **cada** transição, mover o volume altera o volume real do tocador
    corrente — nas três combinações: YouTube→YouTube, YouTube→arquivo/URL,
    arquivo/URL→YouTube.
20. Depois de **cada** transição existe no máximo **um** iframe do YouTube no DOM
    e no máximo **uma** fonte de áudio ativa; o vídeo anterior não continua
    tocando.
21. Depois de **cada** avanço, Alice, Bob e Carol convergem para a mesma faixa
    corrente e a mesma fila restante, com a autoria (`.music-queue-by`)
    preservada.
22. Nenhuma requisição sai para domínio da Google além do oEmbed interceptado.
23. Nenhum erro de JS no console dos três participantes durante a seção (a
    checagem G do e2e já cobre a suíte inteira).

### Regressão

24. `npm test` em `client/` passa inteiro.
25. `npm run lint` em `client/` sem erro.
26. `node e2e/run.mjs` passa de ponta a ponta, com A2 e N1–N10 verdes.

---

## 9. Notas para os Agentes de Implementação

### Divisão sugerida

- **Agente de desenvolvimento (client):** passos 1, 3, 5, 6, 8 do §6. É o miolo.
- **Agente de QA/testes:** passos 2, 4, 7, 9, 10. Pode começar pelo passo 2 em
  paralelo, já que `planAdvance` é puro e o contrato está no §5.
- **Documentação:** passo 12, por último, com os números do e2e em mãos.

### Pitfalls desta demanda que não estão na documentação geral

1. **Dois testes existentes em `youtubePlayer.test.mjs` fixam o comportamento que
   estamos removendo** (D3). Reescreva-os; não tente conciliar. Se você se pegar
   preservando `loadVideoById`, parou no meio da correção.
2. **`YT.Player` substitui o elemento que recebe.** Sem um mount novo por faixa
   (D2), o segundo `load()` monta num nó fora do documento e falha de um jeito
   difícil de ler.
3. **`MAX_PER_PEER = 10`** (R1). A playlist longa é obrigatoriamente coletiva.
4. **Rede antes de ler estado** no `addToQueue` (R4) — o comentário no código já
   explica por quê; o oEmbed segue a mesma regra.
5. **`?? ` não protege de `0`** (R6). O player carregando responde `0`, não
   `undefined`.
6. **A ordem da fila não é a ordem de digitação** (R2).
7. **O dublê da IFrame API precisa criar um `<iframe>` de verdade** no lugar do
   mount e removê-lo no `destroy()` — senão a asserção "no máximo um iframe"
   mede o nada e passa sempre.

### Ordem recomendada de validação

1. `cd client && npm test` — deve ficar verde já no fim do passo 4 do §6 para a
   parte do envelope, e no fim do passo 7 para a parte de título.
2. `cd client && npm run lint` — o projeto usa `eslint src`, então erro de lint
   em `test/` não aparece aqui; ainda assim, mantenha o estilo dos arquivos
   vizinhos.
3. `cd client && npm run build` — a suíte e2e constrói o client (`buildClient()`);
   um erro de build só apareceria lá, tarde.
4. `node e2e/run.mjs` **inteiro**. A seção nova passando com A2 ou N1–N4
   vermelhos não vale (DoD 9).
5. Só então documentar.

### Sobre o DoD

- O item 5 é entregue conforme D7 (efeito observável, com `parseSource`
  continuando puro). Isso está declarado de propósito neste documento; se a
  leitura literal for obrigatória, confirme com o Nicolas **antes** de
  implementar, porque muda a assinatura de um módulo que valida entrada hostil.
- Os itens 8 e 9 dependem do e2e subir de fato neste ambiente (R10). Se não
  subir, registre o bloqueio com a evidência e **não** marque esses itens.
