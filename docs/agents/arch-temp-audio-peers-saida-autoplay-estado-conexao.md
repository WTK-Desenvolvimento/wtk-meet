# WTK-MEET-16 — Áudio dos peers: saída de dispositivo, autoplay e estado da conexão por participante

> Gerado em: 2026-08-24
> Status: Rascunho
> Task: WTK-MEET-16 · Branch: `agent/wtk-meet-16-corrigir-a-reprodu-o-do-udio-dos-peers-s`
> Roda **em paralelo** com a task irmã de transporte (TURN/negociação/mesh), em outra worktree.

---

## 1. Contexto e Objetivo [obrigatório]

Uma pessoa entra na sala, a voz dela chega até todo mundo, e ela não ouve ninguém. O tile
aparece normal, sem erro. A assimetria localiza o defeito: se o microfone dela sobe, a
`RTCPeerConnection` fechou, o TURN funcionou e o SDP completou. O que falha é a última
etapa, **do lado de recepção dela** — transformar o áudio recebido em som — e essa etapa é
comum a todos os pares, por isso ela não ouve *ninguém*.

Três defeitos, todos confirmados em código:

1. **A preferência de saída de áudio é aplicada num elemento mudo.** Quando o som dos peers
   saiu do `<video>` do tile e passou para `PeerAudio.jsx` (decisão correta, documentada em
   `PeerAudio.jsx:3-21`), o `setSinkId` **não foi junto**. Ele continua em
   `VideoTile.jsx:62-73`, sobre um `<video muted>` fixo (`VideoTile.jsx:89-95`) — a chamada
   tem sucesso e não produz som nenhum. `PeerAudio.jsx:45` é um `<audio autoPlay />` sem
   sink, e o componente sequer recebe a prop (`Room.jsx:1171` passa só `participants`,
   enquanto `sinkId` vai para o `VideoGrid` em `Room.jsx:1317`).
   Consequência: o seletor "Saída de áudio" do modal **não tem efeito nenhum** sobre a voz
   dos participantes; ela sai sempre pelo default do sistema operacional. Se o default for o
   alto-falante do monitor, uma saída HDMI ou um fone Bluetooth pareado e ocioso, a pessoa
   não ouve ninguém — e o app afirma que está tudo certo.
   Dois agravantes: `handleSinkError` (`Room.jsx:932`), que existe para voltar ao padrão
   quando o deviceId morre, **nunca dispara para o sink que produz som**; e
   `RemoteMusicAudio.jsx:73` tem o mesmo `<audio autoPlay />` sem sink, então a música
   colaborativa também ignora a preferência.

2. **Autoplay sem rede de segurança, ao lado de um que tem.** `RemoteMusicAudio.jsx:55-59`
   chama `element.play()` e converte a rejeição em `onBlocked`, **de propósito** — o
   comentário das linhas 17-20 explica que sem isso "não ouviria, sem nenhum erro visível".
   `PeerAudio.jsx:45` não chama `play()` e não trata rejeição alguma. Existe caminho de
   entrada sem gesto do usuário: recarregar a página com o nome em `sessionStorage` entra
   direto (documentado em `Room.jsx:388-390`). O `resumeAudioContextOnGesture` cobre o
   `AudioContext`, não os `<audio>`. No Chrome costuma passar (permissão de microfone
   concedida dispensa a política); Safari, Firefox e iOS é onde morde — e também quem entra
   com o microfone negado.

3. **O estado da conexão existe e ninguém escuta.** `webrtcMesh.js:178` já dispara
   `this.onPeerStateChange?.(peerId, pc.connectionState)` a cada transição; o callback é
   aceito no construtor (linhas 66 e 80) e **não é passado** pelo `Room.jsx`. Não há uma
   única leitura de `connectionState` fora do mesh. O tile vem da lista do servidor de
   sinalização: é idêntico com a conexão perfeita, em `failed` e nunca estabelecida. Por
   isso todo problema de mídia nesta aplicação tem o mesmo sintoma — "a pessoa aparece, muda
   e parada".

**Comportamento esperado após a entrega:**
- Escolher uma saída de áudio no modal muda por onde sai a voz dos participantes **e** a
  música; um id inválido volta ao padrão do sistema com aviso, pelo caminho que já existe.
- Autoplay bloqueado nunca resulta em silêncio mudo: aparece um aviso clicável, sempre
  visível na sala, e um clique destrava voz e música de uma vez.
- Cada tile remoto expressa o estado da sua conexão. `failed` e `disconnected` são legíveis
  sem abrir o console.

---

## 2. Escopo [obrigatório]

**Dentro do escopo:**
- Extrair o padrão "elemento de mídia audível" (attach de stream + `setSinkId` protegido +
  `play()` com tratamento de rejeição + re-tentativa sob demanda) num único módulo, e aplicá-lo
  em `PeerAudio.jsx` e `RemoteMusicAudio.jsx`.
- Repassar `sinkId` / `onSinkError` do `Room` para os dois componentes de áudio.
- Retirar o `setSinkId` do `VideoTile` (ver Decisão D2) e ajustar a checagem **S9** do E2E,
  que hoje afirma o que não é verdade.
- Aviso clicável de áudio bloqueado, visível na sala (não atrás de painel), que destrava
  voz **e** música num clique.
