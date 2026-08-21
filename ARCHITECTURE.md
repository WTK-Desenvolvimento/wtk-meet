# wtk-meet — Arquitetura

Videochamadas em grupo (até 6 pessoas), mesh P2P via WebRTC, com camada extra de E2EE
client-side e zero persistência de **conteúdo e metadado de chamada** — a única
exceção é a preferência de dispositivos de mídia, delimitada e justificada em §6.8.
Documento mantido por Winston (Arquiteto).

## 1. Objetivos e restrições

- Até 6 participantes por sala.
- Mídia nunca passa por um servidor de aplicação — apenas P2P (mesh) com fallback de
  relay via TURN self-hosted quando NAT/firewall impede conexão direta.
- Nenhuma persistência de conteúdo ou metadado de chamada: sem banco de dados, sem
  gravação de chamadas, sem logs de conteúdo. O processo de sinalização mantém estado
  apenas em memória, por sala, e o descarta quando a sala esvazia ou o servidor
  reinicia. A **única** coisa gravada no navegador é qual câmera/microfone/saída a
  pessoa escolheu usar (§6.8) — não é conteúdo, não é identidade, e nunca sai da aba.
- Entrar numa sala exige aprovação explícita de alguém que já está presente
  (sem "salas abertas" por padrão).
- Nenhuma dependência de infraestrutura de terceiros: sinalização própria (Node.js) e
  STUN/TURN próprio (coturn), sem Google STUN público, sem SFU de terceiros, sem
  provedores de nuvem para mídia.

## 2. Por que mesh, não SFU

Um SFU (Selective Forwarding Unit) escala melhor para salas grandes, mas introduz um
componente de infraestrutura que processa (ou ao menos encaminha) fluxos de mídia de
todos — um alvo único de comprometimento e um ponto que precisaria ser confiável para
não ler os fluxos, mesmo que criptografados hop-by-hop. Para o requisito de "privacidade
total" com um teto duro de 6 participantes, mesh P2P é a escolha correta:

- Trade-off aceito: cada participante mantém N-1 conexões (com N=6, até 5 conexões
  simultâneas, 15 no total na sala) e sobe upload de vídeo N-1 vezes. Em 6 pessoas isso
  é tolerável; não escalaria para 20+.
- Ganho: nenhum componente de servidor jamais tem acesso a mídia decodificável. O único
  papel do backend é trocar metadados de sinalização (quem quer entrar, SDP/ICE).

Se no futuro a sala precisar crescer além de ~6-8 pessoas, a arquitetura correta muda
para SFU — mas isso é decisão para quando o requisito mudar, não uma abstração a
construir agora (YAGNI).

## 3. Por que uma camada extra de E2EE além do DTLS-SRTP do próprio WebRTC

WebRTC já criptografa mídia em trânsito com DTLS-SRTP entre os dois peers de cada
conexão. Em mesh puro isso já é "fim a fim" no sentido estrito (não há servidor de
mídia no meio). Duas razões justificam uma camada adicional de criptografia aplicada
ao payload do frame (Insertable Streams / Encoded Transform), replicando o padrão usado
pelo Google Meet e Zoom para "E2EE":

1. **TURN relay como intermediário de transporte.** Quando a conexão direta falha (NAT
   simétrico, firewalls restritivos) o tráfego SRTP passa pelo coturn self-hosted. O
   coturn não decodifica SRTP, mas é um componente de infraestrutura adicional no
   caminho — a camada extra garante que, mesmo que esse relay seja comprometido, o
   conteúdo do frame continua ilegível sem a chave de sala.
2. **Servidor de sinalização como vetor de MITM.** Se o servidor de sinalização for
   comprometido, ele pode adulterar SDP/ICE e tentar se inserir como man-in-the-middle
   na negociação DTLS. A chave de E2EE nunca trafega pelo servidor de sinalização (ver
   §5), então mesmo um servidor de sinalização hostil não decripta os frames.

### Mecanismo

- Cada sala tem uma **passphrase aleatória de 128 bits**, gerada no client ao criar a
  sala e transportada apenas no **fragmento da URL** (`#chave`, após o `#`).
  Fragmentos de URL não são enviados ao servidor em requisições HTTP nem em eventos de
  Socket.IO — é o mesmo princípio usado por ferramentas como Firefox Send. O servidor
  de sinalização, portanto, nunca vê a chave, mesmo em trânsito.
- Cada participante deriva localmente uma chave AES-GCM-256 via PBKDF2
  (`passphrase + roomId` como salt, 250k iterações, SHA-256). Desde a WTK-MEET-10 o
  `roomId` é o **path canônico da sala** (`daily`, `k7m2xq9tp`), já normalizado pelo
  client antes de qualquer uso — se um participante entrasse por `/Daily` e outro por
  `/daily`, o salt divergiria e as chaves não bateriam.
- **O tamanho do endereço não entra na conta da segurança.** O endereço encurtou de um
  UUID de 36 caracteres para um slug de 9 (ou um nome escolhido), e isso não enfraquece
  nada: a entropia que protege a mídia é a da passphrase de 128 bits, não a do path. O
  path sempre foi conhecido do servidor — é a chave do `Map` de salas — e nunca fez
  parte do segredo. Ele é salt, e salt não precisa ser secreto; precisa ser único por
  sala, que é o que a canonicalização garante.
- Usando a API **Insertable Streams / Encoded Transform** do WebRTC
  (`RTCRtpSender.createEncodedStreams()` / `RTCRtpReceiver.createEncodedStreams()`),
  cada frame de áudio/vídeo já codificado é criptografado com AES-GCM (IV aleatório de
  96 bits por frame, prefixado ao ciphertext) antes de sair pela conexão, e decriptado
  do lado receptor antes da decodificação.
- **Limitação conhecida:** Insertable Streams tem suporte consistente em navegadores
  baseados em Chromium (Chrome, Edge, Opera). Firefox e Safari têm suporte parcial ou
  ausente dependendo da versão. O client detecta suporte (`isInsertableStreamsSupported`)
  e exibe aviso claro quando a camada extra de E2EE não pode ser aplicada — a chamada
  continua funcionando protegida apenas por DTLS-SRTP padrão, mas o usuário é informado
  para poder decidir.

