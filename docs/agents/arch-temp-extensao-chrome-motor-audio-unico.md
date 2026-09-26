# Extensão Chrome (MV3) com motor de áudio único para música e soundboard em sala wtk-meet paralela — Documento de Arquitetura Técnica

> Gerado em: 2026-09-15
> Task: WTK-MEET-26
> Status: Rascunho — **três decisões pedem aval explícito antes da implementação (§3.7, §3.10 e §3.11)**

---

## 1. Contexto e Objetivo

Hoje música (§6.9 do `ARCHITECTURE.md`) e soundboard (§6.13) só existem **dentro da aba**
do client wtk-meet. Três consequências caem juntas:

- **Um `AudioContext` por aba.** O dono é o `Room` (`lib/audioContext.ts`), nasce com a
  sala e morre com ela. Duas abas na mesma sala são dois motores, duas filas, dois
  soundboards — e dois produtores no quarto transceiver, cada um numa conexão diferente.
- **Favoritos presos ao `localStorage` daquela origem** (`wtk-meet:soundboard`), que só
  existe enquanto a pessoa estiver no app.
- **A música só toca se a sala do wtk-meet for *a* reunião.** Quem está numa reunião do
  Google Meet — que não compartilha áudio do sistema — não tem como pôr som na sala sem
  abandonar a ferramenta onde a conversa acontece.

Esta entrega cria um workspace novo, `packages/extension`, com uma extensão Chrome MV3
que resolve os três de uma vez:

- **Um motor só, num `offscreen document`.** O Chrome permite **um** documento offscreen
  por extensão: essa restrição da plataforma é exatamente a garantia que o produto quer —
  uma fila, um player, um soundboard, um `AudioContext`, um track de música, não importa
  quantas abas estejam abertas.
- **Uma sala wtk-meet paralela como canal de transmissão.** O motor entra numa sala
  normal, como um participante qualquer, e sobe o áudio pelo **quarto transceiver** que já
  existe. Quem está na sala ouve sem instalar nada — o `RemoteMusicAudio` do app toca o
  canal de música de qualquer peer **independentemente** de votação e de painel aberto
  (verificado em `pages/Room.tsx`, o componente fica montado fora de todo ramo de fase).
- **O código do Meet vira o endereço da sala.** Ao clicar no ícone com uma aba do Google
  Meet ativa, o popup pré-preenche o campo de sala com o código normalizado — para que as
  pessoas da mesma reunião cheguem à mesma sala sem combinar nada.

**Comportamento esperado depois da entrega:**

- Instalada a extensão, clicar no ícone abre um popup com o campo de sala já preenchido
  (`meet-abc-defg-hij`) quando a aba ativa é uma reunião do Meet, e com a última sala usada
  caso contrário.
- "Conectar" põe o motor na sala; a fila, o player e o soundboard vivem no motor e são os
  mesmos para todas as abas e para todas as janelas do navegador.
- Tocar um arquivo local ou uma URL com CORS faz a sala inteira ouvir. Disparar um efeito
  do soundboard idem, com autoria visível no painel de quem está no app.
- A extensão **não** deriva chave de E2EE e **não** carrega passphrase (§3.3). Isso é uma
  decisão registrada, não um esquecimento — e tem uma condição de disparo escrita para o
  dia em que o app religar a camada extra de cifra.
- Nenhuma mudança no `packages/server` e nenhuma mudança no `packages/client`: o mesmo
  binário do servidor e o mesmo app de hoje atendem a extensão.

---

## 2. Escopo

**Dentro do escopo:**

- Workspace novo `packages/extension` (npm workspaces), TypeScript `strict` estendendo
  `tsconfig.base.json`, `eslint.config.js` próprio, build com o `esbuild` que já está na
  raiz e testes em `node --test`.
- `manifest.json` MV3: `action` com popup, service worker de módulo, permissões
  `offscreen`, `storage`, `activeTab` e host permissions **opcionais**.
- **Service worker**: roteador sem estado e dono do ciclo de vida do documento offscreen.
- **Offscreen document**: o motor — `AudioContext`, `MusicEngine`, `SoundboardPlayer`,
  `WebRTCMesh`, cliente de sinalização, fila e estado, tudo num lugar só.
- **Popup**: conectar/desconectar, transporte (play/pause/pular), volume local, favoritos
  do soundboard com disparo, lista de pedidos de entrada pendentes com aprovar/negar.
- **Página `manager`** (aba própria da extensão): fila completa, adicionar arquivo e URL,
  editar favoritos, nome de exibição, URL do servidor de sinalização e do app.
- Normalização do código do Meet → path de sala, num módulo puro e testado.
- Reúso, **por import relativo e sem cópia**, dos módulos do client que já resolvem o
  problema: `musicEngine`, `soundboardPlayer`, `soundboard`, `soundboardRate`,
  `musicSources`, `musicSession`, `musicProtocol`, `webrtcMesh`, `iceServers`,
  `audioFileStorage`, `roomSlug` (§3.5).
- Atualização de `ARCHITECTURE.md` (nova §11, mais linhas em §5, §8 e §9), `README.md`,
  `CHANGELOG.md` e `docs/progress/WTK-MEET-26.md`.

**Fora do escopo:**

- **YouTube como origem dentro da extensão** (§3.9). Não é preguiça: MV3 proíbe código
  hospedado remotamente, e a entrega `local` do YouTube pressupõe que *cada* participante
  toque o vídeo — o que o motor, sozinho, não pode fazer pela sala.
- **Participar do protocolo colaborativo `music-*`** (fila replicada, votação, dono de
  faixa, sucessão). A extensão é produtora de áudio, não co-autora da sessão da sala
  (§3.2). A única mensagem que ela emite é o anúncio `soundboard-play`.
- **Captura de áudio da aba do Meet** (`chrome.tabCapture`) ou de qualquer aba. Levaria
  junto a voz de quem está na reunião para dentro de outra sala — é gravação de terceiros
  por caminho transverso, e contradiz o §1 do `ARCHITECTURE.md` inteiro.
- **Content script em `meet.google.com`.** O código do Meet é lido da URL da aba ativa no
  clique, e nada é injetado na página da Google (§3.7).
- **Microfone e câmera na extensão.** O motor não chama `getUserMedia`: entra com os quatro
  senders, três deles vazios. Quem fala, fala no Meet ou no app.
- **Reproduzir a voz dos outros participantes no motor** (§3.14).
- Publicação na Chrome Web Store, assinatura, ícone definitivo e canal de atualização.
  A entrega é uma extensão **descompactada** (`dist/`), carregável por
  `chrome://extensions` → "Carregar sem compactação".
- Firefox/Safari. A base de código é MV3 + `chrome.offscreen`, que é API de Chromium.
- Mudanças em `packages/server` e em `packages/client`. Se a implementação concluir que
  alguma é inevitável, isso é sinal de que uma decisão deste documento está errada — volte
  aqui antes de editar.

---

## 3. Decisões Arquiteturais

### 3.1 O motor mora no documento offscreen; o service worker é um roteador sem estado

- **Decisão:** todo o estado vivo (fila, faixa corrente, posição, socket, `AudioContext`,
  `WebRTCMesh`, cache de efeitos) mora no **documento offscreen**. O service worker faz
  três coisas e nada mais: criar/garantir o documento offscreen, encaminhar mensagens e
  escrever o badge do ícone.
- **Motivação:** o service worker MV3 é **efêmero por especificação** — o Chrome o encerra
  depois de ~30s sem eventos e o reinicia do zero. Um socket, um `RTCPeerConnection` ou um
  `AudioContext` ali dentro morreriam no meio da música, e o sintoma seria "a sala parou de
  ouvir e não tem erro em lugar nenhum" — exatamente a classe de falha silenciosa que este
  repositório documenta em três lugares. O documento offscreen, ao contrário, vive
  enquanto não for fechado. E ele é **único por extensão**: a plataforma garante de graça
  a propriedade central do produto ("um motor, todas as abas").
