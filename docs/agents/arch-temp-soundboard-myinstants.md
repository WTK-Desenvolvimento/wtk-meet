# Soundboard (MyInstants) com favoritos locais e disparo para a sala — Documento de Arquitetura Técnica

> Gerado em: 2026-09-01
> Task: WTK-MEET-23
> Status: Rascunho — **duas decisões pedem aval explícito antes da implementação (§3.1 e §3.4)**

---

## 1. Contexto e Objetivo

Hoje a sala só tem um caminho para áudio compartilhado: o player colaborativo (§6.9 do
`ARCHITECTURE.md`), que é **votado para ligar**, tem fila, dono de faixa, sucessão e
convergência sem servidor. É a máquina certa para "a sala vai ouvir um disco por uma
hora" e a máquina errada para "eu quero soltar um *bruh* de 1,2 segundo agora".

Esta entrega adiciona um **soundboard**: um painel recolhível à esquerda onde cada
pessoa cola a URL de um efeito do MyInstants, favorita e dispara com um clique. O som é
mixado no canal de música de quem apertou e sobe pelo mesh — mesmo transporte, mesma
cifra (DTLS-SRTP hoje; a camada extra de `e2ee.ts` está desligada no `Room`, e o
soundboard não muda esse estado nem depende dele). Não há votação, não há fila, não há
estado replicado a convergir.

**Comportamento esperado depois da entrega:**

- Um botão `Soundboard` na barra de controles abre um painel à esquerda do palco.
- Colar uma URL do MyInstants adiciona um favorito **daquele navegador**, persistido em
  `localStorage` sob `wtk-meet:soundboard`.
- Clicar num favorito toca o efeito para a sala inteira em menos de ~1s, com autoria
  visível ("Fulano tocou *Bruh*").
- Disparar é livre, com rate limit nas duas pontas.
- Cada ouvinte pode silenciar o soundboard globalmente ou por participante, **localmente**,
  sem que a escolha trafegue.

---

## 2. Escopo

**Dentro do escopo:**

- Endpoint de proxy/resolução no servidor de sinalização, restrito ao host do MyInstants (§3.1).
- Módulos puros no client: parsing de URL, favoritos em `localStorage`, rate limiter e
  protocolo da mensagem de disparo.
- Um **barramento de música único por aba** (`musicBus`), compartilhado entre o player
  colaborativo e o soundboard, para que os dois usem o mesmo track do quarto transceiver (§3.2).
- Reprodutor de efeitos: fetch pelo proxy → `decodeAudioData` → `AudioBufferSourceNode`,
  com cache em memória.
- Mensagem `soundboard-fire` no data channel que já existe, com sanitização própria.
- Painel `SoundboardPanel` à esquerda do palco, exclusivo com chat e player (§3.6).
- Silenciamento local, global e por participante, aplicado por janela temporal (§3.4).
- Testes em `node --test` para tudo que é puro; testes de servidor para o proxy.
- Atualização de `ARCHITECTURE.md` (nova §6.13 + linhas de §5 e §6.10) e do progresso em
  `docs/progress/WTK-MEET-23.md`.

**Fora do escopo:**

- Busca/catálogo do MyInstants dentro do produto (não há API pública estável; o usuário cola URL).
- Compartilhar favoritos entre participantes ou entre navegadores. Favorito é do navegador,
  ponto — a mesma regra de `wtk-meet:devices`.
- Upload de arquivo próprio como efeito. O player colaborativo já cobre arquivo local.
- Atalhos de teclado globais para disparo (tentador, e conflita com o chat aberto; fica
  para depois de o recurso existir).
- Qualquer forma de silenciar o soundboard **de outra pessoa para a sala inteira**. Moderação
  coletiva é votação, e votação é justamente o que esta entrega existe para não fazer.
- Fila, ordenação ou sincronização de efeitos entre clients. Efeito não tem estado replicado.
- Persistir a lista de participantes silenciados: o `peerId` é o socket id daquela sessão e
  não sobrevive a um refresh (§3.5).

---

## 3. Decisões Arquiteturais

### 3.1 O áudio do MyInstants passa por um proxy no servidor de sinalização

- **Decisão:** dois endpoints novos no servidor Express — `GET /soundboard/resolve` (URL de
  página → URL de mídia + título) e `GET /soundboard/media` (bytes do mp3 reservidos com
  CORS). O client **nunca** fala com `myinstants.com` diretamente.