## 4. Fluxo de aprovação de entrada

1. Criador gera `roomId` + `passphrase` no client, sem chamar o servidor, e compartilha
   o link `https://.../:roomId#passphrase` por um canal à parte (mensagem, etc.) — o
   servidor nunca vê a passphrase. O `roomId` é um slug base32 de 9 caracteres sem
   caracteres ambíguos (`0123456789abcdefghjkmnpqrstvwxyz`) ou um endereço escolhido
   por quem cria (`uma-sala-so-minha`, até 64 caracteres em `[a-z0-9-]`). O prefixo
   `/room/` não existe mais: a sala mora na **raiz**, num segmento só, e as telas da
   aplicação vivem sob `/app/*`. Reservados — nunca viram sala — são `app`, `room`,
   `api`, `health`, `turn-credentials` e os paths servidos pelo nginx antes do SPA
   (`assets`, `static`, `public`, `favicon-ico`, `robots-txt`, `index-html`, …); a lista
   inteira está em `client/src/lib/roomRouting.js`. Links no formato antigo
   (`/room/:id#chave`) redirecionam com `replace`, preservando o fragmento.
2. Ao abrir o link, o client conecta ao Socket.IO e emite `join-request { roomId,
   displayName }`.
3. Se a sala não existe (primeiro a entrar), o próprio requisitante é admitido
   automaticamente — ele está criando a sala.
4. Se a sala já tem participantes, o servidor retransmite `join-request` para todos os
   sockets já presentes. Qualquer um deles pode `approve-join` ou `deny-join`. Nenhuma
   política de "host único" é necessária: qualquer pessoa já presente pode aprovar,
   reforçando que o controle de acesso é do grupo, não de uma conta.
5. Sala cheia (6 membros) rejeita novos pedidos com `join-denied { reason: 'room-full' }`
   sem nem notificar os presentes.
6. Após aprovação, o servidor entrega ao novo membro a lista de participantes atuais
   (id + nome, nada de mídia) e avisa os já presentes via `peer-joined`. Só então começa
   a negociação WebRTC (mesh) entre o novo peer e cada peer existente.
7. Um pedido que **deixa de ser aprovável** é retratado com `join-request-cancelled
   { requesterId }`, emitido aos membros da sala. Isso acontece quando o requisitante
   desiste (fecha a aba / cai), quando outro participante já negou, ou quando a sala
   encheu no meio do caminho.

O passo 7 é o único evento que esta camada acrescentou ao protocolo, e ele existe por
causa da forma da UI: como o pedido é um **modal** na tela de todo mundo (§6.7), um
pedido morto que continuasse na tela seria um botão que não faz nada — e, pior, faria
parecer que a sala ignora quem está esperando. `approve-join`/`deny-join` já são
idempotentes no servidor (`pendingJoins` é a fonte de verdade), então a retratação é
só o aviso; ela não afeta a decisão de acesso em si. O evento carrega apenas um
`requesterId`, que já é público dentro da sala — nenhum nome, nenhum conteúdo.

## 5. O que o servidor de sinalização sabe (e o que ele nunca sabe)

| Sabe | Nunca sabe |
|---|---|
| Que um `roomId` existe e quantos sockets estão nele (contagem efêmera em memória) | A chave/passphrase de E2EE (fica no fragmento da URL, nunca enviado ao servidor) |
| Nomes de exibição escolhidos pelos participantes | Conteúdo de áudio/vídeo (nunca trafega por ele — mesh P2P) |
| SDP/ICE candidates (metadados de rede: codecs, IPs candidatas) | O conteúdo dos frames de mídia, mesmo que decidisse inspecionar SRTP (E2EE adicional torna isso inútil) |
| Que houve troca de SDP (portanto, que *algo* mudou na negociação) | O conteúdo das mensagens de chat — trafega por `RTCDataChannel` P2P, e não existe nenhum evento de chat no protocolo do servidor (§6.3) |
| — | Quem está falando: os níveis de áudio são medidos localmente por cada participante e nunca saem da máquina (§6.4) |
| — | Se alguém está compartilhando tela ou com a câmera desligada — esse estado é anunciado pelo data channel, não pelo servidor |
| — | Que a sala está ouvindo música, o que está na fila ou quem votou o quê — o player inteiro vive nos clients (§6.8). A exceção é a origem YouTube: ali quem sabe é a Google, não este servidor |

Nada disso é persistido: ao encerrar a sala (todos saem) ou reiniciar o processo, o
estado desaparece. Não há banco de dados no backend.

Duas mudanças da WTK-MEET-10 mexem nesta tabela e merecem estar escritas:

- O `roomId` deixou de ser um UUID opaco. Onde o servidor via
  `3f2b7c1e-9a41-4d0b-8e77-2c5b9d1a4f60`, ele pode agora ver `sala-do-suporte` — um nome
  escolhido por gente, que carrega sentido. Nada mudou no que ele *guarda* (chave de um
  `Map` em memória, apagada quando a sala esvazia); mudou o que esse valor *revela* nos
  logs de quem operar o servidor.
- Existe um endpoint novo, `GET /rooms/:roomId/occupancy`, que responde
  `{ occupied: boolean }` — se há algum socket na sala agora. Ele alimenta o aviso de
  "já existe gente nessa sala" na Home (item do DoD da WTK-MEET-10) e **contraria** a
  posição do documento de arquitetura daquela entrega, que pedia para nenhum endpoint
  de existência de sala ser criado: com endereços curtos e adivinháveis, um booleano
  varrido sobre uma lista de nomes prováveis diz quais times estão reunidos agora. A
  resposta foi reduzida ao mínimo (sem contagem, sem nomes) e o recurso vive num commit
  isolado, revertível sozinho — a decisão de mantê-lo é de produto, não de
  implementação.