- **Alternativas descartadas:**
  - *Estado no service worker com `chrome.storage.session` como memória.* Serializa o que
    não é serializável (nós de áudio, tracks, conexões). Não resolve nada e acrescenta um
    caminho de reidratação que ninguém consegue testar.
  - *Uma aba oculta com o app carregado (`chrome.tabs.create({active:false})`).* Aparece na
    barra de abas, o usuário fecha sem entender, o Chrome descarrega abas em segundo plano
    sob pressão de memória, e o motor volta a ser um por aba.
  - *`chrome.tabCapture` do próprio app.* Ver §2, fora do escopo.

### 3.2 A extensão é produtora de áudio no quarto transceiver, não participante do protocolo `music-*`

- **Decisão:** o motor entra na sala, ata o track de música e toca. Ele **não** envia
  `music-queue-add`, `music-playback`, `music-snapshot`, `music-command` nem participa de
  votação. A única mensagem que sai dele é `soundboard-play` (§5). Mensagens `music-*` que
  chegam são **sanitizadas e descartadas**.
- **Motivação:** o app toca o canal de música de qualquer peer sem votação e sem painel
  aberto — o `RemoteMusicAudio` fica montado fora de todo ramo condicional, de propósito
  (o comentário no `Room.tsx` diz por quê). Ou seja: **para a sala ouvir, zero mensagem é
  necessária.** Já falar o protocolo inteiro significaria replicar, na extensão, o dono de
  faixa, o `version` monotônico, a sucessão quando o dono cai, o heartbeat de posição e o
  `planAdvance` — 1.700 linhas de orquestração cuja regra de ouro é "um escritor por
  transição". Uma segunda implementação dessa máquina é a maneira mais confiável de
  produzir duas verdades sobre quem é o dono da faixa, e o sintoma disso é fila divergente
  sem erro.
- **Consequência que precisa estar escrita:** quem está no app **não vê** a fila da
  extensão e **não consegue** pular a faixa dela. O que vê é um participante chamado
  "Música (extensão)" tocando som — e a defesa de quem não quer ouvir é a mesma de sempre:
  baixar o volume da música ou silenciar aquele peer.
- **Alternativa descartada:** participação plena no protocolo. Fica registrada como
  trabalho futuro *condicionado* a extrair a orquestração de `useMusicRoom` para um módulo
  sem React — não antes.

### 3.3 Sem passphrase e sem chave derivada — e a condição de disparo para o dia em que isso mudar

- **Decisão:** o motor **não** deriva chave (`deriveRoomKey` nunca é chamado), **não**
  passa `getRoomKey` ao `WebRTCMesh` e **não** inventa passphrase nenhuma. O popup aceita
  tanto um id de sala quanto um link de convite inteiro; se vier link com `#fragmento`, o
  fragmento é **guardado verbatim** só para o botão "copiar link" e nunca usado para
  derivar coisa alguma.
- **Motivação:** é o pedido explícito da task, e hoje ele é compatível com o produto — a
  camada extra de E2EE está **desligada no `Room`** desde antes desta entrega (as chamadas
  estão comentadas em `pages/Room.tsx`, com o motivo e a instrução de religamento). Com
  `getRoomKey` ausente, os transforms de `e2ee.ts` fazem *passthrough*: nada é cifrado e
  nada é decifrado, dos dois lados. O tráfego continua protegido por DTLS-SRTP, como o de
  qualquer participante hoje.
- **Armadilha (a mais importante deste documento):** `makeDecryptTransform` **descarta** o
  quadro quando a decifragem falha — não repassa, não loga, não avisa. No dia em que o app
  religar a E2EE, os participantes passarão a decifrar tudo que chega com a chave da sala,
  inclusive os quadros em claro da extensão, e vão **descartá-los em silêncio**. O sintoma
  será "a extensão conecta, o tile aparece, e ninguém ouve nada" — sem um erro sequer.
  Por isso a §9 deste documento exige um comentário-âncora no `Room.tsx`, ao lado das
  linhas comentadas de E2EE, apontando para cá.
- **Alternativas descartadas:**
  - *A extensão gerar a passphrase da sala.* Ela passaria a distribuir um segredo que não
    usa, e duas extensões na mesma sala gerariam fragmentos diferentes — cada humano com
    uma impressão de chave diferente (`KeyFingerprint`), que é precisamente o alarme que o
    componente existe para dar.
  - *Derivar a passphrase do código do Meet.* Qualquer um com o código da reunião derivaria
    a chave. É pior do que não ter chave, porque **parece** ter.

### 3.4 O track de música é atado uma vez e só é solto ao desconectar

- **Decisão:** logo após entrar na sala, o motor chama `engine.ensureOutput()` e
  `mesh.setMusicTrack(track)` **uma vez**. `setMusicTrack(null)` só acontece no
  desligamento. O sender fica atado mesmo com a fila vazia e o player parado.
- **Motivação:** no app, o canal de música tem **dois donos** desde a WTK-MEET-23 (player e
  soundboard mixam no mesmo `MediaStreamDestination`), e por isso os cinco ramos que
  "desligam o canal" precisam perguntar antes se o soundboard está com ele — um
  `setMusicTrack(null)` cru derruba um efeito no meio, em silêncio. Na extensão o motor é
  um broadcaster dedicado: manter o sender atado o tempo todo **apaga a classe inteira de
  bug** em vez de reimplementar a pergunta. De quebra, elimina o custo de reativar um
  sender (que come quadros e comeria o ataque de um efeito de 1,2s).
- **Custo aceito:** um sender de Opus transmitindo silêncio para cada peer enquanto nada
  toca. Com o teto de 96 kbps do `_applyMusicEncoding` e DTX do codec, é ruído de fundo na
  conta de banda — e o motor só está na sala porque alguém mandou conectar.

### 3.5 Reúso por import relativo entre pacotes; nenhuma linha do client muda

- **Decisão:** `packages/extension` importa os módulos do client por caminho relativo
  (`../../client/src/lib/musicEngine.js`), com o mesmo estilo de especificador `.js` que o
  repositório usa. Nada é copiado e **nada em `packages/client` é editado**.
- **Motivação:** as três alternativas são piores. Copiar produz divergência (o repositório
  já pagou por isso: `planAdvance` duplicado, citado no §7 do `ARCHITECTURE.md`). Criar um
  `packages/shared` move dezenas de imports do client numa entrega que não é de refatoração.
  Publicar o client como biblioteca exigiria `exports`, build de lib e versionamento para
  um consumidor só.
- **O que **não** dá para reusar, e por quê:**
  - `lib/signaling.ts` importa `../config.ts`, que lê `import.meta.env` e **executa efeitos
    de módulo** (`configureIceServers`, `configureTelemetry`) na importação. Arrastar isso
    para a extensão traria a telemetria do app junto. A extensão tem seu próprio
    `signaling.ts` (≈50 linhas, os mesmos quatro `emit`) e sua própria configuração.
    **Isso cria um contrato escrito duas vezes** — mitigação em §7.9.
  - `lib/youtubePlayer.ts`: fora de escopo (§3.9).
  - `lib/useMusicRoom.ts` e os componentes: React acoplado ao `Room` (§3.2).
- **Nota para quem for implementar:** o `esbuild` resolve `./x.js` → `./x.ts` quando o
  importador é TypeScript (é a regra do próprio `tsc`). Se na prática não resolver, o
  conserto já existe pronto em dois lugares do repositório para copiar: o plugin
  `resolveJsToTs` de `packages/client/vite.config.ts` e `tools/tsLoader.mjs`.

### 3.6 Nenhuma mudança no servidor: a host permission substitui o CORS

- **Decisão:** a extensão pede **permissão de host opcional** para a origem do servidor de
  sinalização que o usuário configurar, via `chrome.permissions.request()` a partir de um
  gesto na página `manager`. Com a permissão concedida, `fetch` e XHR do documento
  offscreen falam com o servidor sem depender do `Access-Control-Allow-Origin` dele. O
  cliente de sinalização abre com `transports: ['websocket']`.