- Consumir `onPeerStateChange` no `Room`, guardar o estado por participante e exibi-lo no
  tile, via um módulo puro de mapeamento.
- Testes unitários novos em `client/test/` e bloco **U** no E2E.
- Documentação: §6.10 (saída de áudio) e §6.6/§6.5 de `ARCHITECTURE.md`, editando as seções
  existentes; progresso em `docs/progress/WTK-MEET-16.md` (arquivo novo).

**Fora do escopo:**
- **Qualquer reconexão.** Reagir a `failed` com `restartIce` é da task irmã, dentro do
  `webrtcMesh.js`. Aqui só se **observa** o estado.
- Alterar `webrtcMesh.js`, `client/src/config.js` e `server/src/**`.
- Mover o áudio de volta para o `<video>` do tile. A separação é deliberada e correta.
- Trocar a arquitetura de preferências (`lib/devices.js`, chaves de `localStorage`).
- Controle de volume por participante, mudo individual, ou UI de diagnóstico de rede
  (`getStats`, bitrate, RTT). Só o `connectionState`.
- Corrigir o autoplay do `MusicEngine`/YouTube (`lib/useMusicRoom.js`) — o aviso novo
  *reaproveita* `music.unlockAudio`, mas não reescreve aquele fluxo.

---

## 3. Decisões Arquiteturais [obrigatório]

### D1 — Um único módulo "mídia audível", consumido pelos dois componentes

- **Decisão:** criar `client/src/lib/audibleMedia.js`, exportando um hook
  `useAudibleMedia(ref, { stream, sinkId, onSinkError, onBlocked, unlockNonce })` que
  concentra os três efeitos (attach + refresh de tracks, sink, play com rejeição), mais a
  função pura de decisão de sink (ver Contratos). `PeerAudio.jsx` e `RemoteMusicAudio.jsx`
  passam a ser casca fina em volta dele.
- **Motivação:** os dois componentes precisam **exatamente** do mesmo comportamento, e hoje
  cada um tem metade dele — é assim que a metade que falta vira bug em produção. O
  `useMusicRoom.js` já estabelece o precedente de hook em `lib/`. Um arquivo novo também não
  colide no merge com a task irmã, que trabalha em `webrtcMesh.js`/`config.js`.
- **Alternativas descartadas:**
  - *Duplicar o padrão nos dois componentes*: é a causa raiz do defeito 2. Rejeitado
    explicitamente pelas notas da task.
  - *Um componente `<AudibleAudio>` compartilhado*: `RemoteMusicAudio` tem volume/mute e
    `PeerAudio` não; a composição por hook mantém cada componente dono do seu JSX e das suas
    props extras, sem prop drilling de coisas opcionais.
  - *Hook em `components/`*: `lib/` é onde mora lógica testável neste projeto; a parte pura
    do módulo é justamente o que ganha teste sem DOM.

### D2 — O `setSinkId` sai do `VideoTile`

- **Decisão:** remover o efeito de sink e as props `sinkId`/`onSinkError` de
  `VideoTile.jsx` e do repasse em `VideoGrid.jsx`. O roteamento de saída passa a existir só
  onde há som.
- **Motivação:** o `<video>` é `muted` fixo por decisão de arquitetura; a chamada é
  inerte por construção. Pior que inerte: ela é o **único** caminho que hoje alimenta
  `handleSinkError`, e uma rejeição vinda de um elemento que não produz som pode apagar
  (`savePreferences({ audioOutputId: '' })`) uma preferência que funcionaria perfeitamente
  no `<audio>` — um falso positivo que desfaz a escolha do usuário. Manter o código também
  mantém a leitura errada de que o assunto está resolvido, que é exatamente o que produziu
  este bug.
- **Alternativas descartadas:**
  - *Deixar como está e só acrescentar o sink no `PeerAudio`*: diff menor e a checagem S9 do
    E2E continua verde sem tocar em nada. Rejeitado porque preserva o falso positivo do
    `handleSinkError` e deixa código morto com comentário afirmativo — e porque a S9 estaria
    verde afirmando algo falso ("aplicada em todos os elementos de mídia dos tiles"), que é
    o pior estado possível de uma suíte.
  - *Manter a prop e chamar `setSinkId` só quando o elemento não for `muted`*: complexidade
    condicional para um caso que não existe.
- **Custo aceito:** a checagem **S9** de `e2e/run.mjs:987-996` conta `.video-tile video` e
  exige `calls >= tiles`. Ela precisa ser reescrita para contar os elementos que de fato
  roteiam áudio. É a única edição fora do bloco U em arquivo compartilhado do E2E, e é
  pontual (uma checagem, região distante do fim do arquivo, onde a task irmã acrescenta o
  bloco V).

### D3 — Destravamento por *nonce* de estado, não por registro imperativo de elementos

- **Decisão:** o `Room` mantém `audioBlocked` (booleano) e `audioUnlockNonce` (inteiro). O
  aviso clicável chama um `unlockAudio()` que: limpa `audioBlocked`, incrementa o nonce,
  chama `getAudioContext()` e chama `music.unlockAudio()`. O nonce é prop de `PeerAudio` e
  `RemoteMusicAudio`, e entra nas deps do efeito de `play()` do hook — todo elemento montado
  re-tenta tocar. Se a nova tentativa falhar, o `onBlocked` reacende o aviso sozinho.
