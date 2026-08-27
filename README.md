# wtk-meet

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/WTK-Desenvolvimento/wtk-meet/actions/workflows/ci.yml/badge.svg)](https://github.com/WTK-Desenvolvimento/wtk-meet/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](https://nodejs.org/)

> 🌐 [English version](README.en.md)

Videochamadas em grupo (até 6 pessoas) em mesh P2P via WebRTC, com uma camada extra de
E2EE por cima do DTLS-SRTP nativo. Nada do que acontece numa chamada é gravado — a
única preferência que sobrevive à aba é qual câmera/microfone/saída você escolheu usar
(veja abaixo). Sem infraestrutura de terceiros: sinalização própria (Node.js) e
STUN/TURN self-hosted (coturn).

Veja `ARCHITECTURE.md` para as decisões de arquitetura e trade-offs.

## Rodando localmente

**Requer Node.js >= 22.18** (ou >= 24). O código-fonte é TypeScript e roda sem passo de
build no desenvolvimento e nos testes: quem apaga os tipos é o *type stripping* nativo
do Node, que só existe a partir dessa versão. Em Node 20 nem `npm test` nem
`node e2e/run.ts` funcionam. Só o **artefato de produção** é compilado (`npm run build`
no server, `vite build` no client) — e aí qualquer Node 20+ roda o `dist/`.

### 1. Servidor de sinalização

```bash
cd packages/server
cp .env.example .env
cd ../..
npm install
npm run dev:server     # roda src/index.ts direto, com --watch
```

Sobe em `http://localhost:4000`. Estado 100% em memória — reiniciar o processo apaga
todas as salas.

Para rodar como em produção — que é o que o container e o E2E fazem:

```bash
npm run build:server   # tsc → dist/
npm -w wtk-meet-server start
```

### 2. Client

```bash
cd packages/client
cp .env.example .env
cd ../..
npm run dev:client
```

Abre em `http://localhost:5173`.

### 3. TURN — **obrigatório**, inclusive em `localhost`

O client roda com `iceTransportPolicy: 'relay'` (decisão de privacidade: nenhum IP
local vaza entre participantes — ver `ARCHITECTURE.md` §5 e §6.1). A consequência é que
**o TURN não é fallback, é o caminho único**: sem um TURN acessível o navegador não gera
*nenhum* candidato — nem host, nem srflx — e nenhuma conexão fecha, nem entre duas abas
na mesma máquina. Não existe modo degradado.

O servidor de sinalização não hospeda TURN: ele emite **credenciais efêmeras** pela
Cloudflare TURN API e as entrega em `GET /turn-credentials`. Nenhuma credencial fica
baked no bundle do client.

```bash
# packages/server/.env
CF_TURN_TOKEN_ID=...      # obrigatório
CF_TURN_API_TOKEN=...     # obrigatório — nunca aparece em log nem em resposta
CF_TURN_TTL=3600          # opcional: validade da credencial, em segundos
CF_TURN_TIMEOUT_MS=5000   # opcional: timeout da chamada à Cloudflare
```

| Variável | Default | Observações |
|---|---|---|
| `CF_TURN_TOKEN_ID` | — | Sem ela, `/turn-credentials` responde **503** e `/health` reporta `turn.configured: false`. |
| `CF_TURN_API_TOKEN` | — | Idem. Redigido (`***`) em qualquer mensagem de erro ou linha de log. |
| `CF_TURN_TTL` | **3600** (1h) | Fixado na faixa `[600, 86400]`, com aviso em log quando sofre clamp ou quando o valor é inválido. |
| `CF_TURN_TIMEOUT_MS` | **5000** | Sem ele, um upstream que aceita a conexão e não responde prenderia a entrada na sala. |

> **Mudança de comportamento:** o default de `CF_TURN_TTL` era **86400 (24h)** e passou a
> **3600 (1h)**. `docs/architecture.md` §7 sempre especificou "TTL curto, ex. 1h", e a janela de
> 24h era justamente o que permitia a uma aba aberta desde ontem criar conexões novas com
> credencial vencida. O client agora renova sozinho, então TTL curto não custa nada em
> usabilidade. Quem preferir o comportamento antigo põe `CF_TURN_TTL=86400` no `.env`.

`GET /turn-credentials` tem **três desfechos, três status** — nunca `200` com lista vazia,
que era bit-a-bit indistinguível de uma sala saudável:

| Status | Corpo | Quando |
|---|---|---|
| **200** | `{ iceServers, ttl, expiresAt }` | Credencial obtida. `ttl` (segundos) é **autoritativo** — o client soma ao próprio relógio; `expiresAt` é informativo. |
| **503** | `{ error: 'turn-unconfigured', … }` | Faltam `CF_TURN_TOKEN_ID`/`CF_TURN_API_TOKEN`. Capacidade não provisionada. |
| **502** | `{ error: 'turn-upstream', … }` | A Cloudflare respondeu não-OK, lançou, devolveu lista vazia ou estourou o timeout. |

`GET /health` responde `{ ok: true, turn: { configured: boolean } }` — booleano puro, sem
chamar a Cloudflare e sem dizer qual token. E subir o servidor sem as variáveis imprime
**um** aviso explícito no boot. Diagnóstico rápido:

```bash
curl -s  localhost:4000/health             # {"ok":true,"turn":{"configured":true}}
curl -si localhost:4000/turn-credentials   # 200 / 503 / 502
```

O ciclo de vida completo da credencial (renovação no client, o que acontece quando ela
vence e como uma conexão caída se recupera) está em `ARCHITECTURE.md` §6.12.

> **Deriva de documentação, registrada de propósito:** `infra/coturn/` e o §7 de
> `docs/architecture.md` descrevem um TURN self-hosted com TURN REST API (shared secret +
> HMAC, `TURN_SHARED_SECRET`) que **não é o caminho que o código usa** —
> `server/src/turnCredentials.js` fala com a Cloudflare. A config de `infra/coturn/`
> continua válida como referência para quem quiser self-hostar (e é o que o E2E sobe em
> `127.0.0.1`), mas quem for debugar TURN em produção deve olhar as variáveis `CF_*` acima,
> e não um `turnserver.conf`. Reconciliar as duas coisas continua em aberto.

## Fluxo de uma chamada

1. Quem cria a sala gera o endereço + passphrase de 128 bits no próprio navegador — a
   passphrase nunca é enviada ao servidor, vive só no fragmento da URL (`/:sala#chave`).
   O endereço fica na **raiz**, sem prefixo: ou um slug sorteado de 9 caracteres
   (`/k7m2xq9tp#chave`), ou um escolhido na hora (`/uma-sala-so-minha#chave`).
2. O link é compartilhado por fora do app (mensagem, etc). Compartilhe-o **inteiro**,
   incluindo a parte depois do `#`: só o endereço leva à sala certa, mas sem a chave a
   pessoa entra com outra.
3. Quem abre o link cai numa **tela de pré-entrada**: nome, preview da própria câmera e
   o toggle de entrar com ela ligada ou desligada — **o padrão é desligada**, e nada ali
   conecta nada. Só depois de escolher é que se pede para entrar; se a sala já tem gente,
   qualquer participante presente aprova ou nega o pedido. Sala cheia (6) rejeita
   automaticamente.
4. Após aprovado, a negociação WebRTC (mesh completo) começa entre o novo peer e cada
   peer já presente. Mídia nunca passa pelo servidor de sinalização.
5. Cada conexão nasce com quatro canais de envio — microfone, câmera, tela e música —
   mais um `RTCDataChannel`. Os quatro são criados sempre, mesmo vazios: quem entra com
   a câmera desligada negocia o canal de câmera **sem track dentro**, e é por isso que
   ligar a câmera depois não precisa de SDP novo. Ligar/desligar câmera, entrar/sair de
   compartilhamento de tela e assumir a faixa que está tocando são trocas de track nesses
   canais, sem renegociar SDP. Quem já está na sala é avisado por um toast com bipe curto
   (silenciável) — e vê o tile do recém-chegado em placeholder desde o primeiro frame,
   sem piscar vídeo e sem aviso de "desligou a câmera": entrar desligado não é mudança
   de estado.
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

### Endereço da sala

O link **é** o produto: não há conta, diretório de salas nem convite por e-mail. Por
isso o endereço mora na raiz, num segmento só, e o `/room/` deixou de existir.

| Path | O que é |
|---|---|
| `/` e `/app` | Home — criar sala ou colar um convite |
| `/app/*` | Namespace das telas da aplicação (sem tela filha ainda) |
| `/room/:id#chave` | Link antigo: redireciona para `/:id#chave`, com o fragmento intacto |
| `/qualquer-outra-coisa` | **Sala** |

- **Slug sorteado:** 9 caracteres em base32 sem caracteres confundíveis
  (`0123456789abcdefghjkmnpqrstvwxyz` — sem `i`, `l`, `o` e `u`), 45 bits. Feito para
  ser ditado por telefone sem soletrar "é o L ou o um?".
- **Endereço escolhido:** digite no campo da Home ou direto na barra de endereço. É
  normalizado, não recusado: `Sala do Nícolas!` vira `sala-do-nicolas`. Maiúsculas
  caem, acentos somem, espaço e `_` viram hífen. Vale até 64 caracteres, em
  `[a-z0-9-]` começando por letra ou número — acima disso o campo avisa em vez de
  cortar, porque uma sala truncada seria **outra** sala.
- **Reservados** (nunca viram sala): `app`, `room`, `api`, `health`,
  `turn-credentials`, mais os paths que o nginx serve antes do SPA — `assets`,
  `static`, `public`, `favicon-ico`, `robots-txt`, `index-html` e companhia. Path com
  mais de um segmento (`/time/daily`) também não é sala: volta para a Home.
- **Abrir um endereço sem `#`** — digitar `/daily` na barra e apertar enter — **é**
  criar a sala: o client gera a passphrase na hora e reescreve a URL para
  `/daily#chave` com `replace` (o Voltar não volta para o path sem chave). Consequência
  a saber: duas pessoas que abrem o mesmo endereço sem `#` recebem chaves
  **diferentes**. Elas caem na mesma sala de sinalização, mas com a E2EE religada não
  decodificariam o vídeo uma da outra. Por isso o link se compartilha inteiro.
- **Slug curto não enfraquece a E2EE.** O que protege a chamada é a passphrase de 128
  bits, que continua nascendo no client e vivendo só no fragmento — o servidor nunca a
  vê, e encurtar o endereço não muda isso. O endereço é público por natureza (o
  servidor precisa dele para juntar as pessoas); quem adivinhar `/daily` ainda depende
  da aprovação de quem já está na sala para entrar, e sem a chave não decodificaria a
  mídia. Endereço escolhido é mais fácil de adivinhar que um sorteado — a UI avisa.

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

### Entrar na sala: a tela de pré-entrada

Abrir o link de uma sala **não acende o LED da webcam**. Quem chega sem nome na sessão
vê primeiro uma tela de pré-entrada com campo de nome, preview local espelhado, o toggle
**Entrar com a câmera ligada** e o botão Configurações.

- **O padrão de fábrica é entrar com a câmera desligada.** Sem preferência gravada,
  nenhum `getUserMedia` com vídeo acontece — nem no lobby, nem depois de entrar. O
  microfone continua com o comportamento de sempre: você entra falando, não mutado.
- **O preview é opt-in.** A câmera só abre se o toggle estiver ligado, e o stream do
  lobby morre ao sair da tela por qualquer caminho (entrar, navegar, fechar). Ele nunca
  é entregue à sala: o setup da chamada faz a própria captura.
- **A escolha fica gravada** em `wtk-meet:devices` (campo `startCameraOff`) no clique do
  toggle, não no botão Entrar — fechar a aba antes de entrar não perde a decisão, e ela
  vale para as próximas salas.
- **Quem recarrega a página não passa pelo lobby de novo:** o nome já está em
  `sessionStorage` e a preferência decide a câmera. Mesma coisa para quem cria a sala
  pela Home — esse caminho entra direto, com o padrão de fábrica, e a câmera se liga
  pelo botão "Ativar câmera" dentro da sala. (Expor o toggle no modal de Configurações,
  que é alcançável da Home, é trabalho futuro.)
- Se a câmera não abrir no preview, aparece uma linha de aviso e **nada é bloqueado**:
  dá para entrar assim mesmo e ligar a câmera lá dentro.

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
  (`videoInputId`, `audioInputId`, `audioOutputId`, `soundsEnabled` e
  `startCameraOff` — este último é a escolha da tela de pré-entrada, e vale `true`
  quando não há nada gravado) — e a supressão
  de ruído, abaixo, sob `wtk-meet:audio`. **São as únicas exceções à regra de zero
  persistência** — ela vale para conteúdo e metadado de chamada, não para qual
  periférico do seu próprio equipamento usar. Limpar os dados do site apaga a
  preferência.
- Se o dispositivo salvo não existir mais (outra máquina, dock desconectada), a
  chamada abre pelo padrão do sistema **sem erro na tela** e a preferência se corrige
  sozinha. Desconectar um dispositivo em uso volta ao padrão e avisa.
- A saída de áudio depende de `setSinkId`: onde o navegador não implementa (Firefox
  por padrão), o seletor aparece desabilitado com a explicação. Onde implementa, a
  escolha vale para a voz dos participantes **e** para a música do player — os dois
  saem por `<audio>` dedicados, e é neles que a preferência é aplicada.

**Não estou ouvindo ninguém, mas me ouvem.** São duas causas prováveis, nesta ordem:

1. **A saída de áudio.** Se o padrão do seu sistema for o alto-falante do monitor, uma
   saída HDMI ou um fone Bluetooth pareado mas ocioso, o som está saindo por lá.
   Escolha o dispositivo certo em **Configurações → Saída de áudio**.
2. **O navegador bloqueou o som.** Isso acontece quando a sala é aberta sem nenhum
   clique — recarregar a página com o nome já preenchido entra direto. Nesse caso
   aparece um aviso na sala dizendo que o som foi bloqueado; **clicar nele** destrava
   a voz de todo mundo e a música de uma vez.

Se o problema for de conexão e não de reprodução, o tile da pessoa diz: "Sem conexão"
(`failed`), "Instável" (`disconnected`) ou "Conectando…". Tile sem nenhum indicador é
conexão saudável.

### Supressão de ruído

O mesmo modal traz o toggle **Supressão de ruído**, **ligado por padrão** — ventilador,
teclado e obra do vizinho param de ir junto com a voz, sem ninguém precisar descobrir
a opção.

- O motor é escolhido pelo navegador, não por você: onde existe supressão nativa, é
  ela; onde não existe, entra um `AudioWorklet` próprio do projeto. Se o navegador não
  tiver nenhum dos dois, o toggle aparece desabilitado com a explicação. O hint embaixo
  do controle diz qual motor está ativo.
- **Tudo acontece no seu navegador.** O áudio é processado antes de ser codificado:
  nenhuma rota nova, nenhum evento de sinalização, nada no data channel e nada que o
  servidor veja. Não há serviço de terceiros envolvido.
- Ligar e desligar em chamada não renegocia a conexão nem derruba ninguém, e não
  desmuta quem está mudo.
- A escolha é gravada sob a chave `wtk-meet:audio`, separada da de dispositivos: ela
  descreve o seu **ambiente**, não o seu hardware, e por isso não é reescrita quando um
  microfone é trocado ou desaparece.

Ver `ARCHITECTURE.md` §6 para o desenho e os trade-offs (§6.9 para a música, §6.10 para
dispositivos, §6.11 para a supressão de ruído).

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
# tudo pela raiz (npm workspaces):
npm test                    # unitários de client + server (node:test)
npm run typecheck           # tsc --noEmit nos três pacotes
npm run lint                # eslint 9 flat config + typescript-eslint

# E2E (ponta a ponta: 3 participantes Chromium + TURN local):
npm run test:e2e
```

O typecheck é portão **separado** do build: `npm run build` no client não roda `tsc`,
de propósito — o E2E builda o client a cada execução e não deve pagar por isso duas
vezes. Rode `npm run typecheck` antes de commitar.

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

## Estrutura

```
tsconfig.base.json       o rigor de tipos comum aos três pacotes (strict: true)
tools/                   hooks de módulo que fazem o `node --test` enxergar TypeScript
packages/server/         sinalização (Express + Socket.IO), estado em memória, credenciais TURN efêmeras
packages/server/dist/    artefato compilado (`npm run build`) — é o que o container roda
packages/client/         app React (Vite) — UI, mesh WebRTC, E2EE via insertable streams
packages/client/test/    testes unitários
packages/e2e/            teste ponta a ponta com 3 participantes
infra/coturn/            config de referência para STUN/TURN self-hosted
```

O repositório usa **npm workspaces**: `npm install` na raiz instala tudo de uma vez.
Comandos comuns pela raiz: `npm test`, `npm run build`, `npm run lint`, `npm run typecheck`.
Só o `tsconfig.base.json` é compartilhado, e é por isso que o
`docker compose build` tem a raiz como contexto (ver `docker-compose.yml`).

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para o guia completo de como contribuir
([English version](CONTRIBUTING.en.md)).

## Segurança

Para relatar vulnerabilidades, **não abra issues públicas**. Siga as instruções em
[SECURITY.md](SECURITY.md).

## Licença

Este projeto é licenciado sob a [Apache License 2.0](LICENSE).

Copyright 2024-2026 WTK Desenvolvimento.
