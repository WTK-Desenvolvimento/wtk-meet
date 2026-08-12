# wtk-meet

Videochamadas em grupo (até 6 pessoas) em mesh P2P via WebRTC, com uma camada extra de
E2EE por cima do DTLS-SRTP nativo. Sem persistência de dados, sem infraestrutura de
terceiros: sinalização própria (Node.js) e STUN/TURN self-hosted (coturn).

Veja `ARCHITECTURE.md` para as decisões de arquitetura e trade-offs.

## Rodando localmente

Requer Node.js 20+.

### 1. Servidor de sinalização

```bash
cd server
cp .env.example .env
npm install
npm run dev
```

Sobe em `http://localhost:4000`. Estado 100% em memória — reiniciar o processo apaga
todas as salas.

### 2. Client

```bash
cd client
cp .env.example .env
npm install
npm run dev
```

Abre em `http://localhost:5173`.

### 3. STUN/TURN (coturn) — opcional para dev em uma máquina só

Só é necessário para testar o fallback de TURN relay (NAT simétrico) ou para chamadas
entre redes diferentes. Em `localhost`, STUN não chega a ser usado.

```bash
cd infra/coturn
# edite static-auth-secret em turnserver.conf e replique o mesmo valor em
# server/.env como TURN_SHARED_SECRET
docker compose up -d
```

## Fluxo de uma chamada

1. Quem cria a sala gera `roomId` + passphrase de 128 bits no próprio navegador — a
   passphrase nunca é enviada ao servidor, vive só no fragmento da URL (`/room/:id#chave`).
2. O link é compartilhado por fora do app (mensagem, etc).
3. Quem abre o link pede para entrar; se a sala já tem gente, qualquer participante
   presente aprova ou nega o pedido. Sala cheia (6) rejeita automaticamente.
4. Após aprovado, a negociação WebRTC (mesh completo) começa entre o novo peer e cada
   peer já presente. Mídia nunca passa pelo servidor de sinalização.
5. Cada conexão nasce com três canais de envio — microfone, câmera e tela — mais um
   `RTCDataChannel`. Ligar/desligar câmera e entrar/sair de compartilhamento de tela
   são trocas de track nesses canais, sem renegociar SDP. Quem já está na sala é
   avisado por um toast com bipe curto (silenciável).
6. Durante a chamada: **compartilhamento de tela** aparece como um tile próprio (quem
   compartilha continua na grade), **chat de texto** trafega P2P pelo data channel, e
   o tile de quem está falando ganha um anel azul reativo ao volume.
7. Cada frame de áudio/vídeo é cifrado com AES-GCM (chave derivada da passphrase via
   PBKDF2) antes de sair, usando Insertable Streams — funciona plenamente em navegadores
   Chromium; em Firefox/Safari a UI avisa que só a criptografia padrão do WebRTC está ativa.

### O que fica fora do servidor

- **Chat**: nenhum evento de chat existe no servidor Socket.IO. As mensagens vão pelo
  `RTCDataChannel` de cada conexão do mesh.
- **Histórico**: só existe na memória da aba. Recarregar a página ou sair da sala apaga
  a conversa por completo — não há `localStorage`, `sessionStorage` nem banco.
- **Indicador de fala**: os níveis de áudio são medidos localmente com
  `AudioContext` + `AnalyserNode`. Nenhum nível é transmitido.
- **Câmera desligada / tela ligada**: anunciados pelo data channel, não pelo servidor.

Ver `ARCHITECTURE.md` §6 para o desenho e os trade-offs.

## Testes

```bash
cd client && npm test     # unitários (node:test): histerese do indicador, modelo de chat
cd client && npm run lint

node e2e/run.mjs          # ponta a ponta: 3 participantes Chromium + TURN local
```

O E2E sobe um TURN em `127.0.0.1` (o client usa `iceTransportPolicy: 'relay'`, então
sem TURN nenhuma conexão fecha nem em loopback), builda o client apontando para uma
porta sorteada, abre três contextos Chromium isolados com câmera/microfone falsos e
percorre o roteiro completo: conectar, falar, compartilhar tela (inclusive dois ao
mesmo tempo, para exercitar glare), trocar mensagens, desligar/religar a câmera e sair
da sala. Requer as dependências de sistema do Chromium (`npx playwright install-deps`).

## Estrutura

```
server/        sinalização (Express + Socket.IO), estado em memória, credenciais TURN efêmeras
client/        app React (Vite) — UI, mesh WebRTC, E2EE via insertable streams
client/test/   testes unitários
e2e/           teste ponta a ponta com 3 participantes
infra/coturn/  config de referência para STUN/TURN self-hosted
```
