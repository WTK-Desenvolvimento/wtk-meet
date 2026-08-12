# wtk-meet — Arquitetura

Videochamadas em grupo (até 6 pessoas), mesh P2P via WebRTC, com camada extra de E2EE
client-side e zero persistência. Documento mantido por Winston (Arquiteto).

## 1. Objetivos e restrições

- Até 6 participantes por sala.
- Mídia nunca passa por um servidor de aplicação — apenas P2P (mesh) com fallback de
  relay via TURN self-hosted quando NAT/firewall impede conexão direta.
- Nenhuma persistência: sem banco de dados, sem gravação de chamadas, sem logs de
  conteúdo. O processo de sinalização mantém estado apenas em memória, por sala, e o
  descarta quando a sala esvazia ou o servidor reinicia.
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
  (`passphrase + roomId` como salt, 250k iterações, SHA-256).
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

1. Criador gera `roomId` (UUID) + `passphrase` no client, sem chamar o servidor, e
   compartilha o link `https://.../room/:roomId#passphrase` por um canal à parte
   (mensagem, etc.) — o servidor nunca vê a passphrase.
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

Nada disso é persistido: ao encerrar a sala (todos saem) ou reiniciar o processo, o
estado desaparece. Não há banco de dados no backend.

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
React: não há `localStorage`, `sessionStorage`, IndexedDB nem servidor.
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
client/test/   testes unitários (node:test): histerese de áudio, modelo de chat e
               cálculo da grade de vídeos (§6.7)
e2e/           teste ponta a ponta com 3 participantes Chromium + TURN local
infra/coturn/  config de referência para STUN/TURN self-hosted
```

## 9. Limitações conhecidas / trabalho futuro

- Sem gravação — é uma decisão de produto (privacidade total), não uma lacuna técnica.
- O chat não tem histórico e não entrega backlog a quem chega depois. É
  consequência direta da ausência de persistência (§6.3), não uma pendência.
- `getDisplayMedia` não captura áudio do sistema nesta versão: o compartilhamento
  de tela leva só vídeo.
- Mesh não escala além de ~6-8 participantes; migrar para SFU exigiria reintroduzir um
  componente de mídia no servidor, o que contradiz o requisito atual de privacidade
  total — deve ser uma decisão consciente do produto, não uma otimização silenciosa.
- Insertable Streams: sem suporte pleno em Firefox/Safari no momento; UI comunica
  quando a chamada está rodando apenas com a criptografia padrão do WebRTC.