- **Motivação:** o `CLIENT_ORIGIN` do servidor é uma allowlist de origens
  (`packages/server/src/index.ts`, `cors` do Express e do Socket.IO). Exigir que todo
  operador acrescente `chrome-extension://<id>` ali transformaria um recurso de client numa
  mudança de deploy — e o id da extensão muda por instalação enquanto não houver `key`
  fixada no manifest. Com a permissão de host, a extensão funciona contra um deploy
  intocado. O `transports: ['websocket']` evita o handshake por *polling*, que é o único
  que passa por CORS.
- **Caminho alternativo, documentado no README para quem hospeda:** publicar a extensão com
  id estável (campo `key` no manifest) e acrescentar `chrome-extension://<id>` ao
  `CLIENT_ORIGIN`. Aí nenhuma permissão de host é necessária. Os dois caminhos coexistem;
  o padrão é o primeiro.
- **O que o servidor passa a ver:** mais um socket na sala, com um `displayName`. Nada
  mais — nenhuma rota nova, nenhum evento novo, nenhuma variável nova. A tabela do §5 do
  `ARCHITECTURE.md` não ganha nenhuma linha por causa deste item (mas ganha uma por causa
  do §3.7 abaixo).

### 3.7 O código do Meet é lido no clique, por `activeTab`, e vira `meet-<codigo>` — **pede aval**

- **Decisão:** ao abrir o popup, `chrome.tabs.query({active: true, currentWindow: true})`
  lê a URL da aba ativa. Se casar com `https://meet.google.com/<abc-defg-hij>`, o campo de
  sala nasce preenchido com `meet-abc-defg-hij`, passando por `normalizeRoomPath` do
  `roomSlug.ts` do client. O campo é **editável** e a sala escolhida é sempre a que está
  no campo quando o usuário aperta "Conectar".
- **Motivação:** é o pedido da task, e é o que faz duas pessoas da mesma reunião chegarem à
  mesma sala sem combinar um endereço. `activeTab` é concedida **no ato da invocação** e
  só para aquela aba: nenhuma permissão permanente sobre `meet.google.com`, nenhum content
  script, nenhuma leitura em segundo plano.
- **O que isso custa, e por que pede aval:** o endereço da sala passa a ser **derivado do
  código da reunião**. Consequências, todas reais:
  1. O servidor de sinalização passa a ver códigos de Meet como nome de sala — ele já via
     nomes escolhidos por gente desde a WTK-MEET-10, e o §5 do `ARCHITECTURE.md` registra
     que o que mudou foi *o que esse valor revela nos logs de quem opera*. Isto é mais um
     passo na mesma direção e precisa de uma linha lá.
  2. Quem conhece o código da reunião **adivinha** o endereço da sala. Com
     `GET /rooms/:roomId/occupancy` (que já existe, e já é uma exceção declarada) dá para
     sondar se aquela reunião tem sala de áudio aberta agora.
  3. A defesa que sobra — e ela é real — é o fluxo de aprovação do §4: quem não estava na
     sala precisa ser admitido por quem está.
- **Mitigações baratas, já embutidas:** o prefixo `meet-` (evita colisão com salas de
  humanos e deixa a origem legível); o campo editável; e a página `manager` oferecendo
  "usar um endereço aleatório" com um botão.
- **Alternativa descartada (mas pronta para ser retomada):** derivar o path de um **hash**
  do código (`sha256(codigo)` em base32, 9 caracteres), que é determinístico entre
  extensões e não revela o código ao servidor. Foi descartada porque o DoD pede o "código
  do Meet normalizado", e porque um endereço que ninguém consegue ditar por voz quebra o
  caminho de quem quer entrar pelo app sem a extensão. **Se o aval for pela privacidade,
  esta é a troca, e ela custa meia hora de implementação.**

### 3.8 Aprovar quem entra continua sendo ato humano — o motor nunca aprova sozinho

- **Decisão:** quando o motor está na sala e chega um `join-request`, ele **não responde**.
  Ele guarda o pedido, manda o service worker pintar o badge do ícone com a contagem, e o
  popup mostra a lista com "Aprovar" e "Negar". `join-request-cancelled` limpa a entrada.
- **Motivação:** o §4 do `ARCHITECTURE.md` diz que o controle de acesso é do grupo, e a
  primeira pessoa numa sala vazia é admitida sozinha — ou seja, se o motor entrar primeiro,
  **ele vira o porteiro**. Um porteiro que aprova qualquer um transforma "sala com
  aprovação" em "sala aberta para quem adivinhar o endereço", e §3.7 acabou de tornar o
  endereço adivinhável. Aprovação automática é a única decisão deste documento que
  quebraria uma promessa do produto.
- **Alternativa descartada:** recusar-se a entrar em sala vazia (sondando `occupancy`
  antes) e sair quando ficar sozinho. Resolve o porteiro eliminando o caso, mas obriga o
  usuário a abrir o app pelo menos uma vez para criar a sala — o oposto do que a extensão
  promete. Fica registrada como o plano B se o badge se mostrar insuficiente na prática.
- **Nota de UX que não é opcional:** sem o badge, um pedido fica esperando indefinidamente
  porque o dono do motor não tem por que abrir o popup. O badge **é** o recurso.

### 3.9 YouTube fica de fora, e por dois motivos independentes

- **Decisão:** `parseSource` é chamado com `{ allowYouTube: false }` em toda entrada da
  extensão. Link de YouTube é recusado com mensagem que diz o porquê e aponta para o app.
- **Motivação:** (1) MV3 proíbe código hospedado remotamente, e a IFrame API do YouTube é
  exatamente isso — `https://www.youtube.com/iframe_api` injetado como `<script>` não
  carrega sob a CSP de página de extensão, e carregá-lo por qualquer desvio é política
  violada na Chrome Web Store. (2) Mesmo que carregasse, a entrega do YouTube é `local`
  por impossibilidade técnica (§6.9): **cada** participante toca o vídeo na própria
  máquina, sincronizado por posição. O motor é uma máquina só; não há nada que ele possa
  tocar em nome da sala.
- **Alternativa descartada:** `<iframe>` remoto do `youtube.com/embed` controlado por
  `postMessage` escrito à mão. Tecnicamente possível (iframe remoto não é código remoto),
  mas é reimplementar uma API não documentada para chegar num áudio que continua não
  podendo ser capturado. Zero ganho.

### 3.10 Música com CORS; soundboard com permissão de host — e é aqui que o MyInstants passa a tocar — **pede aval**

- **Decisão:**
  - **Música** (arquivo local e URL): caminho idêntico ao do app — `MusicEngine`, `<audio>`
    + `createMediaElementSource`, sonda `Range: bytes=0-0` antes de tocar. URL sem CORS é
    **recusada com mensagem**, como hoje.
  - **Soundboard**: `SoundboardPlayer` recebe um `fetchImpl` injetado pela extensão. Quando
    o `fetch` falha por CORS, a UI oferece **um botão** que chama
    `chrome.permissions.request({origins: ['https://host/*']})`; concedida a permissão, o
    download e o `decodeAudioData` passam a funcionar para aquele host.
- **Motivação:** a assimetria é proposital e tem uma razão física. O `SoundboardPlayer` já
  é `fetch` → `decodeAudioData` → `AudioBufferSourceNode`, e é sobre `fetch` que a
  permissão de host da extensão dá poder. O `MusicEngine` depende do **elemento de mídia**
  com `crossOrigin='anonymous'`, e o privilégio de host da extensão **não** cobre a
  checagem de CORS de um elemento `<audio>` — o grafo ficaria *tainted* e o
  `MediaStreamDestination` emitiria silêncio digital, sem erro (armadilha nº 2 de
  `musicEngine.ts`). Converter a música para o caminho de buffer resolveria o CORS e
  quebraria três coisas: memória (uma faixa de 5 minutos decodificada é ~50 MB de PCM),
  `seek` e posição (um `AudioBufferSourceNode` não tem `currentTime`) e o *streaming*
  progressivo. Para um efeito de até 15s, nada disso importa.
