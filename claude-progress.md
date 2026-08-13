# Progresso — WTK-MEET-8: player de música colaborativo P2P

**Status: implementação concluída e validada.** Branch
`agent/wtk-meet-8-quero-adicionar-uma-funcionalidade-de-mu`.

Documento de arquitetura seguido: `docs/agents/arch-temp-player-musica-colaborativo.md`.

> O histórico das entregas anteriores está preservado abaixo, incluindo a receita
> de ambiente do E2E — que continua necessária **a cada sessão**, porque `/tmp`
> não persiste.

## Ponto de partida

Uma sessão anterior nesta mesma branch deixou os módulos puros commitados
(`musicSession`, `musicVote`, `musicSources`, `musicProtocol` + testes),
`audioContext.js` extraído, e `MusicVoteCard`/`RemoteMusicAudio` criados. O
`webrtcMesh.js` estava **no meio da edição**: importava `isMusicMessage` sem usar,
não criava o quarto transceiver, não roteava `music-*` e não tinha `setMusicTrack`.
Esta sessão continuou dali, seguindo a ordem do §6 do documento a partir do item 4.

## O que foi implementado

| Arquivo | Mudança |
|---|---|
| `client/src/lib/webrtcMesh.js` | Quarto transceiver `sendonly` de áudio criado **depois** do de tela; `_classifyTransceiver` estendido para `['audio','camera','screen','music']` na mesma edição; `rec.musicStream` + `onRemoteMusic`; `setMusicTrack` com `contentHint='music'` e `maxBitrate` de 96 kbps por conexão; roteamento de `music-*` para `onMusicMessage`; snapshot musical no `onopen` do canal |
| `client/src/lib/musicEngine.js` | **Novo.** Grafo WebAudio (`<audio>` → `MediaElementSource` → `MediaStreamDestination` + ramo de monitoração local), sonda de CORS por `Range: bytes=0-0`, ciclo de vida de `objectURL`, `play()` cuja rejeição vira aviso em vez de silêncio |
| `client/src/lib/youtubePlayer.js` | **Novo.** IFrame API carregada sob demanda (nada da Google no bundle), atrás de `VITE_ENABLE_YOUTUBE`, com a mesma superfície do motor (`play`/`pause`/`seek`/`positionSec`) |
| `client/src/lib/useMusicRoom.js` | **Novo.** Orquestração: votação com árbitro, fila convergente, escritor único da reprodução, sucessão determinística, correção de deriva e snapshot para quem entra depois |
| `client/src/components/MusicPanel.jsx` | **Novo.** Painel irmão do `ChatPanel`: faixa atual, progresso, fila, formulário (link/arquivo) e volume local |
| `client/src/components/MusicVoteCard.jsx` | Dispensar passou a ser explícito (`Esc` ou ✕) — ver "Desvios conscientes" |
| `client/src/pages/Room.jsx` | Hook de música ligado ao mesh, botão na barra, painel mutuamente exclusivo com o chat, overlays sempre montados, `selfId` em estado, `AudioContext` injetado no monitor e fechado pelo `Room` |
| `client/src/styles.css` | Painel, card de votação (z-index 25), fila, barra de progresso, host oculto do YouTube |
| `client/test/musicProtocol.test.mjs` | **Novo.** 12 casos de entrada hostil e de identidade |
| `client/test/joinRequestSignaling.test.mjs` | `SIGKILL` no teardown (ver "Nota de ambiente") |
| `e2e/{harness,run}.mjs` | Fixture de áudio WAV sintético; A2 atualizada para 4 canais por sentido; seção **N** com 10 checagens novas |
| `ARCHITECTURE.md`, `README.md`, `client/.env.example`, `docs/teste-3-participantes.md` | §6.8, limitações, flag do YouTube e checklist manual |

## Decisões que valem registrar

1. **Trocar de faixa é publicado pelo dono da faixa *seguinte*, nunca pelo da que
   acabou.** O documento fixa "escritor único", mas não diz quem escreve a
   transição — e as duas escolhas óbvias (o dono que terminou publica "parei"; o
   próximo publica "comecei") coexistindo dariam dois escritores disputando a
   mesma versão, com o "parei" podendo vencer por desempate de id. Um escritor
   por transição resolve; se a fila acabou, quem declara o silêncio é o dono da
   que terminou.