## 6. Experiência de chamada: tela, chat, indicador de fala e presença

Quatro mecanismos foram acrescentados sobre o mesh sem mudar nenhuma das
restrições acima — em particular, **nada em §6.1–§6.6 adiciona um único evento novo
ao servidor de sinalização**. A única exceção no projeto inteiro é o
`join-request-cancelled` do fluxo de aprovação (§4, passo 7), que é metadado de
sala e não de mídia; §6.7 descreve por que a UI o exige.

### 6.1 Layout de transceivers e renegociação

Cada `RTCPeerConnection` nasce com três transceivers `sendonly`, sempre na mesma
ordem: **áudio (mic), vídeo (câmera), vídeo (tela)**. O sentido inverso vem de
três transceivers `recvonly` que o navegador cria ao aplicar a oferta do outro
lado.

Por que não um único par bidirecional por finalidade: a especificação WebRTC só
associa uma m-line remota a um transceiver local pré-existente quando ele foi
criado por `addTrack()`. Transceivers criados por `addTransceiver()` — que é o
que precisamos, já que o canal de tela existe antes de haver qualquer track de
tela — nunca são pareados implicitamente. Aceitar o layout unidirecional (3+3)
é mais barato do que sincronizar quem cria o quê, e mantém a identificação do
que chega totalmente determinística: os transceivers que criamos são
reconhecidos por identidade de objeto; os do outro lado chegam na ordem das
m-lines, que é a ordem em que ele os criou.

A consequência prática é a que interessa: **ligar/desligar câmera e entrar/sair
de compartilhamento de tela são `replaceTrack()` num sender que já existe**.
Não há SDP novo, não há renegociação, e o áudio não é tocado.

Ainda assim a renegociação existe e precisa ser correta — a negociação inicial é
simétrica (os dois lados disparam `onnegotiationneeded`) e uma queda de rede
dispara `restartIce()`. O client implementa **perfect negotiation** completo,
com o papel `polite`/`impolite` decidido por comparação lexicográfica dos socket
ids (`selfId < peerId`): determinístico, oposto nas duas pontas por construção,
sem sorteio e sem round-trip extra. Em colisão de ofertas, o `impolite` ignora a
oferta que chegou e o `polite` faz rollback implícito.

### 6.2 Compartilhamento de tela

Usa o terceiro transceiver, com uma track dedicada de `getDisplayMedia()` — ela
coexiste com a câmera, não a substitui, e por isso o participante que compartilha
continua aparecendo na grade. A track recebe `contentHint = 'detail'` para que a
degradação sob banda apertada preserve nitidez em vez de framerate (texto legível
importa mais que fluidez numa tela compartilhada).

Sair do compartilhamento tem dois gatilhos — o botão da UI e o "Parar
compartilhamento" da barra do navegador — e ambos caem no mesmo caminho, via o
evento `ended` da track.

### 6.3 Chat via `RTCDataChannel`

O chat trafega exclusivamente P2P, por um `RTCDataChannel` por conexão do mesh.
O canal é **negociado fora de banda** (`negotiated: true, id: 0`): os dois lados
o criam com o mesmo id, então não há `ondatachannel` nem corrida sobre quem cria.
Como ele existe antes da primeira oferta, a m-line `application` já entra na
negociação inicial.

Nenhum evento de chat existe no servidor Socket.IO — os únicos eventos são os de
sinalização (§4). O conteúdo herda a criptografia DTLS do próprio data channel,
igual à mídia.

O mesmo canal carrega o **estado do peer** (câmera desligada, mic mudo, tela
ligada). Isso é deliberado: inferir "câmera desligada" de `track.muted` no
receptor levaria segundos no Chromium, enquanto o anúncio pelo data channel é
imediato — e continua sendo P2P.

**Histórico é efêmero por construção.** As mensagens vivem apenas no estado do
React: **o chat** não usa `localStorage`, `sessionStorage`, IndexedDB nem servidor.
Recarregar a página ou sair da sala apaga a conversa por completo. Quem entra
depois não recebe o que foi dito antes — não existe backlog para entregar.

Mensagens vindas de um peer são sanitizadas na chegada (tipos, tamanhos, e o
`id` é regerado localmente, para um participante não conseguir colidir com o id
de outro e sobrescrever uma linha da conversa).

### 6.4 Indicador de fala: política de medição local

O anel azul de "está falando" é **derivado, não transmitido**. Cada participante
mede localmente, com `AudioContext` + `AnalyserNode`, o próprio stream e os
streams remotos que já está recebendo de qualquer forma. Nenhuma mensagem de
nível de áudio existe — nem no servidor de sinalização, nem no data channel.

Custo controlado: **um** `AudioContext` para a sala inteira e **um** loop
`requestAnimationFrame` percorrendo todos os analisadores, em vez de um timer
por tile.

Histerese: acende no primeiro frame acima do limiar (~16ms na prática, bem
abaixo do teto de 200ms) e só apaga após 500ms contínuos abaixo dele — sem isso
o anel pisca nas pausas naturais entre palavras. Os limites estão fixados em
testes unitários (`client/test/audioLevels.test.mjs`) com relógio e analisador
controlados.

Nota de precisão: o SDP negocia a extensão de cabeçalho RTP `ssrc-audio-level`,
que é padrão do WebRTC em qualquer aplicação. Ela viaja dentro do SRTP entre os
peers, não alimenta este indicador, e não é algo que a aplicação escolha enviar.

### 6.5 Presença

Entrada e saída disparam um toast efêmero (~4s) com o nome e um bipe curto,
sintetizado no mesmo `AudioContext` (sem arquivo de mídia). Os avisos sonoros
podem ser silenciados na própria UI, sem silenciar os toasts.

Nenhum evento novo foi preciso: `peer-joined` e `peer-left` já existiam. O
`peer-left` só carrega o id, e o nome é resolvido no mapa local de participantes
antes da remoção.

### 6.6 Ciclo de vida dos recursos