- **Motivação:** é a solução que não introduz estado imperativo global. Um registro de
  elementos (`registerAudible(el)` num módulo singleton) exige desregistro correto em todo
  desmonte, e um vazamento ali é um elemento morto recebendo `play()` para sempre. O nonce é
  React puro: React já sabe quais elementos estão montados.
- **Alternativas descartadas:**
  - *Registro/`Set` de elementos no módulo*: acoplamento imperativo, risco de vazamento.
  - *`document.querySelectorAll('audio').forEach(play)`*: acha `<audio>` de qualquer origem
    futura e depende do DOM concreto; frágil e invisível para os testes.
  - *Só chamar `play()` no `AudioContext` resume*: não resolve — `AudioContext` e
    `HTMLMediaElement` têm gates de autoplay distintos.

### D4 — Um aviso único para voz e música, fora de qualquer painel

- **Decisão:** o banner de áudio bloqueado é do `Room`, renderizado na mesma região do
  `mediaError` (`Room.jsx:1303`), como `<button>` (não `<div onClick>`). Ele acende tanto
  pelo `onBlocked` do `PeerAudio` quanto pelo do `RemoteMusicAudio` — este último **além**
  de continuar chamando `music.reportBlocked`.
- **Motivação:** o único caminho de destravamento que existe hoje é o botão "Clique para
  ouvir a música" dentro do `MusicPanel` (`MusicPanel.jsx:85-89`), que **só existe com o
  painel aberto**. Quem não abre o painel não tem caminho nenhum. Um aviso único, sempre
  visível, com texto genérico ("o navegador bloqueou o som"), resolve os dois casos e é
  honesto: do ponto de vista do usuário o problema é um só.
- **Alternativas descartadas:**
  - *Dois avisos separados (voz e música)*: dois elementos concorrendo pelo mesmo clique,
    para uma causa idêntica.
  - *Toast*: toasts somem sozinhos (`Toasts.jsx`), e este aviso precisa persistir até o
    clique. Silêncio depois de um toast expirado é o defeito reintroduzido em forma nova.
  - *Modal bloqueante*: sequestra a sala por algo que pode ser um falso positivo do
    navegador.
- **Nota:** o botão do `MusicPanel` **permanece** como está. Ele lê `music.audioBlocked`,
  que não é o estado novo; não há edição em `useMusicRoom.js`.

### D5 — O estado de conexão é traduzido por um módulo puro, e renderizado fora do `.video-label`

- **Decisão:** `client/src/lib/peerConnectionStatus.js`, puro e sem DOM, mapeia
  `RTCPeerConnection.connectionState` → `{ level, label, live }`. O `VideoTile` ganha uma
  prop `connection` e renderiza um elemento próprio, `.tile-connection`, **irmão** de
  `.video-label`, e uma classe modificadora na raiz (`.video-tile.conn-warn` /
  `.conn-bad`).
- **Motivação:** o mapeamento é a única lógica de verdade aqui, e puro ele é testável sem
  navegador — mesmo padrão de `gridLayout.js`, `devices.js` e `musicSession.js`. A separação
  do `.video-label` não é estética: o E2E compara `textContent` de `.video-label` em vários
  roteiros, e enfiar "Sem conexão" ali quebraria checagens de blocos que não são meus.
- **Alternativas descartadas:**
  - *Reusar a prop `badge`*: já é usada por "Tela" e "Em destaque" (`Room.jsx:1131`,
    `SpotlightStage.jsx:130`); um tile de tela em `failed` teria que escolher qual mostrar.
  - *Mapear inline no `Room`*: enterra a única parte testável dentro de um componente de
    1400 linhas.
  - *Mostrar `connectionState` cru no tile*: `new`/`connecting`/`disconnected` não são
    palavras para o usuário final, e o objetivo declarado é uma frase acionável.

### D6 — `connected` não mostra nada; `new`/`connecting` mostram, sem timer

- **Decisão:** `connected` → sem chip. `new`/`connecting` → "Conectando…" (`level: 'warn'`).
  `disconnected` → "Instável" (`warn`). `failed` → "Sem conexão" (`bad`). `closed` →
  "Desconectado" (`bad`). Estado ausente (`undefined`, antes da primeira transição) é
  tratado como `new`. Nada de debounce/grace period.
- **Motivação:** o caminho feliz precisa ser silencioso, senão o chip vira ruído e ninguém
  mais o lê — que é o problema atual em outra forma. "Conectando…" sem timer é informação
  legítima durante a entrada (é exatamente a janela em que o tile hoje mente), e o custo de
  um timer é um caminho de estado a mais que pode ficar preso.
- **Alternativas descartadas:**
  - *Só mostrar `failed`*: `disconnected` é o estado do peer que caiu e ainda não expirou —
    é justo a informação útil nos primeiros segundos de um problema.
  - *Grace period de N segundos para "Conectando…"*: mais estado, mais um caminho para
    testar, ganho cosmético.

### D7 — O tile local nunca tem estado de conexão

- **Decisão:** o item `local` de `people` (`Room.jsx:1053-1063`) não recebe `connection`.
- **Motivação:** não existe `RTCPeerConnection` para si mesmo. Um chip "conectado" no
  próprio tile seria uma afirmação sem fonte.

---

## 4. Componentes Afetados [obrigatório]

### Novos módulos (`client/src/lib/`)

