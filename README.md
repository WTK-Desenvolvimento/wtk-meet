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
5. Cada frame de áudio/vídeo é cifrado com AES-GCM (chave derivada da passphrase via
   PBKDF2) antes de sair, usando Insertable Streams — funciona plenamente em navegadores
   Chromium; em Firefox/Safari a UI avisa que só a criptografia padrão do WebRTC está ativa.

## Estrutura

```
server/        sinalização (Express + Socket.IO), estado em memória, credenciais TURN efêmeras
client/        app React (Vite) — UI, mesh WebRTC, E2EE via insertable streams
infra/coturn/  config de referência para STUN/TURN self-hosted
```