Ao sair da sala, tudo é liberado: tracks de câmera, microfone e tela são parados
com `track.stop()` (é o que apaga o LED da webcam — `enabled = false` não apaga,
porque o device continua aberto), o `AudioContext` é fechado, o loop de
`requestAnimationFrame` é cancelado, e data channels e `RTCPeerConnection` são
fechados. O mesmo vale para "desligar câmera": o track é encerrado de verdade e
substituído por `null` nos senders, em vez de apenas desabilitado.

### 6.7 Layout da sala: viewport fixo e grade calculada

A sala é um shell de **altura fixa igual à do viewport**, em três faixas: topo
compacto (banner de erro de mídia), palco elástico e rodapé de controles. A página
**nunca rola** — `document.documentElement.scrollHeight` não excede
`window.innerHeight` em nenhuma contagem de participantes.

A altura é declarada como `height: 100vh` seguida de `height: 100dvh`. A segunda
vence onde é suportada, e é ela que importa em celular: `100vh` mede o viewport
**sem** a barra de endereço retrátil, o que colocaria o rodapé debaixo dela — o
mesmo bug de "controle inalcançável", só que em outro dispositivo. Degradação
graciosa pura, sem `@supports` e sem JS.

**A grade é calculada em JS, não por CSS.** O tamanho ótimo do tile depende ao
mesmo tempo da largura, da altura e da contagem, e CSS não expressa "escolha o
número de colunas que maximiza o tile sujeito a caber na altura": `auto-fit`/
`minmax` só enxerga a largura. Era exatamente essa a causa do layout anterior, em
que um participante único produzia um tile do tamanho da largura da tela e
empurrava os controles para fora.

- `client/src/lib/gridLayout.js` é um módulo **puro, sem DOM**: recebe
  `{ width, height, count, aspect, gap, minTileWidth }` e devolve
  `{ cols, rows, tileWidth, tileHeight, overflow }`. Faz uma busca sobre o número
  de colunas e escolhe a que maximiza o tile; empate desempata pelo **menor**
  número de colunas, senão a grade oscila entre configurações equivalentes a cada
  pixel de resize. Arredonda para baixo — arredondar para cima produz a linha
  extra de estouro que este desenho existe para eliminar.
- `client/src/components/VideoGrid.jsx` mede o palco com `ResizeObserver` e
  escreve o resultado como custom properties (`--grid-cols`, `--tile-w`,
  `--grid-gap`). Os tiles não recebem estilo inline.
- O elemento medido (`.video-stage`) é dimensionado **pelo pai**, e a grade dentro
  dele é `position: absolute`. É isso que impede o clássico `ResizeObserver loop`:
  o conteúdo não tem como empurrar a caixa que está sendo medida. A medição também
  só vira `setState` quando as dimensões **inteiras** mudam — comparar float faria
  o subpixel de scrollbar/zoom oscilar para sempre.

Num palco de desktop em paisagem a regra produz 1→1×1, 2→2×1, 3–4→2×2, 5–6→3×2,
7–9→3×3, 10–12→4×3; em palco estreito ou achatado ela reorganiza sozinha (2 tiles
em retrato viram 1×2). A aritmética está fixada em `client/test/gridLayout.test.mjs`.

Todo tile é **16:9 com letterbox** (`object-fit: contain` sobre fundo escuro). 16:9
é a proporção nativa da maioria das webcams e das telas compartilhadas. O trade-off
aceito é a barra lateral em câmeras 4:3 — preferível a `cover`, que cortaria rosto,
e a `fill`, que deformaria.

**Escape de estouro:** o cálculo respeita um piso de legibilidade
(`MIN_TILE_WIDTH`, 120px). Quando nem no menor tile legível o conjunto cabe, quem
rola é o **container da grade** (`.video-grid.overflowing`), nunca a página — a
invariante que interessa é que os controles e o modal continuem alcançáveis.

**Pedidos de entrada são um modal** (`JoinRequestModal.jsx`), montado junto dos
toasts num wrapper comum **antes** dos `return` de fase do `Room` — "aparece sobre
qualquer estado da tela" só é garantido se a renderização não estiver presa a um
ramo. Ele lista todos os pedidos pendentes (um por linha), tem `role="dialog"` +
`aria-modal`, move o foco para o primeiro "Aprovar" e o devolve ao fechar. **Não
fecha por `Esc` nem por clique no backdrop**, de propósito: um fechamento acidental
deixaria alguém esperando indefinidamente. As duas tentativas recebem uma resposta
explícita em vez de silêncio. O backdrop fica em `z-index` 30 e o conteúdo em 31,
acima dos toasts (20) — se esse empilhamento inverter, o clique em "Aprovar" é
interceptado e ninguém entra na sala.

### 6.8 Destaque de compartilhamento de tela (80/20)

A grade uniforme de §6.7 resolve "a sala cabe na tela"; ela não resolve "o que
importa aparece maior". Com 3 participantes e 1 tela compartilhada, o palco vira
2×2 e o slide recebe o mesmo retângulo de uma cabeça falante. São problemas
diferentes, e a solução do segundo é **hierarquia visual**.

**Ativação automática, reversão automática.** Basta uma tela ativa — local ou
remota — para o palco trocar de `VideoGrid` para `SpotlightStage`, sem nenhuma
ação do usuário; quando a última tela termina, a grade volta. Em `Room.jsx` os
tiles viraram duas listas derivadas: `people` (câmeras) e `screens` (telas
ativas, a sua primeiro e depois as remotas na ordem de chegada). `screenStream`
nulo é "sem tela", não "tela vazia" — o peer anuncia `screenOn: false` e o mesh
chama `onRemoteScreen(peerId, null)`.

