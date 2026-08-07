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

Nada disso é persistido: ao encerrar a sala (todos saem) ou reiniciar o processo, o
estado desaparece. Não há banco de dados no backend.

## 6. Stack

- **Frontend:** React + Vite. `RTCPeerConnection` nativo (sem SDK de terceiros tipo
  PeerJS/Twilio). Socket.IO client apenas para sinalização.
- **Backend (sinalização):** Node.js + Express + Socket.IO. Estado 100% em memória
  (`Map`), sem banco de dados, sem filas, sem cache externo.
- **STUN/TURN:** coturn self-hosted (`infra/coturn`), sem depender de STUN público do
  Google ou de provedores de TURN gerenciados.
- **Sem TypeScript** neste MVP para reduzir footprint de ferramentas — decisão
  reversível se o time crescer.

## 7. Estrutura de pastas

```
server/    signaling server (Express + Socket.IO, estado em memória)
client/    app React (Vite) — UI, WebRTC mesh, E2EE via insertable streams
infra/coturn/  config de referência para STUN/TURN self-hosted
```

## 8. Limitações conhecidas / trabalho futuro

- Sem suporte a compartilhamento de tela nesta primeira versão (adicionável como uma
  segunda track de vídeo por peer, mesmo pipeline de E2EE).
- Sem gravação — é uma decisão de produto (privacidade total), não uma lacuna técnica.
- Mesh não escala além de ~6-8 participantes; migrar para SFU exigiria reintroduzir um
  componente de mídia no servidor, o que contradiz o requisito atual de privacidade
  total — deve ser uma decisão consciente do produto, não uma otimização silenciosa.
- Insertable Streams: sem suporte pleno em Firefox/Safari no momento; UI comunica
  quando a chamada está rodando apenas com a criptografia padrão do WebRTC.
