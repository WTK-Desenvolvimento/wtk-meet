# wtk-meet

Videochamadas em grupo (até 6 pessoas) em mesh P2P via WebRTC, com uma camada extra de
E2EE por cima do DTLS-SRTP nativo. Nada do que acontece numa chamada é gravado — a
única preferência que sobrevive à aba é qual câmera/microfone/saída você escolheu usar
(veja abaixo). Sem infraestrutura de terceiros: sinalização própria (Node.js) e
STUN/TURN self-hosted (coturn).

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
5. Cada conexão nasce com quatro canais de envio — microfone, câmera, tela e música —
   mais um `RTCDataChannel`. Ligar/desligar câmera, entrar/sair de compartilhamento de
   tela e assumir a faixa que está tocando são trocas de track nesses canais, sem
   renegociar SDP. Quem já está na sala é avisado por um toast com bipe curto
   (silenciável).
6. Durante a chamada: **compartilhar tela** coloca a sala em modo destaque — a tela
   ocupa ~80% do palco e as câmeras (mais as outras telas) ficam numa coluna lateral
   rolável; com mais de uma tela, cada participante escolhe localmente qual vê em
   destaque, clicando na miniatura. **Chat de texto** trafega P2P pelo data channel, e
   o tile de quem está falando ganha um anel azul reativo ao volume.
7. **Música (opcional):** o botão "Música" abre uma votação da sala; aprovada, libera
   um player com fila colaborativa. Qualquer participante adiciona faixas de arquivo
   local, URL de áudio ou YouTube, e qualquer um pula ou remove (a autoria fica
   visível). O áudio de arquivo local é retransmitido pelo canal de música de quem
   adicionou a faixa — o arquivo em si nunca sai da máquina dele. O volume é de cada
   ouvinte e nunca trafega.
8. Cada frame de áudio/vídeo é cifrado com AES-GCM (chave derivada da passphrase via
   PBKDF2) antes de sair, usando Insertable Streams — funciona plenamente em navegadores
   Chromium; em Firefox/Safari a UI avisa que só a criptografia padrão do WebRTC está ativa.

### O que fica fora do servidor

- **Chat**: nenhum evento de chat existe no servidor Socket.IO. As mensagens vão pelo
  `RTCDataChannel` de cada conexão do mesh.
- **Histórico**: só existe na memória da aba. Recarregar a página ou sair da sala apaga
  a conversa por completo — o chat não usa `localStorage`, `sessionStorage` nem banco.
- **Indicador de fala**: os níveis de áudio são medidos localmente com
  `AudioContext` + `AnalyserNode`. Nenhum nível é transmitido.
- **Câmera desligada / tela ligada**: anunciados pelo data channel, não pelo servidor.
- **Player de música**: fila, faixa corrente, posição e votos vivem nos clients e
  trafegam pelo mesmo data channel, com snapshot para quem entra depois. Nenhuma rota
  nem evento novo no servidor, e nada em storage — a fila morre com a sala.

### Escolher câmera, microfone e saída de áudio

O botão **Configurações** abre o mesmo modal em três lugares: na Home, na tela de
espera e na barra de controles da sala. Ele lista os dispositivos com os rótulos do
sistema, mostra preview de vídeo ao vivo e um medidor do microfone, e traz também o
toggle de avisos sonoros (que saiu da barra de controles).

- Salvar em chamada troca o track em todos os peers por `replaceTrack`, **sem
  renegociar SDP** e sem derrubar a mídia que não mudou. Trocar de microfone estando
  mudo não desmuta; trocar de câmera com a câmera desligada só guarda a escolha, sem
  acender o LED.
- A escolha é gravada em `localStorage`, sob a chave `wtk-meet:devices`
  (`videoInputId`, `audioInputId`, `audioOutputId`, `soundsEnabled`). **É a única
  exceção à regra de zero persistência** — ela vale para conteúdo e metadado de
  chamada, não para qual periférico do seu próprio equipamento usar. Limpar os dados
  do site apaga a preferência.
- Se o dispositivo salvo não existir mais (outra máquina, dock desconectada), a
  chamada abre pelo padrão do sistema **sem erro na tela** e a preferência se corrige
  sozinha. Desconectar um dispositivo em uso volta ao padrão e avisa.
- A saída de áudio depende de `setSinkId`: onde o navegador não implementa (Firefox
  por padrão), o seletor aparece desabilitado com a explicação.

Ver `ARCHITECTURE.md` §6 para o desenho e os trade-offs (§6.8 para dispositivos).
Ver `ARCHITECTURE.md` §6 para o desenho e os trade-offs (§6.8 para a música).

### Uma exceção declarada: YouTube

Arquivo local e URL direta funcionam sem nenhum terceiro envolvido. **YouTube não.**
O player da Google roda num iframe cross-origin e não existe API que dê acesso ao
áudio dele, então a faixa é carregada no navegador de **cada participante** — e a
Google passa a ver o IP de todo mundo na sala e o que a sala está ouvindo. Isso
contradiz o "sem infraestrutura de terceiros" do topo deste README, e por isso a
origem inteira sai com uma variável:

```bash
VITE_ENABLE_YOUTUBE=false   # remove a origem YouTube da UI e do parser
```

O padrão é ligado, com aviso explícito na UI ao adicionar a primeira faixa de YouTube
da sessão. Se a promessa de privacidade for absoluta na sua instalação, desligue.

## Testes

```bash
cd client && npm test     # unitários (node:test): histerese do indicador, modelo de
                          # chat, grade de vídeos e seleção de dispositivos
cd client && npm test     # unitários (node:test): histerese do indicador, modelo de chat,
                          # grade de vídeos e o estado do player de música
cd client && npm run lint

cd e2e && npm install     # uma vez
node e2e/run.mjs          # ponta a ponta: 3 participantes Chromium + TURN local
```

O E2E sobe um TURN em `127.0.0.1` (o client usa `iceTransportPolicy: 'relay'`, então
sem TURN nenhuma conexão fecha nem em loopback), builda o client apontando para uma
porta sorteada, abre três contextos Chromium isolados com câmera/microfone falsos e
percorre o roteiro completo: conectar, falar, compartilhar tela (inclusive dois ao
mesmo tempo, para exercitar glare), trocar mensagens, desligar/religar a câmera, trocar
de câmera e microfone pelo modal de configurações e sair da sala. Requer as
dependências de sistema do Chromium (`npx playwright install-deps`).

A flag de câmera falsa do Chromium expõe **um** dispositivo de cada tipo, e não existe
flag para um segundo — então o harness simula um registro de dispositivos
(`enumerateDevices`, `devicechange`, `setSinkId`) por cima dele. Sem isso, "trocar de
câmera" seria inexecutável no navegador.
mesmo tempo, para exercitar glare), trocar mensagens, desligar/religar a câmera, ligar
o player de música por votação (fila colaborativa, áudio no quarto canal, pular faixa)
e sair da sala. Requer as dependências de sistema do Chromium
(`npx playwright install-deps`).

## Estrutura

```
server/        sinalização (Express + Socket.IO), estado em memória, credenciais TURN efêmeras
client/        app React (Vite) — UI, mesh WebRTC, E2EE via insertable streams
client/test/   testes unitários
e2e/           teste ponta a ponta com 3 participantes
infra/coturn/  config de referência para STUN/TURN self-hosted
```