- **Motivação:** verificado hoje, 2026-09-01, contra `https://www.myinstants.com/media/sounds/movie_1.mp3`
  com `Origin:` — responde `200`/`206 audio/mpeg` **sem `Access-Control-Allow-Origin`**, em
  `GET`, `HEAD` e `OPTIONS`. As consequências no navegador são três, e todas fatais para o requisito:
  1. `fetch()` é bloqueado pelo CORS → sem `decodeAudioData`.
  2. `<audio crossOrigin="anonymous">` **não carrega** o recurso.
  3. `<audio>` sem `crossOrigin` carrega, mas `createMediaElementSource` tinge o grafo e o
     `MediaStreamDestination` emite **silêncio digital, sem erro nenhum** — exatamente a
     armadilha nº 2 do cabeçalho de `lib/musicEngine.ts` e a razão de existir a sonda
     `Range: bytes=0-0` de §6.9. `HTMLMediaElement.captureStream()` esbarra na mesma regra
     de taint e não é rota de fuga.
  Ou seja: **sem um recurso same-origin (ou com CORS) não existe caminho legal do navegador
  que coloque esse áudio dentro de um `MediaStreamTrack`.** O proxy é o que torna o requisito
  "mixado no canal de música, cifrado como o resto da mídia" executável.
  Ganho colateral relevante: o resolve de página só é possível no servidor (o HTML do
  MyInstants também não tem CORS), e **só a máquina de quem dispara** toca o proxy — os
  ouvintes não falam com terceiro nenhum, que é a mesma política do oEmbed do YouTube em §6.9.
- **Alternativas descartadas:**
  - **Entrega `local` (cada ouvinte baixa e toca a mesma URL), no molde de `delivery: 'local'`
    do player.** Funciona sem proxy e dá mute local de graça, mas contraria o requisito
    explícito da task ("mixado no próprio canal de música de quem apertou, WebRTC, cifrado"),
    expõe o IP de **todos** os participantes ao MyInstants a cada disparo, e entrega o efeito
    com jitter de rede diferente em cada máquina — um efeito de 1s chegando desalinhado é pior
    que não chegar. Fica registrada como o plano B caso o proxy seja vetado; nesse caso a
    §3.2, a §3.4 e metade da §5 mudam, e o documento precisa ser revisto, não adaptado no ato.
  - **Extensão/Service Worker reescrevendo a resposta.** Service Worker não contorna CORS de
    terceiro; extensão não é opção num produto web.
  - **Empacotar os efeitos no bundle.** Mata o recurso: a graça é a pessoa colar o link do
    efeito que ela quer.
- **Aval necessário:** isto **expande o que o servidor faz e o que ele sabe**. Ele passa a
  transportar bytes de mídia (pública, de terceiro) e a ver "algum IP pediu o som X". Não vê
  sala, nem participante, nem conteúdo de chamada. As mitigações estão em §7.1 e a linha para
  a tabela de §5 do `ARCHITECTURE.md` está em §4.

### 3.2 Um barramento de música único por aba, dono do track do quarto transceiver

- **Decisão:** criar `lib/musicBus.ts` — um `MediaStreamAudioDestinationNode` único,
  construído sobre o `AudioContext` compartilhado (`lib/audioContext.ts`), cujo track é
  entregue **uma vez** a `mesh.setMusicTrack()`. `MusicEngine` passa a **receber** esse
  destination por injeção; o soundboard conecta seu próprio ramo no mesmo destination.
- **Motivação:** o soundboard tem de funcionar com o player desligado (ligar o player é
  votado; disparar efeito não é). Hoje o track do quarto transceiver nasce dentro do
  `MusicEngine` e `reconcilePlayback` chama `setMusicTrack(null)` em cinco ramos — qualquer
  um deles desligaria o soundboard no meio. Dois destinations disputando o mesmo sender
  produziriam `replaceTrack` alternado, identidade de track instável e corrida entre dois
  donos: o clássico bug que só aparece quando alguém usa os dois recursos na mesma sala.
- **Regra de propriedade, que é onde isso quebra se for implementado de véspera:** quando o
  destination é injetado, o `MusicEngine` **não o cria e não o destrói** — `destroy()` não
  pode chamar `stop()` nos tracks do barramento, e `stop()` continua desconectando apenas o
  `MediaElementSource` da faixa. Quem cria e fecha o barramento é o `Room`, junto do
  `AudioContext` (§6.6 do `ARCHITECTURE.md`).
- **Alternativas descartadas:**
  - **Um quinto transceiver só para o soundboard.** Dá mute independente de graça (§3.4), mas
    a ordem das m-lines é **contrato de rede** (§6.1): um client não atualizado classificaria
    errado e o efeito cairia no stream de voz, com o bug *parecendo* funcionar. Custa
    renegociação para todo mundo e uma incompatibilidade de deploy. Rejeitado.
  - **O soundboard chamar `setMusicTrack` quando o player não estiver transmitindo.** Corrida
    e churn de `replaceTrack`, com dois donos do mesmo sender. Rejeitado.

### 3.3 O sender de música fica inativo quando o barramento está ocioso