| Arquivo | O que é | Por quê |
|---|---|---|
| `lib/audibleMedia.js` | Hook `useAudibleMedia` + helper puro `shouldApplySink` | D1 — o padrão que hoje existe pela metade em dois lugares |
| `lib/peerConnectionStatus.js` | Função pura `describeConnection(state)` | D5 — a parte testável do defeito 3 |

Arquivos novos: sem risco de conflito de merge com a task irmã.

### Frontend — componentes

| Arquivo | O que muda | Por quê |
|---|---|---|
| `components/PeerAudio.jsx` | Passa a receber `sinkId`, `onSinkError`, `onBlocked`, `unlockNonce`. `PeerAudioElement` delega ao `useAudibleMedia`: attach (comportamento atual, preservado), `setSinkId` protegido e `play()` com rejeição. Atualizar o comentário de topo para dizer que **aqui** mora o roteamento de saída. | Defeitos 1 e 2 |
| `components/RemoteMusicAudio.jsx` | Mesmas props de sink e `unlockNonce`; o `play()`/`onBlocked` atuais migram para o hook (comportamento idêntico), volume/mute continuam no componente. | Defeito 1 (música também ignora a saída) + convergência com D1 |
| `components/VideoTile.jsx` | **Remove** `sinkId`, `onSinkError`, `sinkAppliedRef` e o efeito de sink (linhas 27-28, 31, 53-73). **Adiciona** prop `connection` e renderiza `.tile-connection` (irmão de `.video-label`) + classe modificadora na raiz. Atualizar o comentário das linhas 11-14 para apontar que o sink saiu junto com o som. | D2, D5 |
| `components/VideoGrid.jsx` | Deixa de aceitar/repassar `sinkId` e `onSinkError`; passa `connection={tile.connection}` para o `VideoTile`. | D2, D5 |
| `components/ThumbnailRail.jsx` | Repassa `connection={item.connection}` (uma linha, em `ThumbnailRail.jsx:65-75`). | Sem isso o estado some ao entrar no modo destaque — o modo em que a sala fica quando alguém compartilha tela |
| `components/SpotlightStage.jsx` | Repassa `connection={spotlight.connection}` (uma linha, `SpotlightStage.jsx:126-131`). | idem |
| `styles.css` | Regras de `.tile-connection` e dos modificadores `.conn-warn` / `.conn-bad`; nada para o banner além de reusar `.warning` se couber. | Visibilidade sem console |

> `ThumbnailRail.jsx` e `SpotlightStage.jsx` não estão na lista de arquivos da task, mas
> também não estão na lista de proibidos: são camada de UI, a task irmã é transporte. A
> edição é de uma linha em cada. Se o time preferir manter a fronteira ao pé da letra,
> corte estes dois — mas registre no progresso que o estado da conexão fica invisível no
> modo destaque, porque isso é uma regressão parcial do objetivo.

### Frontend — `pages/Room.jsx`

| Trecho | O que muda | Por quê |
|---|---|---|
| Estado (perto de `Room.jsx:96-115`) | `audioBlocked` (bool) e `audioUnlockNonce` (int) | D3, D4 |
| Construção do mesh (`Room.jsx:452`+) | Passar `onPeerStateChange: (peerId, state) => …` gravando `connectionState` no registro do participante, com guarda `if (!prev.has(peerId)) return prev` e no-op quando o valor não muda | Defeito 3 |
| Comentário do mapa (`Room.jsx:95`) | Documentar o campo novo: `peerId -> { displayName, stream, screenStream, cameraOff, micOff, connectionState }` | O comentário é o contrato desse `Map` |
| `handleSinkError` (`Room.jsx:932-938`) | Sem mudança de código. Vale conferir a idempotência: a primeira chamada limpa a preferência, as seguintes caem no `return` da linha 935 — o que importa agora que **N** elementos podem rejeitar a mesma escolha | Um device morto não pode gerar N toasts |
| `unlockAudio` (novo `useCallback`) | Limpa `audioBlocked`, incrementa o nonce, chama `getAudioContext()` e `music.unlockAudio()` | D3, D4 |
| `people` (`Room.jsx:1050-1081`) | Cada item remoto ganha `connection: describeConnection(info.connectionState)`; o item local não | D5, D7 |
| `screens` (`Room.jsx:1090-1123`) | Cada tela remota ganha o mesmo `connection` do dono | Uma tela congelada por conexão morta precisa dizer isso |
| `overlays` (`Room.jsx:1171` e `1182-1186`) | `<PeerAudio>` recebe `sinkId={preferences.audioOutputId}`, `onSinkError={handleSinkError}`, `onBlocked`, `unlockNonce`; `<RemoteMusicAudio>` recebe sink/nonce e um `onBlocked` que chama `music.reportBlocked()` **e** acende o banner | Defeitos 1 e 2 |
| Render in-call (`Room.jsx:1303`) | Banner clicável logo abaixo do `mediaError` | D4 |
| `VideoGrid` (`Room.jsx:1313-1319`) | Remove `sinkId`/`onSinkError` | D2 |

### Testes