- **O que isso desbloqueia, e por que pede aval:** **o MyInstants passa a tocar na
  extensão.** O §9 do `ARCHITECTURE.md` registra que servir aquele áudio exigiria um proxy
  no servidor de sinalização, com tudo que isso expande no que o servidor faz e sabe — e
  que a decisão é de produto e está em aberto. A extensão chega ao mesmo resultado **sem
  servidor nenhum**, porque o download passa a ser feito pelo navegador de quem dispara,
  com permissão que essa pessoa concedeu explicitamente, host a host. O aval que se pede
  aqui é sobre o alcance da permissão: `optional_host_permissions` com `*://*/*` é a forma
  que permite qualquer host, e é também a que aparece na revisão da loja como permissão
  ampla. A alternativa é uma allowlist fixa (`https://www.myinstants.com/*` e mais um
  punhado), que é modesta e envelhece mal.
- **Registro obrigatório:** decidir isto **não** decide o proxy do app. O proxy continua em
  aberto para quem usa o wtk-meet sem extensão, e o `arch-temp-soundboard-myinstants.md`
  §3.1 continua valendo como a análise daquela decisão.

### 3.11 Duas superfícies: popup para controle, página `manager` para o resto — **pede aval (custo de escopo)**

- **Decisão:** `popup.html` (conectar, transporte, volume, disparar favoritos, aprovar
  entradas) e `manager.html`, aberta numa aba pela ação "Gerenciar" do popup (fila,
  adicionar arquivo/URL, editar favoritos, nome, URLs, permissões).
- **Motivação:** o popup **fecha quando perde o foco**, e abrir um seletor de arquivo tira
  o foco dele. Um `<input type="file">` (ou `showOpenFilePicker`) dentro do popup é a
  receita conhecida de "o diálogo abre, o popup morre, a promessa nunca resolve e o arquivo
  some" — e o `pickAudioFile` do client usa exatamente essas duas APIs. Uma aba comum não
  tem esse problema, e ainda dá espaço para uma fila que não cabe em 360 px.
- **Alternativa descartada:** só popup, com o seletor de arquivo. Funciona em algumas
  versões do Chrome e em algumas plataformas — que é a pior categoria de recurso.
- **Se o aval for por menos escopo:** corte a `manager` e entregue **sem arquivo local**
  (só URL), mantendo tudo no popup. É a redução coerente; cortar só a página e manter o
  seletor no popup é a combinação que não funciona.

### 3.12 Popup e motor conversam por porta (`chrome.runtime.connect`), não por mensagens soltas

- **Decisão:** o popup (e a `manager`) pedem ao service worker `ensure-engine` — que
  garante o documento offscreen — e só então abrem uma porta `chrome.runtime.connect({name:
  'wtk-engine'})`. O documento offscreen aceita a porta, manda um snapshot completo na hora
  e passa a empurrar deltas **enquanto a porta estiver aberta**. Fechar o popup desconecta
  a porta e o motor volta a ficar mudo (sem parar de tocar).
- **Motivação:** `chrome.runtime.sendMessage` sem receptor rejeita com *"Could not establish
  connection. Receiving end does not exist"* — que é o erro mais frequente de extensão MV3
  e vira `unhandledrejection` toda vez que o motor tenta empurrar estado com o popup
  fechado. A porta resolve isso por construção: existe ou não existe, e o `onDisconnect`
  avisa. De quebra, a posição da faixa (que muda a cada 250 ms) só é calculada e enviada
  quando há alguém olhando.
- **Detalhe de plataforma que precisa estar no código:** `chrome.runtime.connect` alcança
  **todos** os contextos da extensão; o service worker também recebe `onConnect`. Cada
  lado filtra pelo `port.name`, e toda mensagem carrega `target: 'engine' | 'ui' | 'sw'`.

### 3.13 O que persiste, onde, e o que morre junto com a sessão

- **Decisão:**
  | Dado | Onde | Por quê |
  |---|---|---|
  | Favoritos do soundboard | `chrome.storage.local`, chave `wtk-meet:soundboard` | Mesma forma e mesma versão de esquema do app, por um adaptador síncrono (§5) sobre o `soundboard.ts` |
  | Última sala, nome de exibição, URL de sinalização/app, volume | `chrome.storage.local` | Preferência de quem instalou, análoga a `wtk-meet:devices` |
  | Fragmento (`#passphrase`) de um link colado | `chrome.storage.session` | É segredo de terceiro que a extensão não usa; morre quando o navegador fecha |
  | Arquivos de áudio da fila | IndexedDB `wtk-soundboard`, via `audioFileStorage.ts` | Mesma origem para popup, `manager` e offscreen; é o único caminho que sobrevive ao fechamento do popup |
  | Fila, faixa corrente, posição, peers, pedidos pendentes | memória do documento offscreen | Estado vivo; some com o motor, como a sala do app some com a aba |
- **Motivação (o item que não é óbvio):** um `URL.createObjectURL(file)` criado no popup é
  **revogado quando o documento que o criou é descarregado** — ou seja, quando o popup
  fecha, o áudio para. E `chrome.runtime.sendMessage` serializa como JSON: `File` e `Blob`
  não atravessam. O IndexedDB da própria origem resolve os dois de uma vez, e o módulo que
  faz isso já existe no client, testado e degradando em silêncio quando o IndexedDB não
  está disponível.
- **O que **não** persiste, de propósito:** nenhuma lista de participantes, nenhum
  histórico do que tocou, nenhum código de reunião além do último endereço usado (que o
  usuário apaga com um clique).

### 3.14 O motor ouve só o canal de música dos outros; voz e vídeo, nunca

- **Decisão:** o `WebRTCMesh` do motor implementa `onRemoteMusic` (toca num `<audio>`
  oculto do documento offscreen) e **ignora** `onRemoteStream` e `onRemoteScreen`.
- **Motivação:** duas razões, e cada uma bastaria. **Privacidade:** um documento invisível,
  sem entrada na barra de abas e sem controle de volume do navegador, reproduzindo a voz de
  uma sala é algo que o usuário não vê, não controla e não desconfia. **Eco:** a conversa
  acontece no Meet; trazer a mesma voz por um segundo caminho é *feedback* garantido para
  quem estiver com caixa de som aberta.
- **Consequência:** duas extensões na mesma sala ouvem a música uma da outra (é o que se
  quer) e nada mais.

### 3.15 Build com `esbuild`, sem dependência de runtime nova

- **Decisão:** `packages/extension/build.ts` roda no Node (type stripping nativo, como
  `packages/e2e/run.ts` já faz) e chama o `esbuild` que **já é devDependency da raiz**: três
  bundles independentes (`background`, `offscreen`, `popup`/`manager`), `format: 'esm'`,
  `splitting: false`, mais a cópia de `manifest.json`, dos `.html`, do CSS e dos ícones para
  `dist/`. `react`/`react-dom` entram como dependência **do pacote**, nas mesmas versões do
  client.
- **Motivação:** `splitting: false` não é detalhe: um service worker de módulo com chunks
  compartilhados é a forma mais fácil de descobrir, em produção, que um `import` dinâmico
  não resolve sob `chrome-extension://`. Três bundles autocontidos custam alguns KB
  duplicados e nunca falham assim. E nenhuma ferramenta nova entra na árvore — a mesma
  troca que o §7 do `ARCHITECTURE.md` vem defendendo desde a WTK-MEET-20.
- **Alternativa descartada:** Vite com plugin de extensão (`@crxjs` e parentes). Traz
  dependência nova, opinião sobre HMR em contexto de extensão e um gerador de manifest
  entre o autor e o arquivo que o Chrome lê.

---

## 4. Componentes Afetados

### Novo workspace: `packages/extension`