- **Decisão:** com o barramento sempre atado, o track passa a existir o tempo todo. Para não
  transmitir silêncio o dia inteiro, o mesh ganha `setMusicSenderActive(boolean)`, que ajusta
  `encodings[0].active` no `_applyMusicEncoding` já existente (mesma chamada de `setParameters`
  que hoje aplica o `maxBitrate`). A decisão de ligar/desligar é uma função **pura**
  (`planMusicSenderActivity`), com três entradas: o player está transmitindo? há efeito
  tocando (ou terminou há menos de 5s)? o painel do soundboard está aberto?
- **Motivação:** sob `iceTransportPolicy: 'relay'`, quem transmite sobe **N−1 cópias pelo
  TURN**. Um canal permanentemente ativo carregando silêncio é banda paga por todos, sempre,
  para nada — e §6.9 já teve de impor `maxBitrate` justamente por esse eixo. `active: false`
  não renegocia, é local ao sender e é o mecanismo padrão de pausar um sender.
- **A histerese não é enfeite:** reativar um sender leva alguns quadros, e um efeito de 1,2s
  perde o ataque se a ativação acontecer no mesmo instante do clique. Daí "painel aberto ⇒
  ativo" (quem vai disparar abriu o painel) e a cauda de 5s depois do último efeito.
- **Alternativa descartada:** deixar sempre ativo e confiar em DTX. DTX não está habilitado, o
  encoder não é configurável por aqui e o custo cairia em salas cheias — que é onde ele dói.

### 3.4 O silenciamento do ouvinte é uma janela temporal sobre o canal de música do peer

- **Decisão:** quem dispara **anuncia** o disparo por `soundboard-fire` no data channel
  (`soundId`, `title`, `durationMs`) **antes** de começar a tocar. Quem recebe, se estiver com
  o soundboard silenciado (global ou daquele participante), aplica `muted = true` no `<audio>`
  **daquele peer** dentro do `RemoteMusicAudio` por `durationMs + 1500ms` e restaura depois.
  A escolha nunca trafega.
- **Motivação:** é consequência direta do requisito. O efeito é mixado pelo remetente dentro
  do canal de música dele — no fio, efeito e música são **o mesmo sinal**. Nenhum receptor
  consegue separá-los, então o único ponto de controle possível é temporal, e ele depende do
  anúncio que já precisamos ter para o rate limit da ponta receptora e para a autoria na UI.
- **Trade-off que precisa estar na cara do usuário:** se o peer silenciado estiver, no mesmo
  instante, transmitindo música do player colaborativo, a música dele também emudece durante
  a janela (≤ ~16s no pior caso, tipicamente 1–3s). O rótulo do controle deve dizer isso.
- **Corrida de transporte, e por que o anúncio vem primeiro:** o anúncio vai por SCTP e o
  áudio por SRTP/TURN; os dois caminhos têm latências diferentes. Anunciar **antes** de dar
  `start()` no buffer (mesmo tick) faz o anúncio ganhar a corrida na esmagadora maioria dos
  casos. Ainda assim, o silenciamento é **best-effort nas bordas**: um vazamento de dezenas
  de ms é aceitável e deve estar documentado, não "consertado" com um atraso artificial no
  disparo, que custaria responsividade para todo mundo.
- **Alternativas descartadas:** quinto transceiver (§3.2); gate por WebAudio sobre o stream
  remoto (exige `MediaStreamAudioSourceNode` de stream remoto + o elemento `<audio>` fantasma
  que o Chrome exige para o stream fluir — muito mais peça móvel para o mesmo resultado que
  um `element.muted`); pedir ao remetente que não envie (isso faria a escolha do ouvinte
  trafegar, que é exatamente o que a task proíbe).

### 3.5 Favoritos persistem; participante silenciado, não

- **Decisão:** `wtk-meet:soundboard` guarda **favoritos + mute global + volume de monitoração**.
  A lista de participantes silenciados vive só na memória do `Room`.
- **Motivação:** `peerId` é o socket id daquela sessão; ele muda a cada reload de qualquer um
  dos lados. Persistir essa lista é gravar lixo que, na melhor das hipóteses, não faz nada e,
  na pior, silencia a pessoa errada na próxima sala.
- **Precedente seguido:** o módulo é **puro** e recebe um objeto storage-like, exatamente como
  `devices.ts` e `noiseSuppression.ts`; nunca lança (storage ausente, modo privado, JSON
  inválido, cota estourada caem todos no default). É a terceira chave do produto, e §6.10
  ("nada além dessas duas chaves ganha persistência") precisa ser atualizada na mesma entrega,
  com a justificativa: um favorito é uma preferência de UI do navegador, não conteúdo nem
  metadado de chamada, e não sai da aba.

### 3.6 O painel é exclusivo com chat e player, e a tríade vira um estado só

- **Decisão:** substituir `chatOpen`/`musicOpen` por um único `openPanel: 'chat' | 'music' |
  'soundboard' | null` no `Room`. O painel do soundboard é renderizado **antes** do
  `VideoGrid` dentro de `.stage` (que é um flex row), o que o coloca à esquerda, com a classe
  modificadora `.room.with-soundboard`.