2. **A condição de "começar a próxima" é *a faixa corrente não existe mais na
   fila*, não *`entryId` é nulo*.** Quando alguém pula, o `entryId` continua
   apontando para uma entrada que já virou tombstone. Testar por nulo deixaria a
   sala parada com a fila cheia — e o sintoma seria "pular às vezes não faz nada".
3. **O padrão de entrega é `local`, e `stream` só entra com a sonda de CORS
   confirmando.** Errar para o lado do `local` custa banda; errar para o outro
   lado transmite **silêncio sem erro nenhum**, que é o modo de falha mais caro
   de diagnosticar deste recurso.
4. **A orquestração virou um hook (`useMusicRoom.js`) em vez de morar em
   `Room.jsx`.** O documento pede o estado no `Room`; ele já orquestra mídia,
   chat, toasts e pedidos de entrada, e somar a máquina de estados da música
   levaria o arquivo a ~1000 linhas. A fronteira é limpa: o hook não conhece JSX,
   o `Room` não conhece o protocolo.
5. **O container do player do YouTube é criado fora do React.** `YT.Player`
   substitui o elemento que recebe por um iframe; um nó trocado por baixo do
   React estoura no unmount. O React cuida do host, nós cuidamos do filho.

## Desvios conscientes do documento

**§3.6 — o card de votação não fecha mais por "clique fora".** O documento diz
"fecha por `Esc`/clique fora, sem votar". Implementado ao pé da letra, o efeito
era o oposto do pretendido: **silenciar o microfone com a votação aberta fazia a
pessoa perder o voto**, sem entender por quê. Num card fixo de canto, que não
intercepta clique nenhum, "clique fora" não significa "quis fechar" — significa
"usou a sala". Dispensar passou a ser explícito (`Esc` ou ✕), o que preserva a
intenção da decisão (abster-se é legítimo, a tela não é bloqueada) sem o efeito
colateral. A checagem N2 do E2E fixa isso: usar a sala com o card aberto não pode
custar o voto.

**Votação para pular não foi implementada**, conforme §3.7 — mas os módulos puros
já commitados suportam `kind: 'skip'` e o card já sabe renderizá-lo. É código
morto deliberado, pronto para quando/se a decisão mudar.

## Verificação executada

- `npm --prefix client run lint` → limpo
- `npm --prefix client test` → **95/95** (12 novos de `musicProtocol`; `audioLevels`
  e `gridLayout` verdes **sem edição**, como o documento exige)
- `npm --prefix client run build` → ok
- `node e2e/run.mjs` → **67/67** (57 anteriores + 10 da seção N)

Cobertura das checagens novas do E2E:

| Checagem | O que prova |
|---|---|
| N1 | "Música" entra na barra sem alterar o texto de nenhum botão existente |
| N2 | Card não-bloqueante: silenciar o mic com ele aberto funciona **e não custa o voto** |
| N3 | 2 sim + 1 não aprovam e habilitam o player nos três |
| N4 | Abrir a música fecha o chat e a página continua sem rolar (invariante §6.7) |
| N5 | Faixas de dois participantes na **mesma ordem** nos três |
| N6 | Áudio real chegando **no 4º canal**, medido por mid (`bytesReceived=4819`) |
| N7 | Silenciar o mic de quem transmite não interrompe a música (`4819 → 43138`) |
| N8 | Quem não é dono pula a faixa e a próxima assume nos três |
| N9 | Nenhuma mensagem de música no protocolo Socket.IO |
| N10 | Nada de música em `localStorage`/`sessionStorage` |

**A2 foi atualizada de propósito**, e é a única checagem pré-existente alterada:
ela fixava "3 transceivers por sentido", que é justamente o contrato que esta
entrega muda. A versão nova verifica também a **ordem** (`audio,video,video,audio`)
— criar o canal de música em qualquer outra posição embaralha câmera com tela ou
faz a música cair no stream de voz, e nos dois casos *parece* funcionar.

**N6/N7 medem o transceiver de índice 3**, não o total de áudio da conexão. Se a
música vazasse para o canal de voz — exatamente o bug que o canal dedicado existe
para evitar — uma medição do total passaria por acidente.

## Dois erros que a leitura do código pegou (e o teste não pegaria)

1. **A fila era lida antes do `await` da sonda de CORS.** Uma faixa adicionada por
   outro participante durante a sonda desapareceria: o estado publicado depois do
   `await` fora calculado antes dela chegar. Corrigido movendo a sonda para antes
   de qualquer leitura de estado. Só apareceria com duas pessoas adicionando ao
   mesmo tempo, e com uma URL lenta.