| Arquivo | O que cobre |
|---|---|
| `client/test/peerConnectionStatus.test.mjs` (novo) | Os seis estados + ausente; `connected` não produz chip; nenhum rótulo vaza `connectionState` cru |
| `client/test/audibleMedia.test.mjs` (novo) | Sink: não chama sem preferência e sem aplicação prévia; chama com `''` depois de ter aplicado; não chama onde `setSinkId` não existe; rejeição → `onSinkError`. Play: rejeição → `onBlocked`; `play()` sem Promise não quebra; mudança de nonce re-tenta; desmonte não chama `onBlocked` depois |
| `client/test/peerAudioSink.test.mjs` (novo) | O componente (ou o hook sobre um duplo de elemento) aplica sink e play por peer; nenhum elemento fica `muted` |
| `e2e/run.mjs` bloco **U** | Ver §5 e §8 |
| `e2e/run.mjs` **S9** | Reescrita (D2) |
| `e2e/harness.mjs` | `__wtkForcePeerState` e `__wtkBlockAutoplay` (ver §5) |

### Documentação

- `ARCHITECTURE.md` **§6.10**, parágrafo "A saída de áudio é aplicada por elemento de mídia,
  com `HTMLMediaElement.setSinkId` em cada tile" (linhas ~554-559): está **factualmente
  errado** depois desta entrega (e já estava, na prática). Reescrever para: o sink é
  aplicado nos elementos que produzem som — os `<audio>` de `PeerAudio.jsx` e
  `RemoteMusicAudio.jsx` — e nunca nos `<video>` dos tiles, que são `muted` por construção.
- `ARCHITECTURE.md` **§6.5 (Presença)** ou **§6.6**: acrescentar, *dentro da seção
  existente*, o parágrafo sobre estado de conexão por participante e sobre a fronteira "aqui
  se observa, a reação a `failed` é do mesh".
- `README.md`: só se houver seção de solução de problemas de áudio; editar a existente.
- `docs/progress/WTK-MEET-16.md` (**novo**). **Não** escrever em `claude-progress.md`.

---

## 5. Contratos de Interface

Nenhum endpoint REST, nenhum evento de sinalização, nenhum campo de banco. Esta entrega é
inteiramente cliente. Os contratos relevantes são de módulo e de componente.

### `lib/peerConnectionStatus.js`

| Export | Assinatura | Contrato |
|---|---|---|
| `describeConnection` | `(state?: string) => {level, label, live} \| null` | `'connected'` → `null` (sem chip). `undefined`/`'new'`/`'connecting'` → `{level:'warn', label:'Conectando…', live:'polite'}`. `'disconnected'` → `{level:'warn', label:'Instável', live:'polite'}`. `'failed'` → `{level:'bad', label:'Sem conexão', live:'assertive'}`. `'closed'` → `{level:'bad', label:'Desconectado', live:'polite'}`. Valor desconhecido → mesmo tratamento de `new`. Função pura, sem DOM, sem i18n dinâmico. |

### `lib/audibleMedia.js`

| Export | Assinatura | Contrato |
|---|---|---|
| `shouldApplySink` | `({sinkId, applied, hasSetSinkId}) => boolean` | `false` se `hasSetSinkId` for falso. `false` se `sinkId` vazio **e** `applied` falso (evita uma chamada inútil por elemento a cada montagem — é a regra que já existe em `VideoTile.jsx:65-67`). `true` nos demais casos. Pura. |
| `useAudibleMedia` | `(ref, {stream, sinkId, onSinkError, onBlocked, unlockNonce}) => void` | Três efeitos, nesta ordem de declaração: **(1)** `srcObject = stream \|\| null` + listeners `addtrack`/`removetrack` que reatribuem (comportamento atual dos dois componentes, preservado); **(2)** sink, guardado por `shouldApplySink`, com `.catch(err => onSinkError?.(err))` — **nenhuma promise rejeitada escapa**; **(3)** `Promise.resolve(el.play()).catch(() => !cancelled && onBlockedRef.current?.())`, com deps `[stream, unlockNonce]`. Callbacks passam por refs internos (o `Room` recria a identidade a cada render, e reatribuir `srcObject` reiniciaria a reprodução — regra já registrada em `RemoteMusicAudio.jsx:43-46`). |

### Props de componentes (novas ou removidas)

| Componente | Prop | Tipo | Direção |
|---|---|---|---|
| `PeerAudio` | `sinkId` | `string` | nova |
| `PeerAudio` | `onSinkError` | `(err) => void` | nova |
| `PeerAudio` | `onBlocked` | `() => void` | nova |
| `PeerAudio` | `unlockNonce` | `number` | nova |
| `RemoteMusicAudio` | `sinkId`, `onSinkError`, `unlockNonce` | idem | novas (`onBlocked` já existe) |
| `VideoTile` | `sinkId`, `onSinkError` | — | **removidas** |
| `VideoTile` | `connection` | `{level,label,live} \| null` | nova |
| `VideoGrid` | `sinkId`, `onSinkError` | — | **removidas** |
| `ThumbnailRail` / `SpotlightStage` | `connection` (repasse por item) | — | novas |

### Estado por participante (`Room.jsx`)

| Campo | Tipo | Origem | Observações |
|---|---|---|---|
| `connectionState` | `string \| undefined` | `mesh.onPeerStateChange` | Só é gravado para peer já presente no `Map` (`join-approved` e `peer-joined` inserem o registro **antes** de `mesh.addPeer` — `Room.jsx:551` e `Room.jsx:560-566`). Update no-op quando o valor não muda. |