- **Motivação:** §6.7 é dura — a página **nunca rola** e a grade é calculada para caber no
  viewport. Dois painéis abertos já espremeriam os tiles até o piso de legibilidade; três
  colunas quebram o roteiro de layout do e2e. Os dois booleanos de hoje já podem, em tese,
  ficar ambos `true`; um terceiro booleano transformaria isso em bug provável. Um enum torna
  a exclusividade estrutural em vez de disciplinar.
- **Alternativa descartada:** painel flutuante sobre a grade. Fica por cima de tiles e do card
  de votação, e §6.7/§6.8 já pagaram esse preço uma vez.

### 3.7 O volume que a sala ouve é fixo; o local é local

- **Decisão:** o ramo do soundboard que vai para a rede tem ganho **fixo** (1.0), com um
  `DynamicsCompressorNode` **apenas nesse sub-ramo** (nunca no caminho do player). O ganho de
  monitoração de quem dispara segue o slider de volume que já existe.
- **Motivação:** §6.9 fixou "volume é sempre local, e nunca trafega". Um slider que altera o
  que a sala ouve é a guerra de cliques que aquela decisão evitou. O compressor está lá porque
  efeito somado a música numa mesma soma satura, e saturação chega ao outro lado como
  distorção que ninguém sabe atribuir; deixá-lo fora do caminho do player preserva a
  qualidade que o `contentHint = 'music'` de §6.9 foi buscar.

---

## 4. Componentes Afetados

### Servidor (`packages/server`)

| Componente | O que muda | Por quê |
|---|---|---|
| `src/soundboardProxy.ts` **(novo)** | Resolução de URL de página → URL de mídia + título, e streaming de bytes com allowlist, timeouts, teto de tamanho e checagem de `Content-Type`. Lógica pura de validação (`isAllowedSoundUrl`, `extractMediaUrl`, `extractTitle`) separada do I/O, para teste em `node --test`. | Único caminho possível para o áudio virar `MediaStreamTrack` (§3.1). |
| `src/rateLimit.ts` **(novo)** | Balde de tokens por IP, em memória, com varredura periódica de entradas frias. Sem dependência nova. | O proxy é a primeira superfície do servidor que faz requisição de saída; sem teto ele vira open relay barato. |
| `src/index.ts` | Registra `GET /soundboard/resolve` e `GET /soundboard/media` atrás do rate limit e da flag `SOUNDBOARD_ENABLED`. | Onde as rotas moram. |
| `.env.example` | `SOUNDBOARD_ENABLED` (default `true`), `SOUNDBOARD_MAX_BYTES`, `SOUNDBOARD_TIMEOUT_MS`. | Operador precisa poder desligar o proxy sem redeploy do client. |

### Client — módulos puros (`packages/client/src/lib`)

| Componente | O que muda | Por quê |
|---|---|---|
| `soundboard.ts` **(novo)** | `parseMyInstantsUrl` (formas aceitas, só `http:`/`https:`, só host do MyInstants), `readSoundboard`/`writeSoundboard` (storage injetado, nunca lança), `addFavorite`/`removeFavorite`/`renameFavorite` com dedupe por URL de mídia e teto de itens. | Todo o parsing e a persistência, testáveis sem navegador (precedente `devices.ts`). |
| `soundboardRate.ts` **(novo)** | Limitador puro: `consume(state, now)` → `{ allowed, state, retryInMs }`, janela dupla (rajada + minuto). Usado nas duas pontas com a mesma tabela. | Rate limit é regra, não efeito; regra se testa em `node --test`. |
| `soundboardProtocol.ts` **(novo)** | `fireMessage()` e `sanitizeSoundboardMessage(payload, { fromPeerId })`, com a mesma regra de identidade de §6.9: **o autor é o peer da conexão**, nunca um campo do payload. | Entrada hostil vinda do data channel. |
| `musicBus.ts` **(novo)** | Cria/expõe/fecha o destination único e o track do quarto transceiver, mais o ponto de mixagem do soundboard (ganho + compressor). | §3.2. |
| `musicEngine.ts` | Passa a aceitar `getDestination` injetado; quando injetado, **não cria nem destrói** o destination nem para seus tracks. `_ensureGraph` cai para "garantir o ramo de monitoração". | §3.2 e a regra de propriedade. |
| `useMusicRoom.ts` | `setMusicTrack` deixa de ser chamado com `null` para desligar o canal: o track do barramento é atado uma vez. Os cinco ramos que hoje "desligam" passam a apenas parar a faixa. Injeta o destination no `MusicEngine`. | §3.2. |
| `webrtcMesh.ts` | `onSoundboardMessage` (predicado próprio, sem tocar em `MUSIC_MESSAGE_TYPES`), `sendSoundboardMessage`, `setMusicSenderActive`, e `_applyMusicEncoding` passando a carregar também `active`. | Roteamento e §3.3. |
| `soundboardPlayer.ts` **(novo)** | Busca pelo proxy → `decodeAudioData` → cache LRU de `AudioBuffer` → `AudioBufferSourceNode` no barramento + ramo de monitoração. Prefetch ao favoritar. | Efeito curto pede buffer decodificado: réplica instantânea, duração exata antes de tocar e nenhum `<audio>` novo por disparo. |
| `useSoundboard.ts` **(novo)** | Estado do painel, I/O de storage, limitador de saída e de entrada por peer, janelas de mute, lista de "tocou agora". | Espelha `useMusicRoom` como fronteira entre módulo puro e mundo real. |