**A escolha do destaque é local e derivada, sem nada na rede.** Com duas ou mais
telas, cada participante clica na miniatura para escolher qual vê em destaque, e
isso não muda a tela de mais ninguém: a preferência vive num `useState`
(`pinnedScreenId`) e o destaque **efetivo** é derivado a cada render por
`resolveSpotlightScreen` — se a escolhida ainda está ativa ela vence, senão vence
a primeira da lista. Nenhum evento novo no Socket.IO e nenhum `type` novo no data
channel; a tabela de §5 continua verdadeira sem alteração. Derivar em vez de
"corrigir" com um `useEffect` elimina a classe inteira de bugs de sincronização:
`pinnedScreenId` pode apontar para uma tela que já acabou à vontade, porque nunca
é lido sem validação, e uma segunda tela entrando não sobrescreve a escolha
deliberada de quem já escolheu.

**A geometria é calculada em JS**, pela mesma razão da grade:
`client/src/lib/spotlightLayout.js` é puro e sem DOM. O "80/20" é um **alvo com
trava** — a coluna fica em `clamp(RAIL_MIN_WIDTH, 20%, RAIL_MAX_WIDTH)` (160–280px),
porque em ultrawide 20% viram uma miniatura desperdiçada e num laptop com o chat
aberto viram 110px ilegíveis. O destaque recebe o resto, em 16:9 e reduzido para
caber na altura: `flex: 4 / flex: 1` entrega a proporção mas estoura
verticalmente numa janela achatada, ressuscitando o scroll que §6.7 eliminou. A
miniatura tem piso de legibilidade (`MIN_THUMB_WIDTH`), e quando 20% ficariam
abaixo dele quem engorda é a coluna, não o contrário.

**O modo estreito é decidido pela caixa medida, não por media query.** Abaixo de
`NARROW_STAGE_WIDTH` (720px de **palco**, não de viewport) o destaque vai a
largura cheia e a coluna vira um painel sob demanda, sobreposto ao destaque. O
palco encolhe quando o chat abre — uma media query de viewport diria "desktop"
com 400px reais de palco. O painel fecha por `Esc`, por clique fora e pelo próprio
botão: a regra oposta do modal de aprovação (§6.7) existe porque lá outra pessoa
depende da decisão, e aqui não depende ninguém.

**A coluna é um grupo de escolha acessível.** Cada tela é um `<button>` com
`aria-pressed` e rótulo "Ver a tela de Fulano em destaque" — teclado e leitor de
tela saem de graça, sem `tabindex`/`role`/handlers de Enter manuais. A tela que
está em destaque continua listada, marcada como pressionada e **sem stream** (o
tile cai no placeholder): renderizar a mesma imagem em dois `<video>` dobraria o
custo de decodificação, e manter o botão no lugar preserva o foco ao trocar de
destaque. Miniaturas de câmera não são clicáveis nem focáveis (fixar câmera está
fora de escopo).

**Ordem da coluna.** Sobem ao topo, nesta ordem: telas não destacadas, quem está
falando, quem está compartilhando, você, e o resto na ordem de chegada; dentro de
cada faixa a ordem de origem é preservada. Reordenar debaixo da mão de quem está
rolando a coluna moveria o item que a pessoa está olhando, então fora do topo a
ordem **congela** (`orderRailItems({ frozen })`) e as novidades entram no fim.
Quem rola é sempre a coluna — nunca o destaque, nunca a página.

**O áudio saiu do tile** (`components/PeerAudio.jsx`). Entrar e sair do destaque
move o tile de container na árvore React, e mover um elemento entre pais o
desmonta e remonta — o que cortaria o som do peer a cada início de
compartilhamento e a cada troca de destaque. Todos os `<video>` são `muted` e o
som sai de um `<audio>` por participante, montado uma única vez fora do palco.
Separar transporte de áudio de posicionamento de vídeo torna qualquer rearranjo
futuro de layout gratuito.

A aritmética, o fallback e a ordenação estão fixados em
`client/test/spotlightLayout.test.mjs`; o comportamento no navegador, no cenário C
de `e2e/run.mjs`.

### 6.9 Player de música colaborativo

A sala tem um player estilo Spotify com fila colaborativa: qualquer participante
adiciona faixas (arquivo local, URL direta de áudio ou link do YouTube) e a sala
ouve junto. **Nenhuma rota, evento ou estado novo no servidor** — fila, faixa
corrente, posição e votos vivem nos clients e trafegam pelo mesmo
`RTCDataChannel` do chat, com um snapshot enviado a quem entra depois.

**Ligar o player é votado; pular e remover, não.** Um botão "Música" abre uma
votação da sala (30s, árbitro, maioria dos votos válidos com quórum de metade do
eleitorado). Aprovada, o player fica habilitado até a sala esvaziar. Já pular a
faixa corrente ou remover uma entrada é livre, com a autoria visível — votar cada
pulo transformaria cada música ruim numa cerimônia de meio minuto, e o recurso
morreria de fricção. A votação existe onde o custo é alto e coletivo: **ligar**.
O card é **não-bloqueante** (`z-index` 25, entre os toasts e o modal de entrada) e
fecha por `Esc`/clique fora sem votar — abster-se é legítimo, ao contrário do
pedido de entrada, onde ignorar deixa alguém preso do lado de fora.

**Quarto transceiver, não mixagem no microfone.** Cada `RTCPeerConnection` passa
a nascer com **quatro** `sendonly`, na ordem **áudio (mic), vídeo (câmera), vídeo
(tela), áudio (música)**. Mixar a música no track do mic é o caminho mais curto e
funciona na primeira demo; depois, `toggleMute` (que faz `enabled = false` no
track do mic) silenciaria a música **para a sala inteira**, o indicador de fala
(§6.4) ficaria permanentemente aceso no tile de quem toca, e ninguém conseguiria
baixar a música sem baixar a voz junto. O canal separado ainda recebe
`contentHint = 'music'` e `maxBitrate` de 96 kbps — com `iceTransportPolicy:
'relay'`, quem toca sobe N−1 cópias pelo TURN, e sem teto o Opus disputaria banda
com o vídeo exatamente na sala cheia. A ordem de criação é **contrato de rede**:
o array de `_classifyTransceiver` precisa ser estendido na mesma edição, senão a
música cai no stream de voz e o bug *parece* funcionar.

