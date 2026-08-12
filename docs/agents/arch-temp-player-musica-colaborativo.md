# Player de música colaborativo P2P na sala — Documento de Arquitetura Técnica

> Gerado em: 2026-08-12
> Status: Rascunho
> Task: WTK-MEET-8 — Implementar player de música colaborativo P2P na sala

---

## 1. Contexto e Objetivo

### Problema atual

A sala wtk-meet entrega áudio, vídeo e compartilhamento de tela em mesh WebRTC, e chat por
`RTCDataChannel` (`ARCHITECTURE.md` §6). Não existe nenhum recurso de música: para ouvir algo
junto, hoje a única saída é alguém compartilhar tela — que nesta versão **não captura áudio do
sistema** (`ARCHITECTURE.md` §9). Ou seja: hoje é literalmente impossível ouvir som junto na sala.

### Comportamento esperado após a entrega

- Um botão **Música** na barra de controles abre uma **votação** da sala. Aprovada por maioria
  com quórum e prazo, o player fica habilitado para todos até a sala esvaziar.
- Com o player habilitado, qualquer participante adiciona faixas a uma **fila colaborativa**, a
  partir de três origens: **YouTube**, **arquivo local** e **URL direta de áudio**.
- O áudio da faixa corrente é **retransmitido pelo participante que a adicionou**, por um canal de
  áudio dedicado do mesh — exceto quando a origem torna isso tecnicamente impossível (YouTube) ou
  desnecessário (URL pública sem CORS), casos em que a faixa toca localmente em cada client,
  sincronizada pelo mesmo estado (§3.4).
- Fila, faixa corrente, posição de reprodução e votos vivem **nos clients** e trafegam pelo data
  channel que já existe. Quem entra depois recebe um **snapshot**.
- **Nenhuma rota, evento ou estado novo no servidor de sinalização.** `server/` fica intocado.

### Vínculo com o produto

O projeto tem uma invariante que atravessa cada decisão: o servidor de sinalização não vê conteúdo
(`ARCHITECTURE.md` §5), e o único evento acrescentado ao protocolo em toda a história do projeto foi
`join-request-cancelled`, justificado caso a caso. Música é conteúdo. Se ela passasse a exigir um
serviço de fila no backend, o produto trocaria sua característica definidora por uma funcionalidade
social — mau negócio. Este documento existe, em boa parte, para provar que dá para entregar a
funcionalidade inteira sem tocar no servidor.

---

## 2. Escopo

**Dentro do escopo:**

- Votação de habilitação do player: proposta, coleta de votos, apuração determinística, prazo,
  resultado e anti-spam.
- Modelo de estado musical replicado nos clients (fila, faixa corrente, posição, votos), com
  ordenação determinística, merge convergente e snapshot para quem entra depois.
- Quarto canal de áudio (`sendonly`) por conexão do mesh, dedicado a música, pré-criado junto dos
  três existentes — sem renegociação dinâmica.
- Motor de reprodução no client: grafo WebAudio para arquivo local e URL direta; player IFrame do
  YouTube para faixas do YouTube; sincronização de posição para as origens que tocam localmente.
- UI: botão na barra de controles, painel do player (faixa atual, progresso, fila, formulário de
  adicionar), card de votação não-bloqueante, volume **local** por ouvinte.
- Testes unitários (`node:test`) do módulo puro de estado musical, na convenção de
  `client/test/*.test.mjs`.
- Atualização de `ARCHITECTURE.md` (nova subseção §6.8), `README.md` e `claude-progress.md`.

**Fora do escopo:**

- Qualquer mudança em `server/` — nenhuma rota, nenhum evento Socket.IO, nenhum estado novo.
- Persistência de qualquer tipo: a fila morre com a sala, exatamente como o chat (§6.3). Sem
  `localStorage`, sem playlists salvas, sem histórico de reprodução.
- Busca dentro do YouTube (autocomplete, resultados, thumbnails via Data API). Só entra **link
  colado**. Busca exigiria chave de API e chamadas a um serviço de terceiros a cada tecla.
- Transferência do arquivo local entre participantes (ninguém baixa o MP3 de ninguém — só o áudio
  decodificado é retransmitido, como som).
- Ducking automático da música quando alguém fala, crossfade, equalizador, letras, "modo festa",
  reações. Todos são incrementos posteriores sobre o mesmo estado.
- Estéreo. O canal de música nasce **mono** (§3.3). Estéreo exige munging de SDP no fmtp do Opus e
  é uma entrega separada.
- Reordenar a fila por drag-and-drop. Nesta entrega a ordem é a de inserção (determinística, §5.3);
  remover e re-adicionar cobre o caso.
- Votação para pular faixa ou para desligar o player (§3.7 explica por quê).

---

## 3. Decisões Arquiteturais

### 3.1 Canal de áudio dedicado (quarto transceiver), não mixagem no microfone

- **Decisão:** cada `RTCPeerConnection` passa a nascer com **quatro** transceivers `sendonly`, na
  ordem fixa **áudio (mic), vídeo (câmera), vídeo (tela), áudio (música)**. A música do participante
  que "possui" a faixa corrente entra por `replaceTrack()` no quarto sender, exatamente como
  câmera e tela entram nos seus (`ARCHITECTURE.md` §6.1). Sem renegociação, sem SDP novo em runtime.
- **Motivação:** a alternativa óbvia — mixar a música no track do microfone via WebAudio — é uma
  armadilha com quatro consequências, todas ruins e nenhuma óbvia no momento de escrever o código:
  1. `toggleMute` desliga o mic com `track.enabled = false` no track do `localStream`. Se a música
     estiver mixada ali, **silenciar o microfone silencia a música para a sala inteira** — e para
     ninguém mais, o que produz um bug de "só eu ouço" praticamente impossível de diagnosticar.
  2. O indicador de fala (§6.4) mede o stream do peer. Música mixada no mic deixa o **anel azul
     aceso permanentemente** no tile do DJ, destruindo o recurso enquanto a música toca.
  3. O ouvinte perde qualquer controle: abaixar a música do outro seria abaixar a voz dele junto.
  4. O track do mic é negociado com processamento de voz (AEC/NS/AGC) e perfil Opus de fala. Um
     canal separado pode receber `contentHint = 'music'` e `maxBitrate` próprio sem afetar a voz.