### Client — UI

| Componente | O que muda | Por quê |
|---|---|---|
| `components/SoundboardPanel.tsx` **(novo)** | `aside` à esquerda: campo de colar URL, grade de favoritos (botões grandes), controle de mute global, contador/cooldown do rate limit e a lista de disparos recentes com autoria. | Superfície do recurso. |
| `components/RemoteMusicAudio.tsx` | Ganha `mutedPeerIds?: string[]` (hoje só há `muted` global) e aplica mute por peer. | §3.4. |
| `components/VideoTile.tsx` *(opcional, se couber sem tocar a contagem do e2e)* | Um controle "silenciar soundboard desta pessoa" no menu do tile. | Mute por participante precisa de um lugar óbvio; o painel também o oferece. |
| `pages/Room.tsx` | Enum `openPanel`, botão `Soundboard` na barra, montagem do painel à esquerda, fiação do hook e do mute por peer. | §3.6. |
| `styles.css` | `.soundboard-panel`, `.room.with-soundboard`, grade de favoritos. Largura ≤ 260px. | §6.7 — a página não rola. |
| `config.ts` | `SOUNDBOARD_BASE = ${SIGNALING_URL}/soundboard`, flag `VITE_ENABLE_SOUNDBOARD`. | Quem conhece URL de servidor é o `config.ts`; `lib/` fica puro. |

### Documentação

- `ARCHITECTURE.md`: nova **§6.13 Soundboard**; uma linha nova na tabela de §5 (o que o
  servidor passa a saber); emenda em §6.10 (terceira chave de storage) e em §6.9 (o quarto
  transceiver agora tem dois produtores e um barramento).
- `docs/progress/WTK-MEET-23.md`: progresso da task.

---

## 5. Contratos de Interface

### Endpoints REST (novos)

| Método | Path | Request | Response | Observações |
|---|---|---|---|---|
| GET | `/soundboard/resolve?url=<url>` | — | `200 {mediaUrl, title}` · `422 {error:'unsupported-url'}` · `404 {error:'not-found'}` · `429 {error:'rate-limited', retryInMs}` · `502 {error:'upstream'}` · `503 {error:'soundboard-disabled'}` | `url` só passa se host ∈ `{myinstants.com, www.myinstants.com}` e esquema `https:`. Lê no máximo 512 KB de HTML, timeout 5s, sem seguir redirect para fora da allowlist. Título vem de `og:title`/`<title>`, com o sufixo do site removido, limitado a 60 chars. |
| GET | `/soundboard/media?src=<url>` | — | `200 audio/*` (bytes) · `400 {error:'bad-src'}` · `413 {error:'too-large'}` · `415 {error:'not-audio'}` · `429` · `502` · `503` | `src` exige host da allowlist **e** caminho começando por `/media/sounds/`. Teto de 5 MB, timeout 8s, `Content-Type` obrigatoriamente `audio/*`, resposta com `Cache-Control: public, max-age=86400`. Sem Range: o client baixa inteiro para decodificar. |

> O middleware `cors({ origin: corsOrigin })` já existente cobre as duas rotas; não criar CORS
> próprio nem `*`.

### Eventos em tempo real (`RTCDataChannel` `wtk-chat`, o mesmo do chat e da música)

| Tipo | Payload | Quem emite | Quem consome |
|---|---|---|---|
| `soundboard-fire` | `{ type, soundId: string(≤80), title: string(≤60), durationMs: number(0…15000) }` | Quem apertou, **antes** de dar `start()` no buffer | Todos os peers: atribuem autoria pela conexão, aplicam o limitador de entrada e, se silenciado, abrem a janela de mute |

> Nenhum evento novo no servidor de sinalização — a regra de §6.9 continua valendo. Nenhuma
> URL trafega: o ouvinte não baixa nada. Um client antigo ignora o tipo desconhecido e apenas
> ouve o efeito sem atribuição, em vez de quebrar.

### Chave de `localStorage` (nova)