2. **Dispensar o card excluía a pessoa da decisão da sala.** O anúncio do árbitro
   era conferido contra a votação ativa; sem ela, era descartado, e quem tinha
   fechado o card ficava sem o player que todos os outros acabaram de ligar. A
   votação dispensada passou a ser guardada (só para validar o anúncio — o card
   não volta à tela sozinho).

## Pendências e débitos identificados

- **Arquivo local, URL sem CORS, YouTube e saída do dono no meio da faixa** não são
  cobertos por teste automatizado: dependem, respectivamente, do seletor nativo de
  arquivos, de um host externo, de um terceiro e de temporização de rede real. Estão
  no checklist manual (`docs/teste-3-participantes.md`, itens 7–11).
- **`music-vote-cast` que chegue antes do `music-vote-open` correspondente é
  descartado.** Só afeta a contagem exibida em quem não é árbitro (o resultado
  oficial vem do anúncio, e o árbitro sempre tem a votação aberta). Um buffer de
  votos pendentes resolveria; não pareceu valer a complexidade para uma sala de 6.
- **Decisão de produto em aberto:** manter ou desligar a origem YouTube antes do
  deploy (§3.4/§7 do documento). Entregue com a flag ligada e aviso na UI.

---

# Progresso — WTK-MEET-5: layout de viewport fixo, grade automática e modal de aprovação

**Status: implementação concluída e validada.** Branch
`agent/WTK-MEET-5-ajustar-layout-da-sala-para-altura-fixa-`.

Documento de arquitetura seguido: `docs/agents/arch-temp-sala-layout-viewport-fixo.md`.

> O histórico da entrega anterior (cinco melhorias de experiência de chamada) está
> preservado no fim deste arquivo, incluindo a receita de ambiente do E2E, que
> continua necessária a cada sessão.

## O problema

`.room` era `min-height: 100vh` com `.video-tile` em `aspect-ratio: 4/3` dentro de
`repeat(auto-fit, minmax(240px, 1fr))`. Com **um** participante numa tela larga o
tile único ocupava a largura inteira e, por proporção, uma altura enorme: a barra
`.controls` e o bloco de pedidos de entrada saíam da área visível. Silenciar o mic,
sair da sala ou **aprovar quem estava esperando** exigia rolar a página — e o caso
de aprovação é o crítico, porque quem espera depende de uma ação de outra pessoa
que, na prática, estava fora da tela.

## O que foi implementado

| Arquivo | Mudança |
|---|---|
| `client/src/lib/gridLayout.js` | **Novo.** Módulo puro (sem DOM): dada a caixa, a contagem e a proporção, devolve `{cols, rows, tileWidth, tileHeight, overflow}`. Busca sobre o número de colunas, desempate pelo menor número de colunas, arredondamento para baixo, piso de legibilidade de 120px |
| `client/src/components/VideoGrid.jsx` | **Novo.** Mede o palco com `ResizeObserver` e escreve `--grid-cols`/`--tile-w`/`--grid-gap` no container |
| `client/src/components/JoinRequestModal.jsx` | **Novo.** Modal centralizado de pedidos de entrada, acessível, que não fecha por `Esc`/backdrop |
| `client/test/gridLayout.test.mjs` | **Novo.** 14 testes do cálculo da grade |
| `client/src/pages/Room.jsx` | Toasts + modal içados para um wrapper comum antes dos três `return` de fase; bloco `.pending-requests` inline removido; grade trocada por `<VideoGrid />`; `waiting`/`denied` em `.phase-content` com scroll interno; dedup de pedidos e limpeza em `peer-joined`/`join-request-cancelled` |
| `client/src/styles.css` | Shell de altura fixa (`100vh` → `100dvh`, `overflow: hidden`), faixas topo/palco/rodapé, `.video-stage`/`.video-grid` dirigida por custom properties, tile 16:9 com `object-fit: contain`, CSS do modal, `.invite-hint` em linha única, breakpoint 720px sem `vh` |
| `server/src/index.js` | Evento **novo** `join-request-cancelled` (ver "Desvio consciente" abaixo) |
| `e2e/harness.mjs` | `approveAll` escopado no modal; novos helpers `roomLayout` e `noPageScroll` |
| `e2e/run.mjs` | 13 checagens novas: L1–L7 (layout) e M1–M6 (modal) |
| `ARCHITECTURE.md` | §4 passo 7 (retratação do pedido) e §6.7 (layout da sala) |