| Arquivo | O que é | Por quê |
|---|---|---|
| `package.json` | Workspace `wtk-meet-extension`, privado; scripts `build`, `test`, `typecheck`, `lint`; deps `react`, `react-dom`, `socket.io-client` | Entra na raiz como quarto workspace (§6) |
| `tsconfig.json` | Estende `tsconfig.base.json`; `lib: ES2023 + DOM + DOM.Iterable`, `types: ['node', 'chrome']`, `moduleResolution: 'Bundler'`, `noEmit` | Mesmo rigor dos outros três; `@types/chrome` é devDependency |
| `eslint.config.js` | Espelho do config do client, sem a parte de worklet, com `globals.webextensions` | Flat config resolve plugins a partir do próprio diretório |
| `build.ts` | Script de build com esbuild + cópia de estáticos | §3.15 |
| `manifest.json` | MV3 (§5) | O arquivo que o Chrome lê |
| `src/background.ts` | Service worker: ciclo de vida do offscreen, roteamento, badge | §3.1, §3.8 |
| `src/offscreen.ts` + `offscreen.html` | **O motor**: `AudioContext`, `MusicEngine`, `SoundboardPlayer`, `WebRTCMesh`, sinalização, fila, estado | §3.1 |
| `src/engine/room.ts` | Entrar/sair da sala, pedidos pendentes, peers, `setMusicTrack` | §3.2, §3.4, §3.8 |
| `src/engine/queue.ts` | Fila sobre `musicSession.ts`, escritor único | §3.2 |
| `src/engine/soundboard.ts` | Disparo, rate limit de saída, anúncio `soundboard-play` | §3.10 |
| `src/lib/signaling.ts` | Cliente Socket.IO próprio, `transports: ['websocket']` | §3.5, §3.6 |
| `src/lib/config.ts` | URLs (sinalização, app) lidas de `chrome.storage.local`, com default de build | §3.6 |
| `src/lib/storage.ts` | Adaptador síncrono `PreferenceStorage` sobre `chrome.storage.local` | §3.13 |
| `src/lib/meetCode.ts` | **Módulo puro**: URL do Meet → path de sala | §3.7 |
| `src/lib/protocol.ts` | **Módulo puro**: união discriminada das mensagens entre contextos e o tipo `EngineState` | §3.12 |
| `src/popup.tsx` + `popup.html` + `popup.css` | UI de controle | §3.11 |
| `src/manager.tsx` + `manager.html` | UI de gestão | §3.11 |
| `icons/` | 16/32/48/128 px | Exigência do manifest |
| `test/*.test.ts` | `node --test` sobre os módulos puros | §6, §8 |
| `README.md` | Como carregar sem compactação, configurar o servidor e depurar o offscreen | §9 |

### Reusado de `packages/client` (import relativo, sem edição)

| Módulo | Como é usado |
|---|---|
| `lib/musicEngine.ts` | Instanciado com `getContext` do `AudioContext` do offscreen; `ensureOutput()` antes de `setMusicTrack` |
| `lib/soundboardPlayer.ts` | `getOutput` aponta para o mesmo destination; `fetchImpl` injetado (§5) |
| `lib/soundboard.ts` | Favoritos, validação e limites, com o storage adaptado |
| `lib/soundboardRate.ts` | Limitador de saída (3 disparos / 5s) |
| `lib/musicSources.ts` | `parseSource(raw, { allowYouTube: false })`, `parseFileSource`, `formatDuration`, `SOURCE_ERRORS` |
| `lib/musicSession.ts` | Fila: `addEntry`, `removeEntry`, `orderedQueue`, `planAdvance`, limites |
| `lib/musicProtocol.ts` | `soundboardPlayMessage` na saída; `sanitizeMusicMessage` na entrada (para descartar com critério) |
| `lib/webrtcMesh.ts` | Instanciado **sem** `getRoomKey`, sem `localStream`, com `onRemoteMusic` apenas |
| `lib/iceServers.ts` | `configureIceServers({ endpoint })` com a URL configurada; `getIceServers` vai por injeção ao mesh |
| `lib/audioFileStorage.ts` | `saveAudioFile`/`loadAudioFile`/`removeAudioFile` no IndexedDB da origem da extensão |
| `lib/roomSlug.ts` | `normalizeRoomPath`, `isValidRoomPath`, `buildRoomUrl` |

### Raiz do repositório

- `package.json`: `packages/extension` entra em `workspaces`, e nos scripts `build`,
  `test`, `typecheck` e `lint` (os quatro listam workspaces explicitamente hoje — esquecer
  um deles é a forma de a CI ficar verde sobre código que nunca foi olhado).
- `.github/workflows/ci.yml`: nenhuma mudança necessária (os jobs chamam os scripts da
  raiz), **desde que** o item acima seja feito.

### Documentação

- `ARCHITECTURE.md`: nova **§11 — Extensão Chrome (motor de áudio único)**; uma linha na
  tabela do §5 sobre nomes de sala derivados de código de reunião (§3.7); `packages/extension`
  na árvore do §8; e no §9, a substituição do parágrafo do MyInstants por uma versão que
  registra que **na extensão o efeito toca** (§3.10) e que o proxy do app continua em aberto.
- `README.md`: seção "Extensão Chrome" — instalar, apontar para o servidor, as duas formas
  de liberar o CORS (§3.6), e a frase explícita de que a extensão **não** aplica a camada
  extra de E2EE.
- `CHANGELOG.md`: entrada em `Adicionado`.
- `docs/progress/WTK-MEET-26.md`: decisões tomadas na implementação, o que foi verificado
  empiricamente no Chrome (§9) e o que divergiu deste documento.

---

## 5. Contratos de Interface

### `manifest.json` (MV3)

| Campo | Valor | Observações |
|---|---|---|
| `manifest_version` | `3` | |
| `name` / `version` | `wtk-meet` / igual à do repositório | O workflow de release versiona todos os workspaces |
| `minimum_chrome_version` | `116` | `chrome.offscreen` estabilizou nessa faixa; confirmar e registrar |
| `action.default_popup` | `popup.html` | Com popup definido, `chrome.action.onClicked` **não dispara** |
| `background` | `{ "service_worker": "background.js", "type": "module" }` | |
| `permissions` | `["offscreen", "storage", "activeTab"]` | Três, e cada uma se justifica sozinha |
| `optional_host_permissions` | `["*://*/*"]` (§3.10, pede aval) | Pedida em gesto, host a host |
| `icons` | 16/32/48/128 | |
| `content_security_policy` | ausente | O default do MV3 já proíbe código remoto; declarar algo mais frouxo é o erro |

### Mensagens entre contextos (`chrome.runtime`)

Toda mensagem é `{ target, type, ... }`. `target` é o filtro obrigatório: `runtime` entrega
a todos os contextos, e um listener que não filtra responde por engano.

| `target` | `type` | Payload | Emissor → receptor |
|---|---|---|---|
| `sw` | `ensure-engine` | — | popup/manager → SW. Resolve quando o documento offscreen existe |
| `sw` | `badge` | `{ pending: number, playing: boolean }` | offscreen → SW |
| `engine` | `connect` | `{ roomPath, displayName, signalingUrl }` | UI → offscreen (pela porta) |
| `engine` | `disconnect` | — | UI → offscreen |
| `engine` | `queue-add` | `{ kind: 'url', sourceRef } \| { kind: 'file', fileId, title }` | UI → offscreen |
| `engine` | `queue-remove` | `{ entryId }` | UI → offscreen |
| `engine` | `transport` | `{ action: 'play' \| 'pause' \| 'skip' \| 'seek', positionSec? }` | UI → offscreen |
| `engine` | `volume` | `{ value: 0..1 }` | UI → offscreen. **Local, nunca trafega** |
| `engine` | `soundboard-fire` | `{ favoriteId }` | UI → offscreen |
| `engine` | `join-decision` | `{ requesterId, approve: boolean }` | UI → offscreen (§3.8) |
| `ui` | `state` | `EngineState` (snapshot completo) | offscreen → UI, no `onConnect` |
| `ui` | `patch` | `Partial<EngineState>` | offscreen → UI, enquanto houver porta |
| `ui` | `notice` | `{ kind: 'error' \| 'info', text }` | offscreen → UI. Mensagens de `SOURCE_ERRORS`/`SOUNDBOARD_ERRORS`, sem inventar texto novo |