| Chave | Campo | Tipo | Default | Observações |
|---|---|---|---|---|
| `wtk-meet:soundboard` | `version` | `number` | `1` | Versão desconhecida ⇒ defaults, sem lançar. |
| | `sounds[]` | `{ id, title, pageUrl, mediaUrl, addedAt }` | `[]` | Máx. 40; dedupe por `mediaUrl`; `title` ≤ 60; URLs ≤ 300. |
| | `mutedAll` | `boolean` | `false` | Mute global do ouvinte. |
| | `monitorVolume` | `number 0…1` | `1` | Só o que **quem dispara** ouve de si. |

> Participantes silenciados **não** entram aqui (§3.5).

### Constantes de política (uma fonte só, exportada do módulo puro)

| Nome | Valor | Onde vale |
|---|---|---|
| `BURST_LIMIT` / `BURST_WINDOW_MS` | 3 / 5000 | Emissor e receptor |
| `MINUTE_LIMIT` | 12 | Emissor e receptor |
| `MAX_SOUND_MS` | 15000 | Recusa ao favoritar e teto da janela de mute |
| `MAX_CONCURRENT` | 3 | Vozes simultâneas na máquina de quem dispara |
| `MUTE_GUARD_MS` | 1500 | Cauda da janela de mute |
| `SENDER_TAIL_MS` | 5000 | Histerese do `active` do sender (§3.3) |

---

## 6. Dependências e Ordem de Implementação

1. **Servidor: validação pura + rate limit + as duas rotas** — não depende de nada; libera o
   client para trabalhar contra um endpoint real. *(Sem isso, todo o resto é indemonstrável.)*
2. **Client, módulos puros** (`soundboard.ts`, `soundboardRate.ts`, `soundboardProtocol.ts`) —
   paralelizáveis entre si e com o item 1.
3. **`musicBus.ts` + injeção no `MusicEngine` + ajuste em `useMusicRoom`** — depende de 2 só
   por conveniência. **É a mudança de maior risco de regressão**: o player colaborativo tem de
   continuar idêntico depois dela, e isso se verifica com a suíte de música existente **antes**
   de qualquer código de soundboard entrar.
4. **`webrtcMesh`: roteamento da mensagem + `setMusicSenderActive`** — depende de 2 (protocolo)
   e de 3 (o `active` só faz sentido com o barramento).
5. **`soundboardPlayer.ts`** — depende de 1 (proxy) e 3 (barramento).
6. **`useSoundboard.ts`** — depende de 2, 4 e 5.
7. **UI: `SoundboardPanel`, `RemoteMusicAudio` por peer, enum `openPanel` no `Room`, CSS** —
   depende de 6. O refactor do enum pode ir **antes**, isolado, e é bom que vá: ele mexe em
   caminho já coberto por e2e.
8. **Documentação** (`ARCHITECTURE.md` §6.13/§5/§6.9/§6.10, progresso) — em paralelo a partir do 3.

---

## 7. Riscos e Armadilhas

### 7.1 O proxy vira open relay ou vetor de SSRF

- **Risco:** `?src=` aceitando qualquer URL transforma o servidor em proxy anônimo e permite
  alcançar endereços internos da rede onde ele roda.
- **Mitigação:** allowlist de host **e** de prefixo de caminho antes de qualquer socket;
  esquema `https:` apenas; redirect não seguido para fora da allowlist; timeout e teto de bytes;
  rate limit por IP; `Content-Type` obrigatoriamente `audio/*`; nenhum header do cliente
  repassado para o upstream. Log **agregado** (contadores), nunca o par IP + URL — o servidor
  não precisa de um histórico de quem tocou o quê.
- **Anti-pattern:** validar a URL com `String.includes('myinstants.com')`. `https://evil.com/?x=myinstants.com`
  passa. Só `new URL()` + comparação exata de `hostname` decide isso.

### 7.2 Silêncio digital por CORS — a armadilha que este documento existe para evitar

- **Risco:** alguém "simplifica" apontando o `<audio>` direto para o MyInstants. O recurso
  parece funcionar na máquina de quem testa (o próprio ouve o monitor) e a sala recebe silêncio.
- **Mitigação:** o caminho é `fetch(proxy) → decodeAudioData → AudioBufferSourceNode`, sem
  `<audio>` e sem `createMediaElementSource` para efeitos.
- **Anti-pattern:** conferir "funcionou" só pelo próprio navegador. Só a segunda máquina prova
  que o áudio saiu.

### 7.3 O barramento derruba o player colaborativo em silêncio

- **Risco:** `MusicEngine.destroy()` parando os tracks de um destination que não é dele mata a
  música **e** o soundboard sem nenhum erro; ou algum `setMusicTrack(null)` remanescente
  desliga o canal com o soundboard no ar.
- **Mitigação:** regra de propriedade explícita (§3.2), e um teste que percorre o ciclo
  "tocar faixa → parar → disparar efeito → conferir que o track do sender é o mesmo objeto".