## Decisões que valem registrar

1. **A grade é calculada em JS, não por CSS.** O tamanho ótimo do tile depende ao
   mesmo tempo de largura, altura e contagem, e CSS não expressa "escolha o número
   de colunas que maximiza o tile sujeito a caber na altura" — `auto-fit`/`minmax`
   só enxerga a largura, que é precisamente por que o layout antigo quebrava.
   Isolar a aritmética num módulo puro é o que a torna verificável sem navegador.
2. **`100vh` seguido de `100dvh`.** Sem o segundo, a entrega ficaria "sem scroll"
   no desktop e com os controles debaixo da barra de endereço no celular — a mesma
   dor, outro dispositivo.
3. **O elemento medido é dimensionado pelo pai, e a grade dentro dele é
   `position: absolute`.** É o que impede o `ResizeObserver loop`: o conteúdo não
   tem como empurrar a caixa medida. A medição só vira `setState` quando as
   dimensões **inteiras** mudam.
4. **O modal não fecha por `Esc` nem por clique no backdrop.** Não é esquecimento:
   um fechamento acidental deixaria alguém esperando indefinidamente do outro
   lado. As duas tentativas recebem uma resposta na tela em vez de silêncio — o
   DoD pede explicitamente que `Esc` "não feche silenciosamente".

## Desvio consciente do documento de arquitetura

O doc de arquitetura afirma em §2 e §8.16 que **nenhum evento novo entra no
servidor** e que `server/` permanece intocado. **Isso foi violado de propósito**,
porque o item 7 do Definition of Done exige que o modal "feche automaticamente
quando o solicitante desiste/desconecta", e isso é impossível só no client: o
servidor fazia `pendingJoins.delete(socket.id)` no `disconnect` e não avisava
ninguém. O modal ficaria aberto para sempre, com um botão "Aprovar" que
silenciosamente não faz nada.

A adição é mínima e aditiva: `join-request-cancelled { requesterId }`, emitido aos
membros da sala quando o pedido deixa de ser aprovável (requisitante caiu, pedido
negado, ou sala encheu no meio do caminho). Carrega apenas um id que já é público
dentro da sala. Nenhum evento existente mudou de forma, então clients antigos
continuam funcionando (o listener novo é no-op se o evento não chegar).

**Quem revisar deve tratar isto como escopo deliberado, não como escopo vazado.**
Se a preferência for manter o servidor intocado, o item 7 do DoD precisa ser
renegociado — não há caminho só-client para ele.

## Verificação executada

- `npm --prefix client run lint` → limpo
- `npm --prefix client test` → **28/28** (14 novos de `gridLayout`)
- `npm --prefix client run build` → ok
- `node e2e/run.mjs` → **57/57** (44 anteriores + 13 novas)

Cobertura das checagens novas do E2E:

| Checagem | O que prova |
|---|---|
| L1 | 1 participante: sem scroll de página, grade 1×1, tile inteiro dentro da área da grade (o bug de origem) |
| L2 | `.controls` inteiramente dentro do viewport |
| L3 | 3 participantes → 2 colunas, sem scroll, sem estouro interno |
| L4 | Tile em 16:9 (±0.02) e `object-fit: contain` computado |
| L5 | Abrir o chat encolhe o tile (509px → 444px) sem gerar scroll |
| L6 | Viewport móvel (390×844): sem scroll, controles visíveis |
| L7 | ≤720px: chat empilha, área da grade cede altura (623px → 331px), tile continua inteiro, sem scroll |
| M1 | Modal centralizado e visível sem rolagem |
| M2 | `role="dialog"`, `aria-modal`, título associado, foco no primeiro "Aprovar" |
| M3 | Backdrop `fixed`, z-index 30 acima dos toasts (20) |
| M4 | `Esc` não fecha e responde com aviso na tela |
| M5 | Dois pedidos simultâneos listados, um por linha |
| M6 | Modal fecha sozinho quando os solicitantes desconectam |