- **Custo aceito:** duas m-lines a mais por conexão (uma de cada lado), e a extensão do contrato de
  ordem de m-lines de 3 para 4. Com 6 participantes são 8 m-lines de mídia por `pc` — irrelevante
  perto do custo de vídeo do mesh.
- **Alternativas descartadas:**
  - **Mixar no mic:** acima.
  - **Criar o transceiver de música sob demanda**, só quando alguém liga o player: viraria
    renegociação em runtime, em mesh, com perfect negotiation e glare de verdade acontecendo. O
    projeto inteiro é construído para *não* renegociar (§6.1); abrir essa exceção por música é
    trocar um transceiver ocioso por uma classe de bug de negociação.
  - **Um `RTCDataChannel` transportando o arquivo de áudio comprimido:** reinventa streaming, buffer,
    jitter e sincronização por cima de SCTP, e ainda transfere o arquivo inteiro (o que o escopo
    exclui). WebRTC já resolve áudio em tempo real; usar o meio certo é a escolha boring.

### 3.2 Quem manda no estado: dono da faixa escreve reprodução, fila é convergente sem líder

Não há servidor, não há relógio autoritativo e não há eleição confiável — então cada pedaço de
estado precisa de uma regra própria que **convirja sozinha**.

- **Decisão A — reprodução tem escritor único: o dono da faixa corrente** (`addedBy`). Play, pause,
  seek e avanço de faixa são escritos só por ele, com um `version` monotônico. Qualquer outro
  participante que aperte pause envia um **pedido** (`music-command`); o dono aplica e publica o
  estado resultante. Todos os demais são leitores.
  - **Motivação:** o áudio nasce na máquina do dono (§3.1/§3.4) — ele é o único que pode
    materializar "pausado" de verdade. Fazer dele o escritor alinha autoridade com capacidade
    física, e elimina o cenário de dois clients publicando `playing: true/false` alternadamente.
  - **Colaborativo continua colaborativo:** qualquer um comanda; o que é único é quem *aplica*.