**Duas formas de entrega, escolhidas pela origem.** `delivery: 'stream'` é o
áudio retransmitido pela máquina de quem adicionou a faixa; `delivery: 'local'` é
cada client tocando a mesma origem, sincronizado por posição.

| Origem | Entrega | Por quê |
|---|---|---|
| Arquivo local | `stream` | Única possibilidade: ninguém mais tem o arquivo. O arquivo **nunca** é transferido — o que trafega é áudio decodificado, como som. |
| URL direta | `stream` com CORS, `local` sem | `createMediaElementSource` sobre mídia cross-origin sem `Access-Control-Allow-Origin` transmite **silêncio digital**, sem erro. Daí a sonda de `Range: bytes=0-0` antes de tocar, e daí o padrão ser `local` quando a sonda não confirma. |
| YouTube | `local`, obrigatoriamente | O player roda num iframe cross-origin; não existe API que dê acesso ao áudio dele. Extrair o stream violaria os Termos de Serviço e exigiria servidor; capturar a aba levaria junto a voz dos participantes. |

**Convergência sem servidor, sem relógio comum e sem eleição.** Cada pedaço do
estado tem uma regra que converge sozinha (`client/src/lib/musicSession.js`, puro
e coberto por `client/test/musicSession.test.mjs`):

- **Fila:** conjunto append-only com tombstones. Ordem total por
  `(lamport, addedBy, id)` — nunca por relógio de parede, que daria ordens
  diferentes em máquinas diferentes sem ninguém desconfiar. Merge de snapshot é
  **união** menos tombstones: substituir a fila local apagaria adições recentes, e
  sem tombstone o snapshot de quem não viu a remoção **ressuscita** a entrada.
- **Reprodução:** escritor único, o dono da faixa corrente, com `version`
  monotônico. Quem não é dono manda um **pedido** (`music-command`); o dono aplica
  e publica. Autoridade fica alinhada com capacidade física — o áudio nasce na
  máquina dele. Trocar de faixa é publicado pelo dono da **próxima**, nunca pelo
  da que acabou: um escritor por transição.
- **Sucessão:** quando o dono cai, todos aplicam a mesma regra (o presente de
  menor id, o mesmo critério do polite/impolite) e exatamente um publica. Faixa de
  **arquivo** de quem saiu é pulada com aviso; URL e YouTube continuam.
- **Posição:** o dono republica a cada 5s; o receptor estima com
  `performance.now()` **local** a partir do instante de recepção. Relógios de
  máquinas diferentes nunca são comparados. Correção só acima de 1.5s de desvio e
  no máximo uma a cada 5s — sem essa trava, seek causa buffering, buffering causa
  deriva e o player gagueja em loop. Esse tique é heartbeat **de posição**: ele
  repete a intenção corrente da sala em `playing` e nunca a infere do transporte
  do player (`planPositionHeartbeat`). Um getter `playing` responde "está soando
  neste milissegundo?" — falso durante buffering, com autoplay bloqueado e antes
  do primeiro frame —, e usá-lo aqui transformava um engasgo de rede do dono numa
  pausa autoritativa que ninguém pedia e ninguém desfazia. Play/pause têm
  publicadores próprios e síncronos; o heartbeat só ecoava.

**Identidade é a conexão.** O autor de qualquer mensagem `music-*` é o peer do
data channel em que ela chegou; nenhum `addedBy`/`voterId` do payload é aceito
como identidade — aceitar permitiria votar ou comandar em nome de outro. A
exceção é o `id` da entrada de fila, que é **preservado** (é a identidade
compartilhada da entrada, ao contrário do `id` de mensagem de chat, que é
regerado).

**Volume é sempre local** e nunca trafega: volume compartilhado é uma guerra de
cliques, e mais um campo para convergir sem nenhum ganho.

**Um `AudioContext` só, e ele é do `Room`.** Nós de contextos diferentes não podem
ser conectados, então o grafo da música precisa do mesmo contexto do indicador de
fala. O dono passou a ser o `Room` (`lib/audioContext.js`): enquanto era o
`AudioLevelMonitor`, um `monitor.close()` mataria a música em silêncio.

### 6.10 Seleção de dispositivos de mídia

Um modal único de configurações (`components/SettingsModal.jsx`), alcançável em três
pontos — Home, tela de espera/conexão e barra de controles da sala — escolhe **entrada
de vídeo, entrada de áudio e saída de áudio**, com preview ao vivo e medidor de nível
do microfone. Antes desta entrega o app chamava `getUserMedia({ video: true, audio:
true })` sem restrição: quem usa webcam ou headset USB ficava preso ao hardware
embutido, e a única saída era trocar o default no sistema operacional e recarregar.

**Exceção nomeada e delimitada à regra de zero persistência.** As preferências
(`videoInputId`, `audioInputId`, `audioOutputId`, `soundsEnabled`) são gravadas em
`localStorage`, sob a chave `wtk-meet:devices`. Elas não são conteúdo nem metadado de
chamada: nunca são enviadas ao servidor de sinalização nem trafegam pelo data channel,
não dizem com quem se falou nem quando, e um `deviceId` é escopado à origem e ao
perfil do navegador (rotaciona quando os dados do site são limpos). A alternativa —
reescolher o headset a cada chamada — é um custo real e recorrente, cobrado justamente
de quem investiu em hardware melhor. `sessionStorage` (usado para o nome de exibição)
não serve: ele morre ao fechar a aba. A supressão de ruído (§6.11) acrescenta uma
**segunda chave**, `wtk-meet:audio`, deliberadamente fora desta — o porquê está em
§6.11. **Nada além dessas duas chaves ganha persistência**; o histórico de chat
continua estritamente em memória (§6.3).

A lógica vive em `client/src/lib/devices.js`, um módulo **puro, sem DOM** — mesmo
padrão de `gridLayout.js`. Ele recebe a lista crua de `enumerateDevices` e um objeto
storage-like e devolve estruturas; quem faz I/O é o componente. Isso é o que torna
dedup, rotulagem e fallback verificáveis em `client/test/devices.test.mjs`, sem
navegador.