### Instrumentação do E2E (`e2e/harness.mjs`)

| Hook | Contrato |
|---|---|
| `pc.__wtkForceState(state)` | Definido dentro do wrapper de `RTCPeerConnection` já existente (`harness.mjs:590-600`). Redefine `connectionState` na instância via `Object.defineProperty(..., {configurable: true})` e dispara `new Event('connectionstatechange')` — o mesh usa `pc.onconnectionstatechange =`, então o handler real roda. Sem isso não há como forçar `failed` de forma determinística sem tocar em `webrtcMesh.js`/`config.js`, que são da task irmã. |
| `window.__wtkBlockAutoplay` | Flag lida por um wrapper de `HTMLMediaElement.prototype.play` que rejeita com `NotAllowedError` enquanto estiver ligada. |

---

## 6. Dependências e Ordem de Implementação [obrigatório]

1. **`lib/peerConnectionStatus.js`** — puro, sem dependências. Pode rodar em paralelo com 2.
2. **`lib/audibleMedia.js`** — puro + hook, sem dependências. Paralelo com 1.
3. **Testes unitários de 1 e 2** — escrever aqui, antes dos componentes. É onde a lógica
   está, e é o que fica verde sem navegador.
4. **`PeerAudio.jsx` e `RemoteMusicAudio.jsx`** — dependem de 2. Ao migrar o
   `RemoteMusicAudio`, o comportamento observável tem que ficar **idêntico** ao atual (é a
   referência que já funciona).
5. **`VideoTile.jsx` + `VideoGrid.jsx`** — remoção do sink e prop `connection`. Depende de
   1. Independente de 4.
6. **`ThumbnailRail.jsx` + `SpotlightStage.jsx`** — repasse. Depende de 5.
7. **`Room.jsx`** — depende de 4, 5 e 6. Nesta ordem interna, cada passo verificável
   sozinho:
   a. repassar `sinkId`/`onSinkError` para os dois componentes de áudio e remover do
      `VideoGrid` (fecha o defeito 1);
   b. `audioBlocked` + `audioUnlockNonce` + `unlockAudio` + banner (fecha o defeito 2);
   c. `onPeerStateChange` + `connection` em `people`/`screens` (fecha o defeito 3).
8. **`styles.css`** — `.tile-connection` e modificadores. Depende de 5.
9. **E2E**: primeiro os hooks do `harness.mjs`, depois a reescrita da **S9**, depois o bloco
   **U**. A S9 vem antes do U de propósito: ela é a checagem que a mudança quebra, e deixar
   para o fim é como suíte vermelha vira "provavelmente é flaky".
10. **Documentação** (§6.10, §6.5/6.6, `docs/progress/WTK-MEET-16.md`) — por último, com o
    comportamento já verificado.

Paralelizável: (1,2,3) com nada; (4) com (5+6); (9) só depois de (7).

---

## 7. Riscos e Armadilhas [obrigatório]

### R1 — A checagem S9 do E2E quebra por construção
- **Risco:** `e2e/run.mjs:987-996` conta `.video-tile video` e exige `calls >= tiles`. Sem o
  sink no `VideoTile`, `calls` (agora só os `<audio>` dos peers, 2 na cena da Alice) fica
  abaixo de `tiles` (3, com o local). A suíte fica vermelha e o motivo parece um bug.
- **Mitigação:** reescrever a S9 **na mesma entrega**, mantendo o nome do bloco e afirmando
  o que passou a ser verdade: `setSinkId('spk-b')` foi chamado com `tag === 'AUDIO'` pelo
  menos uma vez por peer remoto, e **nenhuma** chamada veio de `tag === 'VIDEO'`. Essa
  segunda metade é o que impede a regressão de voltar.
- **Anti-pattern:** afrouxar a S9 para `calls > 0`. Passaria com a música sozinha e com o
  defeito inteiro de volta.

### R2 — `handleSinkError` disparando N vezes
- **Risco:** com sink em N elementos, um deviceId morto rejeita N promises: N toasts, N
  `setMediaError`, e — pior — a preferência limpa depois de já ter sido limpa.
- **Mitigação:** o `return` de `Room.jsx:935` já cobre (`if (!preferencesRef.current.audioOutputId) return`),
  porque a primeira chamada zera a preferência. Confirmar isso em teste; **não** acrescentar
  debounce por timer.
- **Anti-pattern:** engolir o erro do segundo elemento em diante com um flag global "já
  avisei" que nunca é resetado — a próxima escolha inválida ficaria silenciosa.

### R3 — Reatribuir `srcObject` corta o áudio
- **Risco:** o efeito de play depender de callbacks que mudam de identidade a cada render do
  `Room` faria o efeito re-rodar; se o efeito de attach for unificado com ele, o
  `srcObject` é reatribuído e a reprodução reinicia. É exatamente o bug que
  `RemoteMusicAudio.jsx:43-46` documenta.
- **Mitigação:** callbacks sempre por ref; efeitos separados; deps do play limitadas a
  `[stream, unlockNonce]`; no attach, manter o `if (element.srcObject !== stream)`.
- **Anti-pattern:** um único `useEffect` com `[stream, sinkId, onBlocked, onSinkError]` nas
  deps. Parece mais simples e corta o som a cada render.