- **Decisão B — fila é um conjunto append-only com tombstones, sem líder.** Cada entrada tem `id`
  único, um relógio lógico `lamport` e o `addedBy`. A ordem é `(lamport, addedBy, id)`, total e
  determinística. Remover é publicar um tombstone. Merge de dois estados é união de entradas menos
  união de tombstones.
  - **Motivação:** adicionar à fila é a operação mais frequente e a mais concorrente ("todo mundo
    joga música ao mesmo tempo"). Passar toda inserção por um líder cria latência, um ponto de falha
    social (o líder saiu no meio) e um protocolo de eleição. União com ordem determinística é ~30
    linhas, converge sem coordenação e sobrevive a qualquer ordem de chegada.
- **Decisão C — troca de dono é derivada, não negociada.** Quando a faixa termina, o dono publica o
  avanço e a autoridade passa ao dono da próxima faixa (implícita no novo estado). Quando o dono
  **cai**, todos veem o mesmo `peer-left` e aplicam a mesma regra: assume o participante presente de
  menor socket id (o mesmo critério lexicográfico determinístico já usado no polite/impolite,
  §6.1); se for eu, eu publico. Faixa de arquivo local do peer que saiu não pode continuar — é
  pulada, com aviso na UI.
- **Alternativas descartadas:**
  - **Líder global único ("host de música") para tudo:** simplificaria o modelo, mas concentra no
    líder a obrigação de retransmitir áudio de faixas que ele não tem (arquivo local de outro é
    inacessível para ele). Autoridade e posse de mídia se separariam — exatamente o que a Decisão A
    evita.
  - **CRDT de verdade (Yjs/Automerge):** dependência nova e um modelo de conflito muito maior do que
    "uma lista que só cresce". `ARCHITECTURE.md` §7 é explícito sobre evitar SDKs para o que cabe em
    algumas dezenas de linhas.
  - **Eleição por consenso (Raft-lite) no data channel:** complexidade desproporcional para uma fila
    de músicas de até 6 pessoas.

### 3.3 Um canal, mono, com teto de bitrate

- **Decisão:** o track de música sai mono, com `contentHint = 'music'` e `maxBitrate` via
  `sender.setParameters()` (sugerido: 96 kbps; piso aceitável 64 kbps).
- **Motivação:** o client roda com `iceTransportPolicy: 'relay'` (`webrtcMesh.js`) — **todo** o
  tráfego passa pelo TURN. Em mesh, quem toca sobe N−1 cópias: com 6 pessoas, 5 × 96 kbps ≈ 480 kbps
  **além** das 5 cópias de vídeo. Sem teto explícito, o Opus pode subir e disputar banda com o vídeo
  no pior momento (sala cheia). `contentHint = 'music'` desativa heurísticas de fala no encoder.
- **Alternativas descartadas:** estéreo (dobra o custo e exige munging de fmtp — fora de escopo);
  deixar o bitrate no automático (aposta contra o pior caso, que é justamente quando a sala está
  cheia e alguém liga música).

### 3.4 Duas formas de entrega, escolhidas pela origem — e o limite intransponível do YouTube

O enunciado pede "áudio retransmitido pelo stream de quem adicionou a faixa". Isso é possível para
duas das três origens e **impossível para a terceira**. Registrando com todas as letras, porque é a
única parte da demanda que não pode ser entregue como descrita:

| Origem | Entrega | Por quê |
|---|---|---|
| Arquivo local | `stream` (retransmitido) | É a **única** possibilidade: ninguém mais tem o arquivo. `<audio>` + `MediaElementSource` → `MediaStreamDestination` → track. |
| URL direta de áudio | `stream` se o host mandar CORS; senão `local` | `createMediaElementSource` sobre mídia cross-origin **sem** `Access-Control-Allow-Origin` produz silêncio (o grafo é "tainted", sem erro visível). Sem CORS, cada client baixa a mesma URL pública e toca localmente. |
| YouTube | `local` (obrigatoriamente) | O player do YouTube roda num **iframe cross-origin**. Não existe API que dê acesso ao áudio dele: nem `MediaElementSource`, nem captura de elemento, nada. As únicas formas de "retransmitir" seriam extrair o stream (viola os Termos de Serviço do YouTube e exigiria componente de servidor — duplo veto) ou capturar o áudio da própria aba, que captura junto **a voz dos outros participantes** e cria loop de realimentação. |

- **Decisão:** o modelo suporta os dois modos, e a entrada `delivery` da faixa (`'stream' | 'local'`)
  é decidida **pelo dono antes de tocar** e anunciada no estado. Ouvintes não escolhem — obedecem.
- **No modo `local`**, a sincronização é por posição, com o dono como relógio mestre (§5.4). Toda a
  camada de fila, votação, comandos e UI é idêntica nos dois modos; muda só quem produz o som.
- **Consequência do modo `local` para YouTube que precisa de decisão de produto:** o iframe do
  YouTube passa a carregar **no navegador de cada participante**, o que significa que a Google vê o
  IP de todo mundo na sala e o que a sala está ouvindo. Isso contradiz frontalmente
  `ARCHITECTURE.md` §1 ("nenhuma dependência de infraestrutura de terceiros") e enfraquece a
  promessa de privacidade. Mitigação proposta em §7; **isso é um trade-off de produto, não técnico**,
  e a implementação deve deixá-lo desligável por flag (§4).

### 3.5 Votação: proposta com árbitro, maioria da lista de eleitores, prazo e trava anti-spam

- **Decisão:** o proponente é o **árbitro** da própria votação. Ele anuncia
  `{ voteId, electorate, durationMs }`, recebe os votos, apura e publica `music-vote-result`. Os
  demais apuram em paralelo **apenas para a UI**; a fonte de verdade do resultado é o anúncio do
  árbitro. Aprovação exige `sim >= floor(E/2) + 1` sobre a lista de eleitores `E` fixada na abertura
  (o "sim" do proponente já conta). Prazo sugerido: **45s**.
- **Motivação:** apuração distribuída por prazo diverge — cada máquina expira o relógio num instante
  diferente, e um voto que chega no limite pode ser contado por uns e não por outros, produzindo
  "metade da sala com música ligada". Um árbitro converte um problema de consenso num anúncio.
  E como maioria sobre lista fixa é **monotônica** (uma vez atingida, nunca desfeita), o resultado
  positivo é estável mesmo com mensagens fora de ordem.
- **Regras de borda, todas determinísticas:**
  - Sala com **um** participante: eleitorado 1, aprovado sem rede (senão um usuário sozinho nunca
    consegue ligar o player).
  - **Duas propostas simultâneas:** vence a de menor `(lamport, proposerId)`; a outra é cancelada
    localmente por todos, pela mesma regra.
  - **Árbitro sai antes de publicar:** todos cancelam a votação ao ver `peer-left` dele.
  - **Quem entra durante a votação** não vota e não é eleitor. Recebe só o resultado (o flag
    `enabled` do snapshot).
  - **Anti-spam:** após uma reprovação, propostas do mesmo autor são ignoradas por 2 minutos —
    verificado por quem recebe. Sem isso, "vote de novo" a cada 3 segundos é assédio dentro de uma
    reunião de trabalho.
- **Alternativas descartadas:** quórum separado da maioria (dois números para explicar, mesmo
  resultado); unanimidade (uma pessoa distraída veta a sala inteira); "quem cria a sala decide"
  (contradiz §4 do `ARCHITECTURE.md`, onde não existe host).

### 3.6 Votação é card não-bloqueante, não modal

- **Decisão:** a votação aparece como um **card fixo** (canto da tela, com contagem regressiva e
  Sim/Não), acima dos toasts e **abaixo** do `JoinRequestModal`. Fecha por `Esc`/clique fora, sem
  votar — abster-se é legítimo e o prazo resolve.
- **Motivação:** o modal bloqueante existe para aprovação de entrada porque ali o custo de ignorar é
  alguém preso do lado de fora (§3.5 do doc anterior). Música não tem esse custo. Bloquear a tela de
  uma reunião com uma votação de playlist é exatamente o tipo de decisão que faz desligarem o
  recurso. O `z-index` abaixo do modal de entrada é requisito: controle de acesso nunca fica atrás
  de música.
- **Alternativas descartadas:** reaproveitar o `JoinRequestModal` (herdaria "não fecha por Esc", que
  aqui é errado); toast comum (some em 4s — não dá para votar).

### 3.7 Pular e remover são abertos, com autoria visível

- **Decisão:** qualquer participante pula a faixa corrente ou remove uma entrada da fila. A UI
  mostra quem fez ("pulada por Fulano"). Não há votação para pular.
- **Motivação:** votar cada pulo transforma cada música ruim numa cerimônia de 45 segundos — o
  recurso morre de fricção. O controle social direto (todo mundo vê quem pulou, numa sala de até 6
  pessoas onde todos se conhecem o suficiente para terem se aprovado mutuamente) é proporcional ao
  dano possível. A votação existe onde o custo é alto e irreversível: **ligar** o player.
- **Anti-pattern a evitar:** "só o dono pula a própria faixa". Se o dono se distrai ou fica sem
  atenção na aba, a sala fica refém de uma faixa de 20 minutos.

### 3.8 `AudioContext` continua único e passa a ser do `Room`

- **Decisão:** extrair a criação do `AudioContext` de `AudioLevelMonitor` para um módulo
  `lib/audioContext.js` (um acessor único). `Room` cria/fecha; `AudioLevelMonitor` e o motor de
  música **recebem** o contexto. `AudioLevelMonitor.close()` deixa de fechar o contexto (passa a só
  desmontar seus analisadores); quem fecha é a limpeza do `Room` (§6.6 continua valendo, muda só o
  dono).
- **Motivação:** `ARCHITECTURE.md` §6.4 fixa "**um** `AudioContext` para a sala inteira", e nós de
  contextos diferentes **não podem ser conectados** — o grafo da música precisa do mesmo contexto do
  monitor. Deixar o monitor dono seria fazer o motor de música depender de um objeto cujo ciclo de
  vida pertence a outro recurso: `monitor.close()` mataria a música em silêncio.
- **Alternativa descartada:** um `AudioContext` só para música — o navegador limita o número de
  contextos, o custo de CPU dobra e a regra explícita da arquitetura seria quebrada por conveniência.

### 3.9 Volume é sempre local e nunca trafega

- **Decisão:** cada participante controla o volume que **ele** ouve (`<audio>.volume` para faixas em
  `stream`, ganho local para faixas em `local`, ganho de monitoração para o dono). Nenhuma mensagem
  de volume existe no protocolo.
- **Motivação:** volume compartilhado é uma guerra de cliques garantida, e mais um campo de estado
  para convergir sem nenhum ganho. Mantém a linha do §6.4: o que pode ser local, é local.

---

## 4. Componentes Afetados

### Frontend — novos arquivos

| Arquivo | O que é | Por quê |
|---|---|---|
| `client/src/lib/musicSession.js` | **Módulo puro, sem DOM e sem WebAudio.** Modelo do estado musical: apuração de votos, ordenação/merge da fila, aplicação de estado de reprodução por versão, sanitização de tudo que chega do data channel, relógio lógico. | Núcleo das decisões 3.2 e 3.5. Puro para ser fixado em `node:test`, no mesmo padrão de `gridLayout.js` e `audioLevels.js`. É aqui que mora a corretude da convergência. |
| `client/src/lib/musicEngine.js` | Motor de reprodução: grafo WebAudio (`<audio>` → `MediaElementSource` → ganho → `MediaStreamDestination` + monitoração local), controle de play/pause/seek, sonda de CORS, ciclo de vida de `objectURL`. Expõe o track de saída. | Isola tudo que toca em DOM/WebAudio, mantendo `musicSession.js` puro. |
| `client/src/lib/youtubePlayer.js` | Carregamento sob demanda da IFrame Player API, parsing de URL → videoId, controle do player e leitura de título/duração. | Confina a dependência de terceiros num arquivo só, que pode ser desligado por flag (§3.4). |
| `client/src/lib/audioContext.js` | Acessor único do `AudioContext` (criar, resumir sob gesto, fechar). | Decisão 3.8. |
| `client/src/components/MusicPanel.jsx` | Painel do player: faixa atual + progresso, controles, fila ordenada, formulário de adicionar (YouTube / arquivo / URL), volume local. | UI principal. Segue o padrão do `ChatPanel` (aside dentro do palco). |
| `client/src/components/MusicVoteCard.jsx` | Card não-bloqueante de votação, com contagem regressiva e Sim/Não. | Decisão 3.6. |
| `client/src/components/RemoteMusicAudio.jsx` | Elementos `<audio>` ocultos, um por peer, ligados ao `musicStream` daquele peer, com volume local. **Sempre montado**, fora dos ramos de fase. | É o que faz a música tocar para quem ouve. Se ficar dentro de um ramo condicional, o som some quando o painel fecha. |
| `client/test/musicSession.test.mjs` | Testes do módulo puro. | Fixa apuração, ordenação, merge e sanitização como contrato. |

### Frontend — arquivos modificados

| Arquivo | O que muda | Por quê |
|---|---|---|
| `client/src/lib/webrtcMesh.js` | (a) quarto transceiver `sendonly` de áudio (`rec.musicT`), criado **após** `screenT`; (b) `_classifyTransceiver` passa a mapear `['audio','camera','screen','music']`; (c) `rec.musicStream` + callback `onRemoteMusic(peerId, stream)`; (d) `setMusicTrack(track)` com `contentHint`/`maxBitrate`; (e) roteamento das mensagens `music-*` para um callback `onMusicMessage(peerId, payload)`; (f) no `onopen` do canal, além do `state`, envia o **snapshot** musical via callback `getMusicSnapshot()`. | Decisões 3.1 e 3.2. |
| `client/src/lib/audioLevels.js` | Recebe o `AudioContext` por injeção; `ensureContext()` delega ao módulo compartilhado; `close()` não fecha mais o contexto. **Nenhuma mudança nos limiares, na histerese ou no formato do snapshot** — `audioLevels.test.mjs` tem que continuar verde sem edição. | Decisão 3.8. |
| `client/src/pages/Room.jsx` | Estado da sessão musical + reducer; wiring dos callbacks do mesh; botão **Música** na `.controls`; `MusicPanel` no palco (mutuamente exclusivo com o chat); `MusicVoteCard` e `RemoteMusicAudio` no wrapper comum de overlays (antes dos `return` de fase); no `peer-left`, aplicar a regra de sucessão (§3.2 C). | Integração. |
| `client/src/styles.css` | Painel do player, card de votação, linha da fila, barra de progresso, botão de música; `z-index` do card entre toasts (20) e modal de entrada (30). | UI. |
| `client/src/components/VideoTile.jsx` | **Nenhuma mudança.** O tile não ganha indicador de música. | Reduz superfície de regressão no e2e, que depende das classes desse componente. |
| `e2e/run.mjs` | Acréscimo de um roteiro de música (opcional nesta entrega, ver §9). Nenhuma alteração nos roteiros existentes. | Cobertura. |

### Backend / infra / banco

**Nada.** Nenhuma rota, nenhum evento, nenhum schema, nenhuma variável de ambiente no servidor.
`server/` não deve aparecer no diff. Única variável nova, no client: `VITE_ENABLE_YOUTUBE`
(default `true`), que desliga a origem YouTube inteira em deployments que leiam §1 do
`ARCHITECTURE.md` ao pé da letra (§3.4).

---

## 5. Contratos de Interface

Não há endpoints REST novos nem alterados. Não há schema de banco (não há banco). Não há eventos
novos no servidor de sinalização. Todo o contrato é do **data channel P2P já existente**
(`wtk-chat`, `negotiated: true, id: 0`), que hoje carrega `type: 'chat'` e `type: 'state'`.

> Compatibilidade: `_handleChannelMessage` ignora tipos desconhecidos, então clients antigos não
> quebram ao receber `music-*` — apenas não participam.

### 5.1 Mensagens do data channel (todas novas, prefixo `music-`)

| Tipo | Payload | Quem emite | Quem consome |
|---|---|---|---|
| `music-vote-open` | `{ voteId, lamport, proposerName, electorate: [peerId], durationMs }` | Proponente (árbitro) | Todos |
| `music-vote-cast` | `{ voteId, vote: 'yes' \| 'no' }` | Cada eleitor | Árbitro (decide) e demais (só UI) |
| `music-vote-result` | `{ voteId, approved: bool, yes: int, no: int }` | Somente o árbitro | Todos |
| `music-queue-add` | `{ entry }` (ver 5.2) | Quem adiciona | Todos |
| `music-queue-remove` | `{ entryId, byName }` | Qualquer participante | Todos |
| `music-playback` | `{ version, ownerId, entryId \| null, positionSec, playing, delivery, endedReason? }` | **Somente o dono** da faixa corrente | Todos |
| `music-command` | `{ entryId, action: 'pause' \| 'resume' \| 'seek' \| 'skip', positionSec? }` | Qualquer participante | Dono da faixa (demais ignoram) |
| `music-snapshot` | `{ enabled, lamport, entries: [entry], tombstones: [entryId], playback }` | Todo peer, no `onopen` do canal com um peer novo | O peer que acabou de entrar |

**Regra de identidade (segurança):** o autor de qualquer mensagem é o peer da conexão em que ela
chegou (`rec.peerId`). Nenhum campo `from`/`authorId` do payload pode ser usado como identidade —
em mesh completo toda mensagem vem direto do autor, e aceitar um id declarado permitiria votar ou
comandar no lugar de outro. `entry.addedBy` recebido deve ser **sobrescrito** por `rec.peerId`.

### 5.2 Forma da entrada de fila (`entry`)

| Campo | Tipo | Obrigatório | Observações |
|---|---|---|---|
| `id` | string (uuid) | sim | Gerado por quem adiciona. **Ao contrário do chat, não é regerado na recepção** — é a identidade da entrada na fila. Colisão resolve por *first-write-wins*: id já conhecido é ignorado. |
| `kind` | `'youtube' \| 'file' \| 'url'` | sim | Fora do conjunto → descartar a mensagem inteira. |
| `title` | string (≤ 120) | sim | Nome do arquivo, título do vídeo ou último segmento da URL. Best-effort. |
| `durationSec` | número > 0 ou `null` | não | `null` até ser conhecida (arquivo/URL só revelam ao carregar). |
| `sourceRef` | string (≤ 300) | sim | `kind='youtube'`: **apenas o videoId** (11 chars, `[A-Za-z0-9_-]{11}`). `kind='url'`: URL absoluta `http`/`https` (qualquer outro esquema — `javascript:`, `data:`, `file:` — é descarte imediato). `kind='file'`: string vazia; o arquivo nunca sai da máquina do dono. |
| `addedBy` | peerId | sim | Sobrescrito pelo receptor com `rec.peerId`. |
| `addedByName` | string (≤ 40) | sim | Só exibição. |
| `lamport` | inteiro ≥ 0 | sim | Chave primária de ordenação. |

Limites: `MAX_QUEUE = 100` entradas vivas, `MAX_TOMBSTONES = 200` (descarta as mais antigas), e no
máximo **10 entradas por participante** na fila — trava de flood equivalente ao `MAX_HISTORY` do
chat.

### 5.3 Ordenação e merge (pseudológica, `musicSession.js`)

1. **Relógio lógico:** ao receber qualquer mensagem com `lamport`, `local = max(local, recebido) + 1`.
   Ao emitir, `local += 1` e envia o valor.
2. **Ordem da fila:** ordenar por `lamport` asc; empate por `addedBy` asc; empate por `id` asc.
   Total e determinística — dois clients com o mesmo conjunto exibem exatamente a mesma lista,
   independentemente da ordem de chegada.
3. **Merge de snapshot:** `entradas = (locais ∪ recebidas) \ (tombstones locais ∪ recebidos)`;
   `tombstones = união`. Nunca substituir a fila local pela recebida — um snapshot mais velho
   apagaria adições recentes. É por isso que o merge é união, e é por isso que tombstone existe:
   sem ele, um snapshot de quem não viu a remoção **ressuscita** a entrada removida.
4. **Estado de reprodução:** aplicar apenas se `(version, ownerId) > (version, ownerId)` corrente
   (comparação lexicográfica do par). Como só o dono escreve e a sucessão sempre usa um `version`
   maior, isso converge sem coordenação.
5. **Apuração (só para UI, no não-árbitro):** `sim >= floor(|electorate| / 2) + 1` → aprovado.
   O resultado exibido como definitivo é sempre o do `music-vote-result`.

### 5.4 Sincronização de posição (somente `delivery: 'local'`)

- O dono publica `music-playback` a cada **5s** e em toda mudança (play/pause/seek/troca de faixa).
- O receptor guarda `{ positionSec, receivedAt: performance.now() }` e estima
  `esperado = positionSec + (performance.now() − receivedAt) / 1000` enquanto `playing`.
- **Nunca comparar `Date.now()` de máquinas diferentes.** Relógios de participantes distintos podem
  divergir minutos; a estimativa acima usa exclusivamente relógio local a partir do instante de
  recepção, o que elimina o problema sem nenhum protocolo de sincronização de relógio.
- Correção: se `|esperado − posiçãoReal| > 1.5s`, dar `seek`; **no máximo uma correção a cada 5s**
  (seek causa buffering, buffering causa deriva, deriva causa seek — sem essa trava o player entra
  em loop de correção audível).
- Em `delivery: 'stream'` a posição é **apenas cosmética** (barra de progresso): o áudio chega
  pronto pela rede e não existe deriva possível.

### 5.5 Contrato do motor (`musicEngine.js`) — sem código, só a forma

- **Entrada:** contexto de áudio compartilhado, entrada de fila, callbacks `onEnded`,
  `onDurationKnown`, `onError`.
- **Saída:** um `MediaStreamTrack` de áudio (o que vai para `mesh.setMusicTrack`) e comandos
  `play/pause/seek/stop`.
- **Grafo:** `<audio>` → `MediaElementSource` → `gainTransmissão` → `MediaStreamDestination`
  (rede) **e** → `gainMonitoraçãoLocal` → `destination` (alto-falante do dono).
- **Armadilha obrigatória:** `createMediaElementSource` **desconecta o elemento da saída padrão**.
  Sem o ramo explícito de monitoração local, o dono é o único que **não** ouve a própria música — e
  como todos os outros ouvem, o bug é reportado como "só eu não escuto" e leva horas.
- **Sonda de CORS** (`kind='url'`): antes de tocar, `fetch(url, { headers: { Range: 'bytes=0-0' } })`.
  Sucesso → `crossOrigin = 'anonymous'` (definido **antes** de `src`) e `delivery = 'stream'`.
  Falha → `delivery = 'local'`, anunciado no `music-playback`.
- **`objectURL`** de arquivo local: revogar ao remover a entrada, ao trocar de faixa e no unmount.

---

## 6. Dependências e Ordem de Implementação

1. **`lib/audioContext.js`** + ajuste de injeção em `audioLevels.js`. Fundação; nada mais compila
   direito sem isso. Validar que `client/test/audioLevels.test.mjs` continua verde **sem edição**.
2. **`lib/musicSession.js`** (módulo puro) — **pode rodar em paralelo com (1)**, não depende de nada.
3. **`client/test/musicSession.test.mjs`** — junto com (2); é a validação de convergência antes de
   existir qualquer UI.
4. **`webrtcMesh.js`**: quarto transceiver, `musicStream`, `setMusicTrack`, roteamento `music-*`,
   snapshot no `onopen`. Depende de (2) só para o formato das mensagens. **Aqui há um marco de
   validação:** com nada mais implementado, três participantes devem continuar se conectando
   normalmente (a m-line extra não pode quebrar a negociação existente).
5. **`lib/musicEngine.js`** — depende de (1). Cobre `file` e `url`.
6. **`Room.jsx` + `MusicPanel` + `MusicVoteCard` + `RemoteMusicAudio` + CSS** — depende de (2), (4)
   e (5). Entrega o fluxo completo para arquivo e URL.
7. **`lib/youtubePlayer.js` + integração** — depende de (6). **Deliberadamente por último**: é a
   única parte com dependência de terceiros e com pendência de decisão de produto (§3.4/§7). Se for
   cortada, tudo acima permanece íntegro e entregável.
8. **Validação**: unitários → lint → verificação manual multi-aba → e2e (§9).
9. **Documentação**: `ARCHITECTURE.md` §6.8, `README.md`, `claude-progress.md`.

---

## 7. Riscos e Armadilhas

### Risco: a quarta m-line quebra a classificação de transceivers

- **Risco:** `_classifyTransceiver` identifica os transceivers remotos **por posição** entre os que
  não são nossos. Acrescentar o quarto sem atualizar o array `['audio','camera','screen']` faz o
  áudio de música ser classificado como... nada, e cair no fallback por `track.kind === 'audio'` —
  ou seja, **a música entra no `rec.stream` de voz**. Sintoma: música toca, mas o anel de "falando"
  fica aceso no tile do DJ e o volume da música não pode ser separado da voz. Parece funcionar.
- **Mitigação:** atualizar o array na mesma edição que cria o transceiver, e criar o `musicT`
  **depois** do `screenT` (a ordem das m-lines é a ordem de criação, e é o contrato que as duas
  pontas assumem). Teste explícito: com música tocando, o tile do DJ **não** acende o anel enquanto
  ele está calado.
- **Anti-pattern a evitar:** inserir o transceiver de música antes dos de vídeo "porque é áudio,
  fica perto do mic". Desloca todos os índices e embaralha câmera com tela.

### Risco: mixar música no track do microfone

- **Risco:** é o caminho mais curto e ele *funciona na primeira demo*. Depois: silenciar o mic mata
  a música da sala, o indicador de fala fica permanentemente aceso e ninguém consegue baixar só a
  música.
- **Mitigação:** decisão 3.1, canal dedicado. Se alguém "simplificar" isso depois, o teste de anel
  aceso pega.

### Risco: privacidade — o iframe do YouTube em todos os clients

- **Risco:** `ARCHITECTURE.md` §1 promete zero dependência de terceiros e §5 promete que ninguém
  externo sabe o que acontece na sala. Com YouTube em modo `local`, a Google passa a ver IP,
  cookies e o que está tocando, **para cada participante**. É uma quebra da promessa central do
  produto, escondida atrás de uma funcionalidade divertida.
- **Mitigação:** (a) flag `VITE_ENABLE_YOUTUBE` que remove a origem inteira; (b) aviso explícito e
  não-descartável na UI ao adicionar a primeira faixa de YouTube da sessão, dizendo em uma frase que
  o vídeo é carregado pelo YouTube no navegador de cada participante; (c) registrar a exceção em
  `ARCHITECTURE.md` §6.8 e em §9 (limitações), para não virar uma contradição silenciosa na
  documentação. **Decisão de produto pendente** — implementar com o flag ligado, mas explicitar o
  ponto na entrega.
- **Anti-pattern a evitar:** extrair o stream do YouTube (server-side ou via biblioteca de
  "download") para poder retransmitir. Além de exigir servidor — que o escopo proíbe — viola os
  Termos de Serviço do YouTube.

### Risco: `createMediaElementSource` cross-origin devolve silêncio, sem erro

- **Risco:** URL direta sem cabeçalho CORS produz um grafo "tainted": o `MediaStreamDestination`
  emite **silêncio digital**, sem exceção, sem log. Do lado do dono a música toca (pelo `<audio>`
  original, se ele ainda estiver conectado à saída), e ele jura que está funcionando.
- **Mitigação:** sonda de `Range: bytes=0-0` antes de tocar (§5.5) e queda para `delivery: 'local'`.
  Definir `crossOrigin` **antes** do `src` — depois não tem efeito.
- **Anti-pattern a evitar:** assumir que "carregou = dá para capturar". São permissões diferentes.

### Risco: política de autoplay silencia os ouvintes

- **Risco:** `<audio autoplay>` (remoto) e `AudioContext` suspenso são bloqueados sem gesto do
  usuário. Um participante que entrou e não clicou em nada simplesmente não ouve.
- **Mitigação:** o `resumeOnGesture` do monitor já existe e cobre o contexto; além disso, tratar a
  rejeição de `audio.play()` exibindo um aviso clicável ("Clique para ouvir a música") no painel e
  no card. Nunca engolir a `Promise` rejeitada de `play()`.

### Risco: loop de correção de posição no modo `local`

- **Risco:** seek dispara buffering, buffering aumenta a deriva, a deriva dispara outro seek. O
  resultado é audível: a música "gagueja" a cada poucos segundos, em todos menos no dono.
- **Mitigação:** limiar de 1.5s **e** intervalo mínimo de 5s entre correções (§5.4). Nunca corrigir
  enquanto o player estiver em estado de buffering.

### Risco: divergência de estado entre clients

- **Risco:** dois clients com filas em ordens diferentes, ou um com música ligada e outro não. Numa
  sala pequena isso se manifesta como "não é isso que estou vendo aqui" — o pior tipo de bug para
  reproduzir.
- **Mitigação:** as três regras de convergência (§5.3): ordem total determinística, merge por união
  com tombstones, estado de reprodução com escritor único e versão monotônica. E, principalmente,
  elas moram num módulo **puro** com testes — divergência de fila é a classe de bug mais barata de
  prevenir com teste e mais cara de depurar em produção.
- **Anti-pattern a evitar:** ordenar a fila por `Date.now()` de quem adicionou. Relógios diferentes,
  ordens diferentes, e ninguém desconfia porque "quase sempre" bate.

### Risco: o dono da faixa sai no meio da música

- **Risco:** o áudio simplesmente para e a sala fica travada numa faixa que ninguém pode pular,
  porque o único escritor autorizado sumiu.
- **Mitigação:** regra de sucessão determinística (§3.2 C) no handler de `peer-left`, que **já
  existe** em `Room.jsx`. Faixa `kind='file'` do peer que saiu é pulada com aviso; faixa `local`
  (YouTube/URL) retoma com o novo dono como relógio mestre.
- **Anti-pattern a evitar:** "quem descobrir primeiro assume". Dois assumem, dois publicam, o estado
  oscila.

### Risco: banda do TURN com a sala cheia

- **Risco:** `iceTransportPolicy: 'relay'` obriga todo o tráfego a passar pelo TURN. Música em mesh
  com 6 pessoas é +5 uploads simultâneos no participante que toca, competindo com o vídeo.
- **Mitigação:** `maxBitrate` explícito (§3.3), mono, e `contentHint`. Se a degradação de vídeo for
  perceptível em teste com 6, baixar para 64 kbps antes de considerar qualquer coisa mais elaborada.

### Risco: quebrar seletores dos quais o e2e depende

- **Risco:** `e2e/run.mjs:321` casa `textContent` **exato** com `'Silenciar'`/`'Ativar mic'`;
  `run.mjs:114` casa `'Aprovar'` exato; vários passos contam `.video-tile` e usam
  `.video-grid`/`.controls`/`.chat-panel`; `harness.mjs:212` usa
  `.join-request-modal >> role=button[name="Aprovar"]`.
- **Mitigação:** o botão novo **acrescenta** um item em `.controls` sem alterar o texto de nenhum
  existente; o painel de música usa classes próprias (`.music-panel`, `.music-vote-card`,
  `.music-queue-item`); os `<audio>` ocultos **não** podem ter a classe `video-tile` nem ficar
  dentro de `.video-grid` (a contagem de tiles quebraria em todos os roteiros).
- **Anti-pattern a evitar:** colocar ícone/emoji dentro dos botões existentes "já que estamos
  mexendo na barra". `textContent` vira `'🎵Música'` e a comparação exata de outro botão pode ser
  afetada pela reorganização.

### Risco: o painel de música roubar altura e ressuscitar o scroll de página

- **Risco:** `ARCHITECTURE.md` §6.7 estabelece que a página **nunca** rola. Um painel de player com
  altura de conteúdo (fila crescendo) fura essa invariante.
- **Mitigação:** o `MusicPanel` segue exatamente o modelo do `ChatPanel` — `aside` dentro do palco,
  com a lista da fila em `overflow-y: auto` e `min-height: 0` na cadeia flex. **Chat e música são
  mutuamente exclusivos** (abrir um fecha o outro): dois painéis simultâneos espremem a grade a
  ponto de os tiles baterem no piso de legibilidade.

### Risco: `monitor.close()` matar a música

- **Risco:** hoje `AudioLevelMonitor.close()` fecha o `AudioContext`. Se o motor de música usar esse
  mesmo contexto sem a mudança de posse (§3.8), qualquer refatoração que feche o monitor antes mata
  o áudio da música — e o inverso (dois contextos) impede a conexão dos nós.
- **Mitigação:** decisão 3.8, com a limpeza do `Room` como única dona do `close()`.

---

## 8. Critérios de Aceite Técnicos

**Servidor e invariantes do projeto**

1. `git diff` da entrega não contém nenhuma alteração em `server/`. Nenhum evento Socket.IO novo é
   emitido ou escutado pelo client.
2. Nada é escrito em `localStorage`, `sessionStorage` ou IndexedDB pelo recurso de música. Recarregar
   a página zera fila e player para aquele participante.
3. O arquivo local adicionado por um participante nunca é transferido: nenhum peer recebe bytes do
   arquivo, apenas áudio decodificado no canal de mídia.

**Votação**

4. Com 3 participantes, ao propor música, os outros dois veem um card com contagem regressiva,
   botões Sim/Não e o nome de quem propôs — sem que a tela fique bloqueada (é possível silenciar o
   mic, abrir o chat e clicar em qualquer controle com o card aberto).
5. Com 3 participantes e 2 votos "sim" (incluindo o do proponente), o player é habilitado **em todos
   os três**, e a UI de todos passa a mostrar o botão de abrir o painel.
6. Com 3 participantes e apenas o "sim" do proponente, ao fim do prazo o resultado é reprovado em
   todos os três, e uma nova proposta do mesmo participante nos 2 minutos seguintes é ignorada.
7. Participante sozinho na sala habilita o player sem votação.
8. Se o proponente fechar a aba durante a votação, o card desaparece em todos os demais.
9. Duas propostas disparadas no mesmo instante resultam em **uma** votação ativa, a mesma para
   todos.

**Fila e convergência**

10. Três participantes adicionam uma faixa cada, simultaneamente: os três exibem as três entradas
    **na mesma ordem**.
11. Um participante entra na sala com uma faixa tocando e a fila com 3 entradas: em até ~2s ele
    exibe a mesma fila, a mesma faixa corrente e ouve a música em andamento (não do início).
12. Uma entrada removida por A não reaparece em B após B receber snapshot de C (que não viu a
    remoção).
13. A fila rejeita a 11ª entrada de um mesmo participante e a 101ª entrada da sala, com mensagem na
    UI e sem quebrar o estado.
14. Uma mensagem `music-*` malformada (campo faltando, `kind` desconhecido, `sourceRef` com esquema
    `javascript:`, tipos trocados) é descartada sem lançar exceção e sem alterar o estado.
15. Um `music-vote-cast` cujo payload declare outro `voterId` é contado como voto do **peer da
    conexão**, nunca do id declarado.

**Reprodução**

16. Faixa de arquivo local adicionada por A: B e C ouvem o áudio; o tile de A **não** acende o anel
    de "falando" enquanto A estiver calado; A ouve a própria música.
17. A silencia o microfone durante a reprodução: B e C **continuam ouvindo a música** e param de
    ouvir a voz de A.
18. B aperta pausar numa faixa de A: a reprodução para para todos, e o estado exibido converge em
    todos os três.
19. Volume ajustado por B afeta apenas B.
20. A faixa termina e a próxima da fila começa automaticamente, com a autoridade passando ao dono da
    próxima faixa; se a fila esvaziar, o estado vira "nada tocando" em todos.
21. A (dono, faixa de arquivo local) fecha a aba: a faixa é pulada em B e C com aviso, e a próxima
    começa sem intervenção manual.
22. URL direta com CORS toca em modo `stream`; URL sem CORS cai para modo `local` e **toca mesmo
    assim** em todos — em nenhum dos dois casos o resultado é silêncio.
23. (Se YouTube ativo) Faixa de YouTube toca em todos os clients com desvio de posição inferior a 2s
    entre participantes após 60s de reprodução, sem correções audíveis repetidas.

**Layout e não-regressão**

24. Com o painel de música aberto, `document.documentElement.scrollHeight` não excede
    `window.innerHeight`, e a barra `.controls` permanece inteiramente visível (invariante §6.7).
25. Abrir o painel de música fecha o chat, e vice-versa.
26. `npm run lint` e `npm test` em `client/` passam; `audioLevels.test.mjs` e `gridLayout.test.mjs`
    passam **sem edição**.
27. A suíte e2e existente passa sem alteração dos roteiros atuais: contagem de tiles, indicador de
    fala, compartilhamento de tela (dois simultâneos, incluindo parada pela barra do navegador),
    chat, câmera e saída de participante.

---

## 9. Notas para os Agentes de Implementação

### Divisão sugerida

A demanda é grande, mas tem uma **fronteira limpa** e vale dividir em dois agentes:

- **Agente A — protocolo e mídia:** itens 1, 2, 3, 4 e 5 de §6 (`audioContext.js`,
  `musicSession.js` + testes, `webrtcMesh.js`, `musicEngine.js`). Entrega verificável sem UI: fila
  convergindo em teste unitário e áudio chegando no peer.
- **Agente B — UI e integração:** item 6 (`Room.jsx`, painéis, card, CSS), depois 7 (YouTube), 8 e 9.
  Depende de A; começa a partir do contrato de §5, que já está fechado o suficiente para B escrever
  a UI contra um mock do estado.

Se for um agente só, seguir a ordem de §6 literalmente e **não** começar pela UI: o modelo de estado
é onde estão os erros caros.

### Pitfalls específicos desta demanda (não estão em `ARCHITECTURE.md`)

- **Ordem de criação dos transceivers é contrato de rede**, não estilo. `musicT` depois de `screenT`,
  e o array de `_classifyTransceiver` atualizado na mesma edição.
- **`createMediaElementSource` desconecta o `<audio>` da saída padrão.** Sem o ramo de monitoração
  local, o dono é o único que não ouve.
- **`crossOrigin` tem que ser definido antes de `src`.** Depois não tem efeito, e o grafo vira
  silêncio sem erro.
- **`rec.peerId` é a identidade.** Nada de confiar em `from`/`addedBy`/`voterId` do payload — a
  sanitização de `chat.js` já segue esse espírito (regenera o `id` das mensagens); aqui a diferença
  é que o `id` da **entrada de fila** precisa ser preservado (é a identidade compartilhada da
  entrada) enquanto o **autor** precisa ser sobrescrito.
- **Nunca comparar `Date.now()` entre máquinas.** Toda a sincronização usa `performance.now()` local
  a partir do instante de recepção (§5.4).
- **`RemoteMusicAudio` fica no wrapper comum de overlays**, junto de `<Toasts />` e
  `<JoinRequestModal />`, **antes** dos `return` de fase de `Room.jsx` — pelo mesmo motivo
  documentado lá. Se ele entrar num ramo condicional (por exemplo, dentro do painel), a música
  silencia ao fechar o painel e o bug aparenta ser de rede.
- **`AudioLevelMonitor` não pode monitorar o `musicStream`.** Se monitorar, o anel de fala acende
  com a música — o efeito exato que a decisão 3.1 existe para evitar.
- **Revogar `objectURL`** de arquivo local ao remover a entrada, ao trocar de faixa e no unmount.
- **`z-index`:** toasts 20 < card de votação (sugerido 25) < backdrop do modal de entrada 30 <
  conteúdo do modal 31. Inverter isso faz o clique em "Aprovar" ser interceptado e o e2e falha longe
  da causa.
- **Não tocar em `VideoTile.jsx`, `gridLayout.js` nem nas classes `.video-tile` / `.video-grid` /
  `.controls`.** Todo o e2e se apoia nelas.

### Ordem recomendada de validação

1. `cd client && npm test` — `musicSession` verde antes de qualquer UI; `audioLevels` e `gridLayout`
   verdes **sem edição**.
2. `cd client && npm run lint`.
3. Marco intermediário (após §6 item 4): abrir 3 abas e confirmar que a chamada **existente**
   continua funcionando com a quarta m-line — vídeo, áudio, tela e chat. Se isso quebrar, parar aqui;
   nada adiante importa.
4. Manual, 3 abas: votação (aprovada, reprovada, proponente que sai), arquivo local, URL com e sem
   CORS, mute do dono durante a música, entrada de um quarto participante no meio da faixa, saída do
   dono no meio da faixa.
5. YouTube por último, incluindo vídeo com incorporação bloqueada (o erro precisa virar "faixa
   pulada com aviso", não player travado).
6. Suíte e2e (`node e2e/run.mjs`). Ela precisa das dependências de sistema do Chromium; **se o
   ambiente bloquear a execução, registrar o bloqueio explicitamente em `claude-progress.md` em vez
   de declarar a validação feita** — há precedente disso no projeto.
7. Documentar: `ARCHITECTURE.md` ganha §6.8 (o canal de música, o modelo de estado convergente e a
   exceção do YouTube em §9/limitações), `README.md` ganha o recurso no "Fluxo de uma chamada" e na
   lista "O que fica fora do servidor", e `claude-progress.md` registra o progresso.

### Ponto aberto que precisa de decisão de produto (não bloqueia a implementação)

A origem **YouTube** só é implementável fazendo o navegador de **cada participante** carregar o
player da Google (§3.4), o que contradiz `ARCHITECTURE.md` §1 e enfraquece a promessa de §5. A
recomendação é implementar com `VITE_ENABLE_YOUTUBE` ligado por padrão + aviso explícito na UI, e
levar a decisão de manter ou desligar para o dono do produto **antes do deploy**. Arquivo local e
URL direta não têm esse problema e entregam o recurso completo sem nenhum terceiro envolvido.