**M6 foi validada por mutação:** com o `emit` de `join-request-cancelled` removido
do servidor, a checagem falha ("o modal continuou aberto com pedidos que já não
podem ser aprovados"); com o código restaurado, volta a passar. Sem isso seria uma
checagem que só sabe passar.

**L7 pegou um erro de verdade durante o desenvolvimento.** A primeira versão
afirmava que abrir o chat em mobile encolhe a **largura do tile**. Não encolhe:
com um único tile em retrato o limite é a largura, que o empilhamento não muda. A
checagem foi corrigida para medir o que de fato importa (a área da grade cede
altura e o tile continua inteiro dentro dela).

### Validação de CSS complementar

Além do E2E, o CSS foi verificado num harness estático em Chromium (fora do
worktree, usando o `styles.css` e o `gridLayout.js` reais): **431 asserções**
cobrindo o produto cartesiano de 7 viewports (360×640 a 2560×1440, incluindo
1440×400) × {1, 2, 3, 6, 8} tiles × {sem extras, chat aberto, banner de erro,
chat+banner} — sem scroll de página e `.controls` dentro do viewport em todas.
Também: estouro em 420×300 com 8 tiles rola **por dentro** da grade enquanto a
página não rola; e `elementFromPoint` no centro de "Aprovar" devolve o próprio
botão (o backdrop não intercepta o clique — era o risco apontado em §7 do doc).

## Pendências

**Nenhuma no código.**

**Bloqueio no board (persiste das execuções anteriores).** As ferramentas MCP
(`update_task`, `move_task_forward`, `add_task_log`, `list_tasks`) continuam **não
expostas** nesta sessão — `ToolSearch` não encontra nenhuma delas, e a API REST de
tasks segue inacessível (o board devolve 401/500). Portanto **os checkboxes do DoD
e a movimentação da task continuam pendentes** e precisam ser feitos por quem tiver
acesso ao board. Nenhuma tentativa de contornar isso foi feita.

## Nota de execução: duas sessões no mesmo worktree

Esta task foi executada por **duas sessões Claude em paralelo, no mesmo worktree**,
o que só foi percebido depois que uma edição falhou com "file has been modified
since read". As duas foram derivadas do mesmo documento de arquitetura e chegaram
a desenhos compatíveis (inclusive aos mesmos nomes de custom properties, que o doc
fixa em §5.2). A colisão foi resolvida por divisão explícita de propriedade de
arquivos, negociada entre as sessões:

- sessão A: `client/src/styles.css`, `client/src/pages/Room.jsx`;
- sessão B: `client/src/lib/`, `client/src/components/`, `client/test/`, `server/`,
  `e2e/`, `ARCHITECTURE.md`, `claude-progress.md`.

Nenhum trabalho foi perdido, mas houve esforço duplicado antes da descoberta.
**Se o orquestrador do board puder despachar só uma sessão por task, deve.**

---

# Histórico — cinco melhorias de experiência de chamada (entrega anterior)

**Status: concluído.** Commit `2a17de5` na branch
`agent/3-implementar-cinco-melhorias-de-experi-nc`.

## O que foi implementado

| Arquivo | Mudança |
|---|---|
| `client/src/lib/webrtcMesh.js` | Reescrito: 3 transceivers `sendonly` por conexão (mic/câmera/tela), perfect negotiation, `RTCDataChannel` negociado fora de banda, `setCameraTrack`/`setScreenTrack`/`setAudioTrack` via `replaceTrack`, teardown completo |
| `client/src/lib/audioLevels.js` | Novo: um `AudioContext` + um loop de rAF para a sala, histerese 500ms, bipe sintetizado |
| `client/src/lib/chat.js` | Novo: modelo de mensagem, sanitização de entrada remota, teto de histórico em memória |
| `client/src/components/{VideoTile,ChatPanel,Toasts}.jsx` | Novos |
| `client/src/pages/Room.jsx` | Orquestração: estado de participantes/chat/toasts/níveis, toggles de câmera e tela, limpeza no unmount |
| `client/src/styles.css` | Anel de fala, placeholder, painel de chat, toasts, badge |
| `client/test/*.test.mjs` | 14 testes unitários (`node:test`) |
| `e2e/{harness,run}.mjs` | Teste ponta a ponta com 3 Chromium + TURN local, 44 verificações |
| `client/.eslintrc.json` | Linter (não existia no projeto) |
| `ARCHITECTURE.md`, `README.md`, `docs/` | Documentação |

`server/src/index.js` **não foi tocado** — `peer-joined`/`peer-left` já bastavam.
(Isso deixou de valer em WTK-MEET-5; ver "Desvio consciente" acima.)

## Descobertas que mudaram o desenho

1. **Transceivers de `addTransceiver()` não pareiam com m-lines remotas.** A spec
   só permite associação implícita para transceivers criados por `addTrack()`.
   O layout real é 3 `sendonly` + 3 `recvonly` por conexão. A identificação do
   que chega usa identidade de objeto para os nossos transceivers e posição
   entre os remotos (`_classifyTransceiver`). Descoberto pelo E2E — a primeira
   versão colocava a tela remota no stream da câmera.
2. **Estado de câmera/tela vai pelo data channel**, não é inferido de
   `track.muted` (que demora segundos no Chromium).
3. **Compartilhar tela não renegocia SDP** — o transceiver já existe. O perfect
   negotiation continua necessário para a negociação inicial simétrica e para
   `restartIce()`.

## Verificação executada (entrega anterior)

- `npm --prefix client run lint` → limpo
- `npm --prefix client test` → 14/14
- `npm --prefix client run build` → ok
- `node e2e/run.mjs` → **41/41**, 5 execuções consecutivas limpas

## Passada de QA (2026-08-11)

Três buracos de cobertura fechados, todos em `e2e/`, sem tocar em código de
produção: `A4` (toast de entrada com nome e classe), `A5` (bipe de entrada,
distinto do de saída) e `C7` (parar compartilhamento pela barra do navegador, via
evento `ended`). **Cada uma foi validada por mutação.**

O que não dá para cobrir em headless está listado como checklist manual em
`docs/teste-3-participantes.md` (LED físico da webcam, `chrome://webrtc-internals`,
barra nativa "Parar compartilhamento", diálogo de escolha de tela, Firefox/Safari).

## Notas para rodar o E2E neste ambiente

Num ambiente normal, `npx playwright install-deps chromium` resolve tudo — o que
segue só vale para este sandbox, que não tem as bibliotecas de sistema nem as
fontes do Chromium e não dá root. `/tmp` não persiste entre sessões, então isto
precisa ser refeito a cada vez. Receita completa, validada de novo nesta sessão:

```bash
# 1. As listas do apt vêm vazias e `apt-get update` não pode escrever em /var.
#    Redirecionar todos os diretórios de estado para /tmp resolve sem root.
mkdir -p /tmp/apt/{lists/partial,cache/archives/partial,state} && touch /tmp/apt/state/status
APTOPT="-o Dir::State::Lists=/tmp/apt/lists -o Dir::Cache=/tmp/apt/cache \
        -o Dir::State::status=/tmp/apt/state/status -o Acquire::Languages=none"
apt-get $APTOPT update

# 2. `apt-get download` não resolve dependências: a lista tem que vir do
#    apt-cache com --recurse (128 pacotes, contra os 23 de topo).
mkdir -p /tmp/pwlibs/debs && cd /tmp/pwlibs/debs
PKGS="libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdbus-1-3 \
      libdrm2 libxcb1 libxkbcommon0 libatspi2.0-0t64 libx11-6 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
      libglib2.0-0t64 fonts-liberation fonts-dejavu-core"
apt-get $APTOPT download $(apt-cache $APTOPT depends --recurse --no-recommends \
  --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances $PKGS \
  | grep '^[a-z0-9]' | sort -u)
for d in *.deb; do dpkg-deb -x "$d" /tmp/pwlibs/root; done

# 3. Fontconfig só varre caminhos que ele conhece — copiar para ~/.fonts, que já
#    está no fonts.conf, evita ter que reescrever a config.
cp -r /tmp/pwlibs/root/usr/share/fonts/truetype/* $HOME/.fonts/

# 4. Ambiente de execução do e2e:
export LD_LIBRARY_PATH=/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu:/tmp/pwlibs/root/lib/x86_64-linux-gnu
export FONTCONFIG_PATH=$HOME/.config/fonts-etc FONTCONFIG_FILE=$HOME/.config/fonts-etc/fonts.conf
```

Sem as fontes, o processo do Chromium **crasha** ao renderizar texto (HarfBuzz
sem nenhuma fonte disponível) — o sintoma é `browserType.launch: Target page,
context or browser has been closed`, o mesmo erro de biblioteca faltando.
`ldd .../chrome-linux64/chrome | grep -c 'not found'` distingue os dois casos:
se der 0, o que falta é fonte.

Duas armadilhas do ambiente headless que estão documentadas no próprio harness:
injeção de teclado via CDP não chega ao renderer (usar o setter nativo de
`value` + evento `input` — e, para teclas, despachar o `KeyboardEvent` de dentro
da página, como faz a checagem M4), e o Chrome não entrega o áudio de uma track a
um segundo `AudioContext` (por isso a temporização da histerese é verificada em
teste unitário, não no navegador).