`EngineState` (o que a UI precisa para renderizar, e nada além): `status` (`'idle' |
'connecting' | 'waiting-approval' | 'connected' | 'denied' | 'error'`), `roomPath`,
`peers: {id, displayName}[]`, `pendingJoins: {requesterId, displayName}[]`, `queue:
QueueEntry[]`, `current: {entryId, title, positionSec, durationSec, playing} | null`,
`favorites: Favorite[]`, `volume`, `cooldownMs`, `lastError`.

### Protocolo da sala (o que sai e o que entra no `RTCDataChannel` `wtk-chat`)

| Mensagem | Direção | Observações |
|---|---|---|
| `soundboard-play` `{ soundId, title, durationMs }` | **sai** | Construída por `soundboardPlayMessage`; vai **antes** do `start()` do buffer, no mesmo tique (§6.13) |
| `state` `{ displayName, cameraOff: true, micOff: true, screenOn: false }` | **sai** | `setLocalState` no `WebRTCMesh` |
| `music-*`, `chat`, `soundboard-play` de outros | **entram e são descartadas** | Passam por `sanitizeMusicMessage` e caem num `default` explícito — descartar sem sanitizar seria aceitar forma desconhecida |
| `music-snapshot` sob demanda | **não sai** | `getMusicSnapshot` do mesh devolve `null` na extensão (§3.2) |

### Sinalização (Socket.IO — os mesmos eventos de hoje, nenhum novo)

| Evento | Direção | Payload |
|---|---|---|
| `join-request` | emite | `{ roomId, displayName }` |
| `join-request` | recebe | `{ requesterId, displayName }` → vira `pendingJoins` (§3.8) |
| `join-request-cancelled` | recebe | `{ requesterId }` → remove de `pendingJoins` |
| `approve-join` / `deny-join` | emite | `{ requesterId }`, só por ação humana no popup |
| `join-denied` | recebe | `{ reason }` → `status: 'denied'`, com `room-full` traduzido |
| `join-approved` | recebe | `{ selfId, members }` → `status: 'connected'`; `selfId` alimenta o `getSelfId` do mesh |
| `signal`, `peer-joined`, `peer-left` | ambos | Repassados ao `WebRTCMesh` como no `Room.tsx` |

### Adaptadores que a extensão precisa escrever (contrato, não implementação)

- **`PreferenceStorage` sobre `chrome.storage.local`.** `soundboard.ts` espera um objeto
  *storage-like* **síncrono** (`getItem`/`setItem`). O adaptador hidrata um cache em
  memória **antes** do primeiro uso (o boot do offscreen e o boot de cada página de UI
  aguardam essa promessa), lê do cache e escreve *write-through*. `chrome.storage.onChanged`
  atualiza o cache nos outros contextos — é o que mantém popup, `manager` e motor com a
  mesma lista de favoritos.
- **`fetchImpl` do `SoundboardPlayer`.** O módulo chama `fetch(url, { method, headers, mode:
  'cors', cache: 'no-store' })`. O adaptador **remove `mode`** antes de repassar: sob
  permissão de host, o privilégio da extensão é o que autoriza a leitura, e um `mode: 'cors'`
  explícito é um pedido para o navegador exigir `Access-Control-Allow-Origin` que o
  MyInstants não manda. Quando o `fetch` rejeita, o erro sobe como `SoundboardError` com
  razão `cors`, e a UI oferece o botão de permissão.
- **`getContext` do `MusicEngine`.** Um `AudioContext` único do documento offscreen, criado
  no boot e nunca fechado enquanto o motor viver — a mesma regra de `audioContext.ts`, pelo
  mesmo motivo (nós de contextos diferentes não se conectam).

---

## 6. Dependências e Ordem de Implementação

A ordem abaixo é escolhida para que **cada passo seja verificável sozinho**. Os passos 1–3
não tocam em áudio nem em rede; o passo 4 é o primeiro que faz som; o 6 é o primeiro que
faz som *na sala*.

1. **Andaime do workspace** — `package.json`, `tsconfig.json`, `eslint.config.js`,
   `build.ts`, `manifest.json`, ícones, `offscreen.html`/`popup.html` vazios, workspace na
   raiz. *Verificação:* `npm run build`, `npm run typecheck` e `npm run lint` verdes na
   raiz, e a extensão **carrega** em `chrome://extensions` sem erro.
   *Nada depende de nada — comece aqui.*
2. **Módulos puros** — `meetCode.ts` e `protocol.ts`, com `node --test`.
   *Verificação:* testes verdes; `npm test` na raiz já os executa.
   *Pode rodar em paralelo com o 3.*
3. **Ciclo de vida e transporte** — service worker (`ensure-engine` com guarda contra a
   corrida do `createDocument`), documento offscreen vazio, porta, `EngineState` mínimo,
   popup que só mostra `status`. *Verificação:* abrir e fechar o popup dez vezes; o
   documento offscreen continua um só (`chrome://extensions` → "service worker" e
   "documento offscreen" na lista de views).
4. **Motor de áudio local** — `AudioContext`, `MusicEngine`, fila sobre `musicSession`,
   arquivo local via IndexedDB, URL com CORS, transporte no popup.
   *Verificação:* **sai som do navegador com o popup fechado**, e a fila sobrevive a
   fechar/abrir o popup. Depende de 1–3.
5. **Soundboard local** — `SoundboardPlayer`, favoritos com o adaptador de storage, rate
   limit, o pedido de permissão de host. *Verificação:* um efeito toca; um efeito de host
   sem CORS recusa **com mensagem** e passa a tocar depois da permissão concedida. Depende
   de 4 (usa o mesmo destination).
6. **Sala** — sinalização, `WebRTCMesh`, `setMusicTrack` uma vez, `onRemoteMusic`,
   `join-request`/badge/aprovação. *Verificação:* com o app aberto noutra janela, a sala
   ouve a música e o efeito da extensão; o anúncio aparece no painel do app com autoria.
   Depende de 4 e 5.
7. **Pré-preenchimento do Meet** — `activeTab`, `chrome.tabs.query`, `meetCode.ts` ligado ao
   campo. Depende de 2 e 3.
8. **Página `manager`** — fila completa, favoritos, configuração, permissões. Depende de 4–6.
9. **Documentação** — `ARCHITECTURE.md` §11 e as linhas de §5/§8/§9, `README.md`,
   `CHANGELOG.md`, `docs/progress/WTK-MEET-26.md`. Depende de tudo, e **não** é opcional:
   metade das decisões acima só existe como decisão se estiver escrita.

---

## 7. Riscos e Armadilhas

### 7.1 A camada de E2EE volta no app e a extensão emudece sem erro

- **Risco:** `makeDecryptTransform` **descarta** o quadro quando a decifragem falha. Ligar a
  E2EE no `Room` sem tratar a extensão faz o áudio dela sumir para todo mundo, sem log, sem
  toast, sem `onerror`. O tile continua lá, o `connectionState` continua `connected`.
- **Mitigação:** um comentário-âncora no `pages/Room.tsx`, ao lado das linhas comentadas de
  `deriveRoomKey`/`getRoomKey`, dizendo que religar exige decidir o que acontece com
  `packages/extension` — e um critério de aceite (§8) que exige esse comentário.
- **Anti-pattern a evitar:** dar à extensão a passphrase "só para não quebrar". Ela
  passaria a manusear a chave da sala num documento invisível, persistido em
  `chrome.storage`, para não usá-la em mais nada. Se a E2EE voltar, a decisão é entre
  *derivar de verdade* (com a passphrase vindo do link colado, em `storage.session`) e
  *declarar a extensão incompatível* — não um meio-termo.

### 7.2 O documento offscreen é fechado pelo Chrome no meio da sessão

- **Risco:** o Chrome documenta fechamento automático para alguns motivos de offscreen
  (notadamente `AUDIO_PLAYBACK`, após um período sem áudio). Um fechamento leva junto o
  socket, o mesh e a sala — e o usuário vê "conectado" num popup que não reflete mais nada.
