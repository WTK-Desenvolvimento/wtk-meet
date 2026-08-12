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
restrições acima — em particular, **nada disso adiciona um único evento novo ao
servidor de sinalização**.

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
client/test/   testes unitários (node:test) da histerese de áudio e do modelo de chat
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