Quatro decisões carregam o resto:

- **`deviceId: { ideal }`, nunca `{ exact }`.** Com `exact`, um device que sumiu entre
  o `enumerateDevices` e o `getUserMedia` provoca `OverconstrainedError`, que a
  aplicação teria que capturar, interpretar e reexecutar. Com `ideal` o navegador
  entrega o melhor disponível, `track.getSettings().deviceId` diz qual foi, e a
  preferência é **reconciliada** com esse valor. Uma preferência que aponta para
  hardware de outra máquina se conserta sozinha, sem nenhuma mensagem de erro na
  entrada da sala — ninguém pode agir sobre esse aviso no momento em que está
  entrando numa chamada. A reconciliação só corrige um id que foi *pedido e não
  atendido*: um id vazio ("Padrão do sistema") nunca é fixado no device do momento.
- **A lista é normalizada.** Entradas sem `deviceId` (que é o que `enumerateDevices`
  devolve antes da permissão) são descartadas, assim como os aliases reservados do
  Chrome `default` e `communications` — sem isso o mesmo microfone aparece três vezes,
  e salvar `'default'` seria uma armadilha: o id nunca fica inválido, então o fallback
  nunca dispara, mas o hardware por trás dele muda sem aviso. A dedup é por
  `deviceId` e, como segunda barreira, por `(groupId, label)` — nunca só por rótulo,
  que colapsaria duas webcams idênticas em uma.
- **Preview primeiro, enumeração depois.** É o `getUserMedia` do preview que concede a
  permissão; sem ela os rótulos vêm vazios. O preview usa um medidor de nível
  **isolado** (`createLevelMeter`), fora do registro do `AudioLevelMonitor` da sala:
  o `retainOnly` do `Room` detacha qualquer id que não seja um peer, então um preview
  registrado lá morreria na próxima entrada ou saída de alguém. O medidor reusa o
  `AudioContext` da sala — a invariante de um contexto por aba (§6.4) continua valendo.
- **Trocar de device em chamada é `replaceTrack`, não renegociação.** A troca reusa
  `setCameraTrack`/`setAudioTrack` do mesh (§6.1): nenhum SDP novo, nenhum
  `setLocalDescription`. Duas regras não óbvias: o track novo nasce com
  `enabled = true`, então trocar de microfone estando mudo **desmutaria a pessoa** se
  o `enabled = !muted` não viesse *antes* do `replaceTrack`; e trocar de câmera com a
  câmera desligada apenas grava a preferência — reacender o LED da webcam para aplicar
  algo que ninguém pediu não é aceitável, e a escolha passa a valer no próximo "Ativar
  câmera".

A saída de áudio é aplicada por elemento de mídia, com `HTMLMediaElement.setSinkId`
em cada tile. Onde a API não existe (Firefox por padrão), o seletor aparece
**desabilitado com explicação** em vez de escondido — esconder faz quem viu o recurso
em outro navegador procurar o que não está lá. Toda chamada é embrulhada em `catch`:
uma rejeição não tratada dentro de um efeito viraria `unhandledrejection`.

Quando um device em uso é arrancado, o navegador encerra o track e **não** migra
sozinho: o `ended` do track local dispara a recuperação (volta ao padrão do sistema,
readquire o microfone e avisa na tela). Com o modal aberto, `devicechange` só
reenumera — reiniciar o preview a cada evento faria a câmera piscar, já que um único
headset USB dispara vários eventos seguidos. O E2E simula múltiplos dispositivos no
harness (o Chromium expõe uma câmera e um microfone falsos e não há flag para um
segundo), no bloco `S` de `e2e/run.mjs`.

### 6.11 Supressão de ruído

O mesmo modal traz um toggle **Supressão de ruído**, ligado por padrão. Antes desta
entrega o microfone ia cru para o mesh: `buildConstraints` só montava `deviceId:
{ ideal }`, e ventilador, teclado e obra do vizinho iam junto com a voz.

**O motor é híbrido e a escolha é do navegador, não da pessoa.** Onde
`getSupportedConstraints().noiseSuppression` existe (Chrome, Edge, Firefox, Safari
recentes), a supressão é a **nativa** — mais barata, mais testada, e não custa um
`AudioWorklet`. Onde não existe, entra um `AudioWorklet` próprio
(`lib/noiseSuppressorWorklet.js`). Onde não há nenhum dos dois, o toggle aparece
**desabilitado com explicação**, mesmo princípio do seletor de saída de áudio (§6.10).
A precedência do nativo não é preferência de gosto: é ela que torna impossível
empilhar as duas supressões em série, combinação que produz bombeamento e voz
metálica — pior que nenhuma. A matriz inteira vive em `decideMode`
(`lib/noiseSuppression.js`), módulo **puro**, verificável sem navegador.

**O toggle desligado é uma constraint explícita, não a ausência dela.** É a decisão
menos óbvia da entrega: os navegadores ligam `noiseSuppression` por padrão quando se
pede `audio: true` sem qualificar. Omitir a constraint no estado desligado entregaria
um toggle que não desliga nada — e sem erro nenhum, com a queixa chegando semanas
depois como "o toggle não faz nada". Por isso `noiseConstraints` emite
`{ ideal: <valor> }` **nos dois estados**. `ideal` e nunca `exact`: com `exact`, um
navegador sem a constraint responde `OverconstrainedError` e derruba a aquisição
inteira — a pessoa entraria na sala **sem áudio** por causa de uma preferência de
qualidade.

**Chave de storage própria.** A preferência é gravada sob `wtk-meet:audio`, separada
de `wtk-meet:devices`. As duas respondem perguntas diferentes: `wtk-meet:devices` diz
*que hardware usar* — ids que só valem na máquina em que foram gravados, e que a
reconciliação reescreve sozinha quando o hardware some (§6.10). Supressão de ruído não
é escolha de hardware: é propriedade do **ambiente** de quem fala, vale para qualquer
microfone e nunca deve ser reescrita por reconciliação. Juntas, a autocorreção de
device passaria por cima de um campo que ela não deveria nem enxergar. Continua valendo
o limite de §6.10: nada além dessas duas chaves ganha persistência.