- **Mitigação:** criar o documento com `reasons: ['WEB_RTC', 'AUDIO_PLAYBACK']` nessa ordem;
  tratar `port.onDisconnect` como perda do motor e mostrar "o motor caiu — reconectar"; e
  **medir**: deixar o motor conectado e ocioso por 15 minutos, e registrar em
  `docs/progress/WTK-MEET-26.md` o que o Chrome fez. Este é o primeiro item da lista de
  verificação empírica do §9.
- **Anti-pattern a evitar:** um `setInterval` no service worker "para manter vivo". Não
  mantém (o SW não é o dono do documento), esconde o problema e queima bateria.

### 7.3 Duas chamadas concorrentes a `chrome.offscreen.createDocument`

- **Risco:** só pode existir um documento; a segunda chamada **lança**. Dois cliques
  rápidos, ou o popup e a `manager` abertos juntos, reproduzem isso na primeira semana.
- **Mitigação:** um *singleton de promessa* no service worker — a primeira chamada guarda a
  promessa, as demais aguardam a mesma; `chrome.offscreen.hasDocument()` antes, e `catch`
  do erro de "já existe" tratado como sucesso. Lembrando que o SW pode ser reiniciado entre
  as duas chamadas, então a guarda em memória **não** basta sozinha: o `hasDocument()` é
  quem decide.

### 7.4 APIs de extensão que não existem no documento offscreen

- **Risco:** o documento offscreen tem acesso a um subconjunto pequeno da API de extensão.
  `chrome.action`, `chrome.tabs`, `chrome.permissions` e `chrome.notifications` não são
  dele. Um `chrome.action.setBadgeText` lá dentro é `TypeError` em runtime, não erro de
  compilação — `@types/chrome` tipa tudo como se estivesse disponível em toda parte.
- **Mitigação:** regra de uma linha, escrita no topo de `offscreen.ts`: **o motor só fala
  `chrome.runtime` e `chrome.storage`**; qualquer outra API é pedida ao service worker por
  mensagem (`target: 'sw'`). O badge do §3.8 é o caso concreto.

### 7.5 `mode: 'cors'` derrota a permissão de host

- **Risco:** o `probe`/`load` do `SoundboardPlayer` pede `mode: 'cors'` explicitamente. Com
  esse modo, o navegador exige `Access-Control-Allow-Origin` mesmo com permissão de host —
  e o MyInstants continua recusado depois de o usuário ter concedido a permissão, o que lê
  como "a permissão não funcionou".
- **Mitigação:** o `fetchImpl` adaptador (§5) remove `mode` antes de repassar. **Teste
  dedicado** com um `fetchImpl` dublê verificando que o `mode` não chega ao `fetch`.
- **Anti-pattern a evitar:** editar `soundboardPlayer.ts` no client para tirar o `mode`.
  No app, `mode: 'cors'` é o que faz a sonda ser honesta; removê-lo lá recria o silêncio
  digital que o módulo inteiro existe para evitar.

### 7.6 Silêncio digital pelo caminho do elemento de mídia

- **Risco:** tentar "aproveitar" a permissão de host para tocar uma URL sem CORS pelo
  `MusicEngine`. O `<audio crossOrigin="anonymous">` fica *tainted*, o
  `MediaStreamDestination` emite silêncio e **quem disparou ouve normalmente** pelo ramo de
  monitoração — o relato que chega é "a sala diz que não ouve, mas aqui toca".
- **Mitigação:** manter a sonda `probeDelivery` como porteiro e recusar com a mensagem de
  `SOURCE_ERRORS`; §3.10 explica a assimetria com o soundboard, e ela precisa estar no §11
  do `ARCHITECTURE.md`.

### 7.7 A extensão ocupa uma das seis vagas

- **Risco:** `MAX_PARTICIPANTS` é 6 no servidor **e** no client. Com o motor dentro, a sala
  comporta 5 pessoas; com dois motores, 4. `join-denied { reason: 'room-full' }` chega sem
  explicar isso a ninguém.
- **Mitigação:** a UI traduz `room-full` citando a vaga que a extensão ocupa, e o README diz
  a mesma coisa. **Não** mexa no teto: ele é requisito de mesh (§2 do `ARCHITECTURE.md`),
  não um número solto.

### 7.8 Áudio vindo de lugar nenhum

- **Risco:** o documento offscreen não aparece na barra de abas e não tem o ícone de
  "silenciar aba". Um motor esquecido tocando é áudio que o usuário não sabe de onde vem e
  não sabe como parar — e o caminho que ele vai encontrar é desinstalar a extensão.
- **Mitigação:** badge no ícone enquanto toca (§3.8 já pinta o badge para pedidos
  pendentes; o mesmo canal serve), `title` da ação dizendo o que está tocando, e "parar"
  como primeiro botão do popup. E nada de reconectar sozinho em `chrome.runtime.onStartup`:
  conectar é sempre ato explícito.

### 7.9 O contrato de sinalização passa a estar escrito em dois lugares

- **Risco:** `packages/extension/src/lib/signaling.ts` duplica os nomes de evento de
  `packages/client/src/lib/signaling.ts` (§3.5). Renomear um evento no client e no servidor
  deixa a extensão silenciosamente fora da sala.
- **Mitigação:** comentário de cabeçalho nos **dois** arquivos apontando um para o outro e
  para o §4 do `ARCHITECTURE.md`; e um teste na extensão que afirma a lista de nomes de
  evento — um teste de caracterização, que falha quando alguém renomeia sem procurar.
- **Anti-pattern a evitar:** "resolver" isso importando `config.ts` do client. Ele executa
  `configureTelemetry` no import e liga a extensão ao beacon do app (§3.5).

### 7.10 Autoplay e `AudioContext` suspenso sem gesto

- **Risco:** o documento offscreen não tem gesto do usuário. O `AudioContext` pode nascer
  `suspended` e `element.play()` pode rejeitar — e `MusicEngine` traduz isso em `onBlocked`,
  que sem tratamento vira "não toca e ninguém sabe por quê".
- **Mitigação:** `onBlocked` vira `notice` na UI com um botão "tocar" (o clique acontece no
  popup, e o motor reage a ele); `ctx.resume()` a cada comando de transporte. É o segundo
  item da lista de verificação empírica do §9 — se o Chrome isentar páginas de extensão da
  política de autoplay, o caminho fica sem uso, mas continua sendo a rede de segurança.

### 7.11 O endereço da sala é adivinhável a partir do código da reunião

- **Risco:** §3.7. Quem tem o código do Meet tem o endereço da sala, e
  `GET /rooms/:roomId/occupancy` responde se há gente agora.
- **Mitigação:** o §4 (aprovação humana) é a defesa efetiva, e §3.8 garante que a extensão
  não a enfraquece. O README precisa dizer, em uma frase, que a sala de áudio herda o
  sigilo do código da reunião — nem mais, nem menos.

### 7.12 Deriva entre a telemetria e a realidade

- **Risco:** o motor é um socket na sala. Os gauges derivados do `RoomStore` (§10.4) passam
  a contar a extensão como participante, e `wtk_room_peak` sobe em salas que têm as mesmas
  pessoas de antes.
- **Mitigação:** uma linha no §10 do `ARCHITECTURE.md` registrando isso. **Não** crie campo
  novo no `join-request` para marcar "sou bot": seria metadado novo no servidor, contra o
  §5, para corrigir um número que ninguém usa para decidir nada.

### 7.13 Deriva de documentação

- **Risco:** este documento é temporário; o `ARCHITECTURE.md` é o que alguém desconfiado lê
  primeiro. Uma extensão que entra sem E2EE e nomeia salas com código de reunião, **não**
  descrita lá, é uma contradição silenciosa com o §1 e com a tabela do §5.
- **Mitigação:** §8 exige a §11 escrita e as três linhas em §5/§8/§9 **na mesma entrega**.

---

## 8. Critérios de Aceite Técnicos