### R4 — Ordem entre `setSinkId` e `play()`
- **Risco:** em alguns navegadores `setSinkId` só se comporta com o elemento já com fonte;
  invertido, a troca de saída pode não pegar até a próxima reprodução.
- **Mitigação:** ordem de declaração dos efeitos = attach → sink → play. React roda efeitos
  na ordem de declaração dentro do mesmo componente.
- **Anti-pattern:** encadear `setSinkId().then(() => play())` — acopla o destravamento de
  autoplay ao sucesso do sink, e no Firefox (sem `setSinkId`) o `play()` nunca aconteceria.

### R5 — `setSinkId` ausente no Firefox
- **Risco:** `TypeError` dentro do efeito, quebrando a montagem do componente de áudio —
  isto é, silêncio total, o defeito amplificado.
- **Mitigação:** guarda `typeof el.setSinkId === 'function'`, como `VideoTile.jsx:64` já faz,
  agora dentro de `shouldApplySink` e coberta por teste.

### R6 — O aviso de bloqueio vira falso positivo permanente
- **Risco:** `play()` também rejeita com `AbortError` quando o elemento é pausado/trocado no
  meio da chamada — não é autoplay bloqueado. Um banner que acende nesse caso e não some
  treina o usuário a ignorá-lo.
- **Mitigação:** o `unlockAudio` limpa o estado antes de re-tentar; se a re-tentativa der
  certo, o banner não volta. Não filtrar por `err.name`: `NotAllowedError` é o caso comum
  mas não é garantido em todos os navegadores, e um falso positivo que some ao clicar custa
  menos que um falso negativo silencioso — que é o defeito original.
- **Anti-pattern:** manter o banner aceso "até o próximo reload".

### R7 — `onPeerStateChange` ressuscitando um peer removido
- **Risco:** `mesh.removePeer` fecha a `RTCPeerConnection`; qualquer transição posterior
  gravada com `next.set(peerId, ...)` recriaria um tile fantasma sem nome nem stream.
- **Mitigação:** guarda `if (!prev.has(peerId)) return prev`, como `onRemoteScreen`
  (`Room.jsx:474-481`) já faz. Seguro porque o registro é inserido **antes** de `addPeer` nos
  dois caminhos de entrada.
- **Anti-pattern:** copiar o `next.get(peerId) || {}` de `onRemoteStream`, que é permissivo
  de propósito para o stream e errado aqui.

### R8 — Render storm por transição de estado
- **Risco:** `connectionstatechange` pode disparar várias vezes com o mesmo valor; cada
  `setParticipants` com `Map` novo re-renderiza a grade inteira e remonta nada, mas custa.
- **Mitigação:** no-op quando `prev.get(peerId).connectionState === state` (devolver `prev`).
- **Anti-pattern:** `useMemo` na grade com deps que não incluem o campo novo — o chip
  simplesmente não atualizaria.

### R9 — Fronteira com a task irmã
- **Risco:** ao ver `failed` no tile, a tentação é "consertar" no `webrtcMesh.js`.
- **Mitigação:** proibido. Se parecer necessário, **pare e registre** em
  `docs/progress/WTK-MEET-16.md`. `webrtcMesh.js:181-187` já tem um `restartIce` no
  `iceconnectionstatechange`; qualquer evolução disso é da outra task.
- **Anti-pattern:** "só um `if` pequeno no mesh".

### R10 — Conflito de merge em `e2e/harness.mjs`
- **Risco:** a task irmã provavelmente também mexe no harness (é onde vive a instrumentação
  de transporte).
- **Mitigação:** manter as duas adições pequenas e coladas ao wrapper existente de
  `RTCPeerConnection` (`harness.mjs:590-600`) e ao de `setSinkId` (`harness.mjs:711-717`),
  sem reorganizar o arquivo. Bloco **U** no E2E (a outra usa **V**), progresso em arquivo
  próprio, nada em `claude-progress.md`.

### R11 — O chip quebrando roteiros do E2E que não são meus
- **Risco:** vários blocos contam `.video-tile` e leem `.video-label`. Um elemento novo
  dentro do label, ou uma mudança de estrutura, quebra checagens alheias.
- **Mitigação:** `.tile-connection` é **irmão** de `.video-label`, com classe própria; a
  contagem de `.video-tile` não muda; nenhum texto novo entra em `.video-label`.
- **Anti-pattern:** renderizar o estado como sufixo do nome ("Fulano — sem conexão").

### R12 — `display: contents` no container dos sinks
- **Risco:** `.peer-audio-sinks { display: contents }` (`styles.css:513`) existe justamente
  para o elemento continuar sendo mídia ativa. Aplicar `display:none` ou remover o elemento
  do fluxo ao mexer no componente mata o áudio de novo.
- **Mitigação:** não tocar nessa regra. `RemoteMusicAudio` usa `display: none`
  (`styles.css:907`) e funciona porque `<audio>` sem `controls` não tem caixa — mas não é
  motivo para uniformizar agora.

---

## 8. Critérios de Aceite Técnicos [obrigatório]

**Saída de áudio (defeito 1)**
1. Com uma saída escolhida no modal, `setSinkId` é chamado com aquele id em **todos** os
   `<audio>` de peers montados e em todos os `<audio>` de música — e em **nenhum** `<video>`.