**No modo worklet, o track do mesh não é o track do `getUserMedia`.** O pipeline tem
dono explícito (`lib/micPipeline.js`, único arquivo da feature que encosta em
`AudioContext`): o track cru entra no grafo, o processado sai por um
`MediaStreamAudioDestinationNode`, e é **o processado** que vai para os senders, para
o `localStreamRef` e para o medidor de fala — os três, sempre o mesmo objeto, senão o
anel de fala local acende para um áudio que ninguém recebe. O track **cru** continua
sendo a referência para o `ended` (recuperação de microfone arrancado) e para a
reconciliação de preferência, que precisam do dispositivo real, não do destino
sintético. O `AudioContext` é o mesmo da sala — a invariante de um por aba (§6.4)
continua valendo — e por isso o pipeline **não** o fecha ao parar.

**Alternar em chamada é `replaceTrack`, nunca renegociação**, exatamente como a troca
de device (§6.10): o pipeline mantém cru e processado vivos e alternar é escolher qual
vai para os senders. Nenhum SDP novo, nenhum `negotiationneeded`, nenhum peer muda de
`connectionState`. E aqui vale a mesma regra não óbvia de lá: o `enabled = !muted` vem
**antes** do `replaceTrack`, senão alternar a supressão estando mudo desmutaria a
pessoa.

**O algoritmo** é uma porta espectral tipo Wiener sobre STFT (janela de 512, salto de
128, Hann, overlap-add com ganho unitário), com piso de ruído adaptativo assimétrico —
sobe devagar, desce rápido, que é o que distingue ruído estacionário de fala. Com
`enabled: false` o caminho é identidade exata, não aproximada. Medido em `node:test`:
ruído branco cai 13,5 dB, um tom em nível de fala perde 0,45 dB, e o RMS de fala
simulada continua acima de `SPEAKING_ON` — supressão que mata o anel de fala seria
regressão, não melhoria.

**Nada disso sai da máquina.** Nenhum evento de sinalização novo, nenhum campo no data
channel, nenhuma mudança no servidor: o processamento acontece antes do encoder, e o
que trafega continua sendo exatamente o que já trafegava.

## 7. Stack

- **Frontend:** React + Vite. `RTCPeerConnection` nativo (sem SDK de terceiros tipo
  PeerJS/Twilio). Socket.IO client apenas para sinalização.
- **Backend (sinalização):** Node.js + Express + Socket.IO. Estado 100% em memória
  (`Map`), sem banco de dados, sem filas, sem cache externo.
- **STUN/TURN:** coturn self-hosted (`infra/coturn`), sem depender de STUN público do
  Google ou de provedores de TURN gerenciados.
- **Sem TypeScript** neste MVP para reduzir footprint de ferramentas — decisão
  reversível se o time crescer.

## 8. Estrutura de pastas

```
server/        signaling server (Express + Socket.IO, estado em memória)
client/        app React (Vite) — UI, WebRTC mesh, E2EE via insertable streams
client/test/   testes unitários (node:test): histerese de áudio, modelo de chat,
               cálculo da grade de vídeos (§6.7), do palco em destaque (§6.8)
               e o estado musical — fila, votação, parsing de origens e
               sanitização do protocolo (§6.9)
e2e/           teste ponta a ponta com 3 participantes Chromium + TURN local
infra/coturn/  config de referência para STUN/TURN self-hosted
```

## 9. Limitações conhecidas / trabalho futuro

- Sem gravação — é uma decisão de produto (privacidade total), não uma lacuna técnica.
- O chat não tem histórico e não entrega backlog a quem chega depois. É
  consequência direta da ausência de persistência (§6.3), não uma pendência.
- `getDisplayMedia` não captura áudio do sistema nesta versão: o compartilhamento
  de tela leva só vídeo. Para ouvir som junto existe o player de música (§6.8).
- **YouTube é a única dependência de terceiros do projeto, e é opcional.** Pela
  impossibilidade técnica de capturar o áudio de um iframe cross-origin (§6.8), a
  faixa é carregada no navegador de cada participante, o que expõe à Google o IP de
  todos e o que a sala ouve — em contradição direta com §1 e com a promessa de §5.
  A origem sai inteira com `VITE_ENABLE_YOUTUBE=false`, e a UI avisa explicitamente
  ao adicionar a primeira faixa de YouTube da sessão. **É uma decisão de produto em
  aberto**, não um esquecimento: arquivo local e URL direta entregam o recurso sem
  nenhum terceiro.
- O canal de música nasce **mono**, com teto de 96 kbps. Estéreo exigiria munging do
  `fmtp` do Opus no SDP e é uma entrega separada.
- A fila de música não reordena por drag-and-drop: a ordem é a de inserção. Remover
  e re-adicionar cobre o caso.
- Mesh não escala além de ~6-8 participantes; migrar para SFU exigiria reintroduzir um
  componente de mídia no servidor, o que contradiz o requisito atual de privacidade
  total — deve ser uma decisão consciente do produto, não uma otimização silenciosa.
- Insertable Streams: sem suporte pleno em Firefox/Safari no momento; UI comunica
  quando a chamada está rodando apenas com a criptografia padrão do WebRTC.
- Seleção de dispositivos (§6.10) cobre **escolha de hardware**; de qualidade, só a
  supressão de ruído (§6.11) é controlável. Não há controle de `echoCancellation`,
  de ganho de entrada nem de resolução de câmera — os dois primeiros são baratos sobre
  a base de §6.11 (o contrato de `buildConstraints` já os comporta), e faltam por
  escopo, não por impedimento. A supressão também não tem seletor de intensidade: ela
  é liga/desliga. Também não há botão de "testar saída", nem seletor de fonte para
  compartilhamento de tela (`getDisplayMedia` já traz o seletor nativo do navegador), e
  a preferência não é sincronizada entre abas — cada aba é uma sessão independente.