**Motor e ciclo de vida**

1. Com a extensão carregada e nenhum popup aberto, tocar uma faixa e fechar o popup: o áudio
   continua, e `chrome://extensions` mostra **exatamente um** documento offscreen.
2. Abrir o popup em duas janelas diferentes do navegador: as duas mostram a **mesma** fila,
   a mesma faixa corrente e a mesma posição; um "pausar" numa aparece na outra em ≤1s.
3. Encerrar o service worker à força (`chrome://serviceworker-internals` ou os 30s de
   ociosidade) **não** interrompe o áudio nem derruba a sala.
4. Fechar o popup enquanto uma faixa toca e reabrir: o snapshot chega completo no
   `onConnect`, sem estado "meio preenchido" na tela.

**Sala**

5. Com um participante no app e o motor conectado, uma faixa tocando na extensão é ouvida no
   app **sem** nenhuma votação de player e **sem** o painel de música aberto.
6. O tile do motor aparece no app com o nome configurado, câmera desligada e sem anel de
   fala — e o indicador de "falando" **não** acende por causa da música.
7. Um efeito disparado na extensão aparece no painel do app com autoria e título, e o
   silenciamento daquele peer no app emudece o efeito pela janela esperada.
8. Chegar um pedido de entrada com o popup fechado: o badge do ícone mostra a contagem; o
   popup lista o pedido; "Aprovar" admite e "Negar" recusa; o pedido some quando o servidor
   emite `join-request-cancelled`.
9. Sala cheia devolve `join-denied { reason: 'room-full' }` e a UI explica que a extensão
   ocupa uma vaga.
10. Desconectar solta o track, fecha o socket e **não** deixa `RTCPeerConnection` viva
    (verificável em `chrome://webrtc-internals`).

**Origens e recusas**

11. URL de áudio com CORS toca e é ouvida pela sala. URL **sem** CORS é recusada com a
    mensagem de `SOURCE_ERRORS` — nunca com silêncio.
12. Link de YouTube é recusado com mensagem que diz que a origem só existe no app.
13. URL do MyInstants como favorito: antes da permissão, recusa com mensagem e o botão de
    permitir; depois de concedida, o efeito toca e a sala ouve.
14. Arquivo local adicionado na página `manager` toca depois de a página ser fechada (o
    `Blob` vem do IndexedDB, não de um object URL do documento que fechou).
15. Estourar o limite de 3 disparos em 5s desabilita o botão e mostra o tempo restante.

**Pré-preenchimento**

16. Com uma aba `https://meet.google.com/abc-defg-hij` ativa, o popup abre com
    `meet-abc-defg-hij` no campo. Com `meet.google.com` sem código, com
    `/lookup/...` ou com qualquer outra aba, o campo traz a última sala usada.
17. `meetCode.ts` tem teste para: código válido, `?authuser=1` na URL, caixa alta, URL de
    outro domínio, `about:blank`, `chrome://extensions` e `undefined` (aba sem URL legível).

**Repositório**

18. `npm run lint`, `npm run typecheck`, `npm test` e `npm run build` na **raiz** passam e
    **incluem** o novo workspace (conferir na saída que `wtk-meet-extension` aparece nos
    quatro).
19. Nenhum arquivo em `packages/client` e `packages/server` é modificado — **exceto** o
    comentário-âncora de E2EE em `pages/Room.tsx` exigido pelo §7.1.
20. `ARCHITECTURE.md` tem a §11 e as linhas novas em §5, §8, §9 e §10; o README tem a seção
    da extensão com a frase explícita sobre ausência de E2EE; `docs/progress/WTK-MEET-26.md`
    registra o resultado das verificações empíricas do §9.

---

## 9. Notas para os Agentes de Implementação

**Divisão sugerida.** Os passos 1–3 do §6 (andaime, módulos puros, transporte) são um
agente; 4–5 (áudio local) são outro; 6–8 (sala, Meet, `manager`) são o terceiro. O passo 9
(documentação) é de quem fechar a entrega, com o `docs/progress` escrito **enquanto** se
implementa, não no fim.

**Lista de verificação empírica — obrigatória, e o resultado vai para o progresso.** Este
documento afirma quatro coisas sobre a plataforma que precisam ser medidas no Chrome de
hoje, não deduzidas:

1. **Tempo de vida do documento offscreen** com `reasons: ['WEB_RTC', 'AUDIO_PLAYBACK']`,
   conectado e ocioso por 15 minutos (§7.2).
2. **Política de autoplay** num documento offscreen sem gesto: o `AudioContext` nasce
   `running`? `element.play()` resolve? (§7.10).
3. **`activeTab` e a URL da aba** lida de dentro do popup, sem `host_permissions` para
   `meet.google.com` (§3.7). Se não funcionar, o plano B é `host_permissions:
   ["https://meet.google.com/*"]`, que é mais caro em revisão e precisa ser registrado.
4. **`fetch` com permissão de host, sem `mode: 'cors'`**, contra o MyInstants (§7.5).

**Pitfalls desta entrega que não estão na documentação geral do projeto:**

- Filtre `target` em **todo** listener de `chrome.runtime.onMessage` e `onConnect`: o
  runtime entrega a todos os contextos, inclusive ao próprio emissor em alguns casos.
- Nunca use `chrome.runtime.sendMessage` para empurrar estado do motor: use a porta (§3.12).
  Sem receptor, a promessa rejeita e vira `unhandledrejection`.
- `File`/`Blob` não atravessam mensagens de extensão (serialização JSON) e object URL morre
  com o documento que o criou. O caminho é IndexedDB (§3.13).
- Todo handle de timer é `ReturnType<typeof setTimeout>` — a regra do projeto, escrita no
  `tsconfig.json` do client, vale aqui pelo mesmo motivo (`@types/node` no mesmo programa).
- `esbuild` com `splitting: false` e três entradas; um `import()` dinâmico no service worker
  é a forma de descobrir tarde que um chunk não resolve sob `chrome-extension://`.
- Ao instanciar o `WebRTCMesh`, **não** passe `getRoomKey` (§3.3) e **não** passe
  `localStream`. Os quatro transceivers nascem do mesmo jeito e três ficam com track `null`
  — isso já é o caminho normal de quem entra com a câmera desligada.
- `mesh.setMusicTrack(track)` **uma vez**, depois de `engine.ensureOutput()` (§3.4). Se você
  se pegar escrevendo um `if` para saber se o soundboard está com o canal, pare: a decisão
  §3.4 existe para que esse `if` não precise existir aqui.

**Ordem de validação depois de implementar:** (1) `npm run typecheck` e `npm run lint` na
raiz; (2) `npm test` na raiz — os módulos puros da extensão entram aqui; (3) carregar
`packages/extension/dist` sem compactação e rodar os critérios 1–4 do §8; (4) subir servidor
e client locais (`npm run dev:server`, `npm run dev:client`, TURN obrigatório mesmo em
`localhost` — README §3) e rodar os critérios 5–10 com uma janela do app aberta; (5)
critérios 11–17; (6) `npm run test:e2e` **na base e depois na sua branch**, comparando com a
**sua** linha de base: a suíte é do app e não deve mudar de número por causa desta entrega —
se mudar, a causa está em algo que você tocou fora de `packages/extension`.

**O E2E automatizado da extensão fica de fora, e isso é uma escolha.** Playwright carrega
extensão só em contexto persistente e com janela, o que não combina com a suíte de 3
participantes que já roda hoje. O substituto é o roteiro manual acima, escrito passo a passo
em `docs/progress/WTK-MEET-26.md` — um roteiro que outra pessoa consiga repetir vale mais do
que um teste que ninguém consegue rodar.

**As três decisões que pedem aval antes de começar:** §3.7 (código do Meet como endereço da
sala, com a alternativa do hash pronta), §3.10 (alcance da permissão de host: `*://*/*` ou
allowlist) e §3.11 (a página `manager` existe, ou a entrega sai sem arquivo local). As três
mudam o escopo do que se implementa — as demais decisões não dependem delas.