2. Um peer que entra depois da escolha nasce com o sink já aplicado, sem nova interação.
3. Voltar para "Padrão do sistema" (`''`) chama `setSinkId('')` nos elementos que já haviam
   recebido um sink, e **não** chama em elementos que nunca receberam nenhum.
4. Um `deviceId` que deixou de existir faz a preferência voltar ao padrão e mostra o aviso —
   **uma vez**, não uma vez por elemento.
5. Onde `setSinkId` não existe, nada é chamado, nenhum erro é lançado e o áudio toca
   normalmente.

**Autoplay (defeito 2)**
6. Entrando na sala **sem nenhum gesto** (reload com nome em `sessionStorage`) e com o
   navegador rejeitando `play()`, aparece um aviso clicável na sala — fora de qualquer
   painel, sem depender do painel de música estar aberto.
7. Clicar no aviso re-tenta a reprodução de **todos** os elementos de áudio montados (voz e
   música) e, dando certo, o aviso some.
8. Se a re-tentativa falhar de novo, o aviso volta a aparecer.
9. Nenhuma rejeição de `play()` ou de `setSinkId` chega ao console como
   `unhandledrejection` — a checagem G do E2E trata isso como falha.

**Estado da conexão (defeito 3)**
10. Com o mesh saudável (todos os peers em `connected`), nenhum tile exibe indicador de
    conexão.
11. Uma transição para `failed` numa conexão faz **um** tile — o daquele peer — exibir "Sem
    conexão", sem recarregar a página e sem abrir o console. Voltando para `connected`, o
    indicador some.
12. `disconnected` exibe "Instável"; `new`/`connecting` exibem "Conectando…".
13. O tile local nunca exibe indicador de conexão.
14. O indicador aparece também no modo destaque (tile em destaque e miniaturas).
15. A contagem de `.video-tile` e o `textContent` de `.video-label` são idênticos aos de
    antes desta entrega.

**Não-regressão**
16. Entrar e sair do modo destaque continua **não** cortando o áudio dos peers (o elemento
    de áudio não muda de pai).
17. A música colaborativa continua tocando com volume/mute locais funcionando, e o botão
    "Clique para ouvir a música" do painel continua existindo e funcionando.
18. Nenhuma alteração em `client/src/lib/webrtcMesh.js`, `client/src/config.js` ou
    `server/src/**` (verificável por `git diff --name-only`).

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida** (um agente de desenvolvimento dá conta; se houver dois, esta é a linha
de corte sem sobreposição de arquivos):
- **Agente A** — módulos novos (`lib/audibleMedia.js`, `lib/peerConnectionStatus.js`), seus
  testes, `PeerAudio.jsx`, `RemoteMusicAudio.jsx`.
- **Agente B** — `VideoTile.jsx`, `VideoGrid.jsx`, `ThumbnailRail.jsx`,
  `SpotlightStage.jsx`, `styles.css`.
- **Integração (sequencial, depois de A e B)** — `Room.jsx`, E2E, documentação.

**Pitfalls específicos desta demanda, que não estão na documentação geral:**
- O `<video>` do tile é `muted` **fixo**. Não existe cenário em que ele produza som; se a
  implementação parecer precisar de sink lá, a conclusão está errada.
- `RemoteMusicAudio.jsx` é a **referência correta** deste padrão. Ao migrá-lo para o hook, o
  objetivo é preservar comportamento, não melhorá-lo. Qualquer diferença observável ali é
  regressão.
- O botão "Clique para ouvir a música" do `MusicPanel` lê `music.audioBlocked`, que é estado
  do `useMusicRoom.js` — **arquivo que esta task não edita**. O banner novo é estado do
  `Room`. Dois estados, um clique: o `unlockAudio` do `Room` chama `music.unlockAudio()`
  junto.
- Antes da primeira escrita em arquivo, rodar `ListAgents` — já houve duas sessões na mesma
  worktree neste projeto.
- Antes de rodar os testes, `npm install` em `client/` **e** `server/`; sem isso a suíte
  aparece vermelha por `node_modules` ausente, e isso não é linha de base.

**Ordem de validação após implementar:**
1. `npm test` no `client/` — os testes novos e os 3 já existentes que tocam tiles/áudio.
2. Lint (depende do `npm install` acima).
3. E2E: bloco **S** (a S9 reescrita precisa passar), depois o bloco **U** novo, depois a
   suíte inteira. A F4a é falha **pré-existente**; não é desta entrega.
4. `git diff --name-only` conferindo o critério 18 antes de abrir o PR.
5. Escrever `docs/progress/WTK-MEET-16.md` critério a critério (§8), com o resultado real de
   cada um — inclusive o que ficou de fora e por quê.

**Registrar no progresso, obrigatoriamente:**
- Que a **S9** do E2E foi reescrita, com o texto antigo e o novo, e por quê (D2/R1).
- Que `e2e/harness.mjs` ganhou `__wtkForcePeerState` e `__wtkBlockAutoplay`, e que é o único
  jeito de cobrir `failed` e autoplay bloqueado sem tocar nos arquivos da task irmã.
- Se `ThumbnailRail.jsx`/`SpotlightStage.jsx` tiverem sido deixados de fora, que o estado da
  conexão fica invisível no modo destaque.
- Qualquer ponto em que o `webrtcMesh.js` tenha parecido precisar de mudança — **sem
  mudá-lo**.