- **Anti-pattern:** manter `setMusicTrack(null)` "por segurança" nos ramos antigos.

### 7.4 O rate limit da ponta receptora não silencia áudio nenhum — e é fácil achar que silencia

- **Risco:** o áudio já vem mixado no canal do remetente. O limitador de entrada descarta
  **anúncios**, não som. Um peer com client modificado que dispare 50 efeitos por segundo é
  barrado na UI e continua audível.
- **Mitigação:** ser explícito no código e na UI. O limitador de entrada protege a lista de
  atividade, o agendamento de janelas de mute e a CPU. A única defesa real contra abuso de
  áudio é o mute por participante — então, ao estourar o limite de um peer, a UI deve oferecer
  **um clique** para silenciar o soundboard daquela pessoa.
- **Anti-pattern:** anunciar "rate limit protege a sala contra spam de áudio". Não protege;
  prometer isso é pior que não ter.

### 7.5 Regressão de layout e de e2e

- **Risco:** um terceiro painel quebra os roteiros que medem largura de tile e ausência de
  scroll; um botão novo na barra colide com seletor por `textContent` exato.
- **Mitigação:** exclusividade por enum (§3.6); rótulo do botão **`Soundboard`** — nunca algo
  que comece por `Silenciar`, `Chat` ou `Música`, porque o roteiro procura `.controls button`
  com `textContent === 'Silenciar'` e por `/^Chat/`. Rodar o e2e antes e depois e comparar com
  a **sua** linha de base (o total cresce por task; há uma falha pré-existente conhecida no
  roteiro F4a).
- **Anti-pattern:** pôr o `<audio>` do soundboard dentro do painel. O `RemoteMusicAudio` já
  aprendeu essa lição: fechar o painel silenciaria a sala e o sintoma pareceria rede.

### 7.6 Autoplay e `AudioContext` suspenso

- **Risco:** o disparo acontece num gesto (ok), mas o **ouvinte** que entrou e não clicou em
  nada tem a mídia bloqueada. Com o barramento sempre atado, o `<audio>` de música de cada
  peer passa a existir desde o início, então o aviso de áudio bloqueado tende a aparecer mais
  cedo do que antes.
- **Mitigação:** reusar o caminho que já existe (`useAudibleMedia` → `onBlocked` → botão
  `.audio-blocked` fora dos painéis). Não engolir a rejeição de `play()`.

### 7.7 O efeito não cabe no que o produto promete

- **Risco:** favoritar um mp3 de 40 minutos hospedado no MyInstants trava o canal e a janela
  de mute.
- **Mitigação:** `MAX_SOUND_MS` conferido **ao favoritar** (a duração é conhecida no decode) e
  novamente ao sanitizar o `durationMs` recebido.

### 7.8 Deriva de documentação

- **Risco:** §6.10 do `ARCHITECTURE.md` afirma "nada além dessas duas chaves ganha
  persistência"; esta entrega cria a terceira. Deixar a frase intacta transforma o documento em
  mentira sobre o próprio produto.
- **Mitigação:** a edição do `ARCHITECTURE.md` faz parte do escopo, não é follow-up.

---

## 8. Critérios de Aceite Técnicos

**Servidor**

1. `GET /soundboard/resolve?url=https://www.myinstants.com/en/instant/<slug>/` responde 200 com
   `mediaUrl` sob `/media/sounds/` e um `title` não vazio.
2. `url` de host fora da allowlist, esquema `http:` ou `file:`, ou com `myinstants.com` apenas
   na query responde **422**, sem nenhuma requisição de saída.
3. `GET /soundboard/media?src=` de host permitido mas caminho fora de `/media/sounds/` responde 400.
4. Upstream com `Content-Type` não-áudio responde 415; corpo acima do teto responde 413 e a
   conexão de saída é encerrada, não bufferizada até o fim.
5. Acima do limite por IP, responde 429 com `retryInMs`, e o corpo nunca vaza valor de segredo.
6. Com `SOUNDBOARD_ENABLED=false`, as duas rotas respondem 503 e o restante do servidor é
   bit-a-bit o de hoje (`/health`, `/turn-credentials`, sinalização).

**Client — favoritos e parsing**

7. Colar URL de página **ou** de mídia do MyInstants cria um favorito; colar YouTube, `javascript:`,
   `data:` ou texto solto recusa com mensagem no campo, e o texto colado **permanece** lá.
8. Favoritar duas vezes a mesma mídia não duplica a entrada.
9. Storage ausente, `getItem` lançando, JSON inválido ou versão desconhecida ⇒ painel abre
   vazio e funcional, sem exceção no console.
10. Ao chegar ao teto de 40 favoritos, adicionar é recusado com mensagem — não silenciosamente ignorado.

**Client — disparo e sala**

11. Com o player colaborativo **desligado**, um clique num favorito é audível nas outras
    máquinas em menos de ~1s.
12. Com o player colaborativo **tocando**, o mesmo clique é audível **por cima** da música, sem
    interromper nem reiniciar a faixa, e o track do sender de música não é substituído.
13. Silenciar o mic (`toggleMute`) não silencia o efeito para a sala.
14. Enquanto ninguém dispara e o painel está fechado e o player não transmite, o sender de
    música está com `active: false` (verificável em `getParameters()`); ele volta a `true` ao
    abrir o painel.

**Client — rate limit e mute**

15. Quatro disparos em menos de 5s: o quarto não sai (nenhuma mensagem no data channel, nenhum
    áudio) e o botão mostra o tempo restante.
16. Um peer que anuncie acima do limite tem os anúncios excedentes descartados, sem toast por
    anúncio, e a UI oferece silenciar o soundboard daquela pessoa em um clique.
17. Com o mute global ligado, o efeito de qualquer peer não é ouvido; com mute por participante,
    só o daquele peer emudece, e o de outro continua audível.
18. O estado de mute **não** produz nenhuma mensagem no data channel nem no socket — verificável
    inspecionando o tráfego do canal enquanto se alterna o controle.
19. Recarregar a página preserva favoritos e o mute global, e **zera** a lista de participantes
    silenciados.

**Não-regressão**

20. Suíte de servidor e de client verdes (a linha de base é 56/56 e 520/520 mais o que esta
    entrega acrescentar), `typecheck` e `lint` limpos, e o e2e sem falha nova em relação à
    linha de base medida **nesta branch antes da primeira alteração**.

---

## 9. Notas para os Agentes de Implementação

**Quem faz o quê**

- **Agente de backend:** itens 1 e 2 da ordem (§6) — `soundboardProxy.ts`, `rateLimit.ts`,
  rotas e testes. Entregável isolado e mergeável sozinho.
- **Agente de client:** itens 2 a 7. Recomendo commits separados para (a) módulos puros,
  (b) barramento + `MusicEngine`, (c) mesh, (d) player + hook, (e) UI. O commit (b) é o que
  precisa de suíte verde por si só, antes de o soundboard existir.
- **Agente de documentação/QA:** item 8 e a validação final.

**Pitfalls específicos desta demanda, que não estão na documentação do projeto**

1. **O MyInstants não manda CORS.** Verificado em 2026-09-01. Qualquer tentativa de encurtar o
   caminho falando direto com o site do navegador termina em silêncio sem erro (§7.2).
2. **Anúncio antes do `start()`**, no mesmo tick. Invertido, o mute do ouvinte perde a corrida
   com o áudio em boa parte dos disparos.
3. **`decodeAudioData` consome o `ArrayBuffer`.** Guardar o `AudioBuffer` decodificado no
   cache, nunca o buffer cru, e nunca decodificar duas vezes o mesmo `ArrayBuffer`.
4. **`AudioBufferSourceNode` é de uso único.** Um nó novo por disparo; reusar não toca de novo
   e não lança nada útil.
5. **A regra de identidade de §6.9 vale aqui inteira:** o autor do `soundboard-fire` é
   `rec.peerId`. Nenhum campo `from` no payload — e, se aparecer um, ele é ignorado, não
   validado.
6. **Não estender `MUSIC_MESSAGE_TYPES`.** O soundboard tem predicado e sanitizador próprios;
   misturá-lo no protocolo de música arrasta o `sanitizeMusicMessage` para um domínio que não
   é dele e confunde a convergência de sessão com um evento sem estado.
7. **O rótulo do botão na barra de controles é `Soundboard`**, exato, sem emoji (§7.5).
8. **O worktree pode desaparecer no meio da sessão:** commite cedo e com frequência.

**Ordem de validação depois de implementar**

1. `npm test` do server e do client (um `npm install` na raiz cobre os workspaces).
2. `typecheck` e `lint` nos três pacotes.
3. E2E completo, comparado com a linha de base medida **nesta branch antes de qualquer
   alteração** — o total de roteiros cresce por task, então comparar com um número herdado de
   outra task produz falso alarme.
4. Teste manual com **duas máquinas/abas**: só a segunda prova que o áudio saiu (§7.2).
5. Conferir `getParameters()` do sender de música nos quatro estados de §3.3.

**Divergências e pendências registradas**

- **§3.1 pede aval.** O proxy expande o papel do servidor. Se o aval não vier, o plano B é a
  entrega `local` (cada ouvinte baixa o mp3), que **contraria o texto da task** e muda §3.2,
  §3.4 e §5 — nesse caso, revisar este documento antes de implementar, não improvisar no código.
- **§3.4 pede aval de produto:** silenciar o soundboard de alguém que esteja transmitindo
  música do player também emudece a música dela durante a janela. É consequência inevitável de
  mixar no mesmo canal; a alternativa (quinto transceiver) custa renegociação e quebra de
  contrato de m-lines.
