# WTK-MEET-26 — Extensão Chrome (MV3) com motor de áudio único

> Documento de arquitetura: `docs/agents/arch-temp-extensao-chrome-motor-audio-unico.md`
> Branch: `agent/wtk-meet-26-quero-criar-uma-extens-o-para-o-navegado`
> Início: 2026-09-15 · Status: **COMPLETED**

O registro do que a implementação encontrou: a linha de base medida antes de
qualquer alteração, as três decisões que o documento deixou em aberto e como
foram resolvidas, o que o documento afirmava sobre a plataforma e **não era
verdade**, e o que fica como débito.

---

## 1. Linha de base e resultado final

| Portão | Linha de base (antes) | Depois desta entrega |
|---|---|---|
| `npm test` (client) | **571/574** | **571/574** (as mesmas 3 falhas) |
| `npm test` (server) | 98/98 | 98/98 |
| `npm test` (extensão) | — | **50/50** (novos) |
| `npm run typecheck` | limpo | limpo, com o workspace novo |
| `npm run lint` | limpo | limpo, com o workspace novo |

As três falhas do client são de redirecionamento duplo (`"/a/b" devia voltar para
a Home` e as duas irmãs): o efeito de canonicalização navega **duas** vezes onde o
teste espera uma. Medidas em `1e88073`, **antes** de qualquer arquivo desta
entrega existir, e em arquivos que esta entrega não toca. O número da memória do
projeto (520/520) é de uma linha de base mais velha — a suíte cresceu desde então.

O E2E de 3 participantes (`npm run test:e2e`) foi executado ao fim da entrega — o
resultado está no §5.3. A única mudança fora de `packages/extension` e
`packages/e2e` é um comentário em `pages/Room.tsx` (§4).

---

## 2. As três decisões que o documento deixou em aberto

| § do documento | Pergunta | Decisão desta implementação |
|---|---|---|
| 3.7 | O código do Meet vira o endereço da sala? | **Sim**, e **sem o prefixo `meet-`** que o documento propunha: o DoD do board pede `abc-defg-hij` normalizado por `roomSlug.ts`, e é isso que o popup preenche. O custo de privacidade está escrito no `ARCHITECTURE.md` §11.4. |
| 3.10 | `optional_host_permissions: *://*/*` para fazer o MyInstants tocar? | **Não.** O manifest não pede permissão de host opcional nenhuma. O DoD pede que URL sem CORS seja "recusada no popup com mensagem explícita, igual ao comportamento do client" — o que é incompatível com um caminho que a faria tocar. O proxy do app e a permissão ampla continuam **os dois** em aberto. |
| 3.11 | A página `manager` existe, ou a entrega sai sem arquivo local? | **Existe.** O popup fecha quando perde o foco, e é isso que quebra o seletor de arquivo; cortar a página e manter o seletor no popup é a única combinação que não funciona. |

---

## 3. O que o documento afirmava sobre a plataforma e não era verdade

Estes quatro pontos foram **medidos no Chromium** (2026-09-15), não deduzidos. Os
dois primeiros custaram uma sessão de depuração cada, e os dois são falhas
silenciosas — daí o tamanho do registro.

### 3.1 O documento offscreen **não** tem `chrome.storage`

O §7.4 do documento listava "o motor só fala `chrome.runtime` e `chrome.storage`".
`chrome.storage` é `undefined` num documento offscreen. O erro real foi:

```
TypeError: Cannot read properties of undefined (reading 'local')
```

…dentro de um `boot()` assíncrono cuja rejeição não aparecia em lugar nenhum: o
documento subia, respondia, e a UI esperava para sempre um estado que nunca vinha.

**Conserto:** `src/lib/storage.ts` tem dois *backends* — `directBackend()` para
quem tem a API (service worker, popup, `manager`) e `messageBackend()` para o
motor, que pede tudo ao service worker (`storage-get`/`storage-set`), com o
caminho de volta (`storage-changed`) mantendo os favoritos iguais em todo lugar.

### 3.2 `createDocument` resolver **não** significa "o motor atende"

`chrome.offscreen.createDocument` resolve quando o documento existe — o script
dele pode ainda não ter rodado. A porta que a UI abre em seguida chega a um
`onConnect` sem listener, é desconectada na hora, e o popup abre vazio sem erro.

**Conserto:** handshake `ping` (o motor responde `{ ready }`), `ensure-engine` só
responde depois dele, e o `onConnect` do offscreen é registrado **antes** de
qualquer `await`, com fila para as portas que chegam durante o boot.

### 3.3 Um comando enviado durante o boot era **descartado em silêncio**

Sintoma no E2E: a página `manager` abria, criava o documento offscreen e mandava
`queue-add` no mesmo segundo; o motor ainda hidratava o storage, o comando caía
num `motor?.handleCommand` e sumia. Quem clicou via um botão que "não fez nada".
Intermitente por construção — passava quando o boot ganhava a corrida.

**Conserto:** os comandos que chegam antes do motor existir ficam numa fila e são
executados, na ordem, assim que ele sobe.

### 3.4 Um comando disparado antes de a porta abrir sumia — dos **dois** lados

A mesma falha, em dois lugares: a UI descartava o comando em
`this.port?.postMessage` enquanto `start()` ainda esperava o service worker, e o
motor descartava em `motor?.handleCommand` enquanto hidratava o storage. Os dois
agora enfileiram e executam na ordem.

### 3.5 `context.route` do Playwright **não alcança** o documento offscreen

Medido com uma sonda dedicada: zero interceptações de um `fetch` feito de dentro
do offscreen. Isso tem consequência direta no teste — o TURN do E2E não pode ser
injetado por rota, e por isso o roteiro de sala sobe um **proxy** que responde
`/turn-credentials` e encaminha o resto (inclusive o upgrade WebSocket).

O que **se confirmou** verdadeiro: o `<audio crossOrigin="anonymous">` de uma
página de extensão **não** fica *tainted* quando o host manda
`Access-Control-Allow-Origin` (medido com um analisador: amplitude real, não
silêncio), e o `RemoteMusicAudio` do app realmente toca o canal de música de
qualquer peer sem votação e sem painel aberto.

---

## 4. O que mudou fora de `packages/extension`

| Arquivo | Mudança | Por quê |
|---|---|---|
| `package.json` (raiz) | `packages/extension` nos `workspaces` e nos scripts `build`, `test`, `typecheck` e `lint`; dois scripts novos de E2E | Esquecer um dos quatro é a forma de a CI ficar verde sobre código que ninguém olhou |
| `packages/client/src/pages/Room.tsx` | **Só um comentário**, ao lado das linhas comentadas de E2EE | A armadilha do §11.2: religar a E2EE emudece a extensão sem nenhum erro. É a exceção que o próprio documento de arquitetura previa (§8.19) |
| `packages/e2e/` | `extension.ts`, `extensionRoom.ts` e dois scripts | O DoD pede cenário Playwright com contexto persistente; o documento de arquitetura o dava como fora de escopo — **o DoD venceu** |
| `ARCHITECTURE.md` | §11 nova | §11.1 a §11.10 |
| `README.md` / `README.en.md` | Seção da extensão | Instalação, uso, `CLIENT_ORIGIN`, permissões e as duas frases explícitas (sem E2EE derivada; a sala herda o sigilo do código da reunião) |
| `CHANGELOG.md` | Entrada em `Adicionado` | |

Nenhuma linha de `packages/server` mudou.

---

## 5. Verificação empírica

### 5.1 `npm run test:e2e:extension` — duas abas, um motor só

16/16 checagens. O que ele afirma, e que era o centro do pedido:

- as duas abas falam com o **mesmo** `engineId`;
- existe **exatamente um** `OFFSCREEN_DOCUMENT` (`chrome.runtime.getContexts`);
- um favorito criado numa aba aparece na outra em **≤1s**;
- um disparo produz **uma** reprodução e **um** `AudioContext`, visto pelas duas;
- um disparo vindo da **outra** aba soma no mesmo contador;
- quatro disparos em rajada produzem **três** reproduções — a janela de 5s é uma
  só para todas as abas —, e o botão fica indisponível dizendo quanto falta;
- URL sem CORS é recusada com a mensagem do app, e a recusa **não** conta como
  reprodução.

### 5.2 `npm run test:e2e:extension:room` — o app ouve o motor

**7/7 checagens.** Roteiro com servidor de sinalização, TURN local, o app e a
extensão na mesma sala:

- Alice entra pelo app e o pedido de entrada do motor aparece para ela;
- ela aprova, e o motor entra (a aprovação é sempre humana);
- a faixa que toca no motor chega a ela: **rms 0,29** no canal de música, sem
  nenhuma votação de player e sem o painel de música aberto;
- o efeito do soundboard também: **rms 0,35**.

Duas coisas do ambiente que ele precisa resolver, e que são o mesmo problema de um
deploy real: a origem `chrome-extension://<id>` no `CLIENT_ORIGIN` (o caminho que o
README documenta) e o TURN, que entra pelo proxy (§3.5).

### 5.3 `npm run test:e2e` — a suíte de 3 participantes, comparada com a base

A suíte do app mudou de tamanho com o redesign (#33): são **72** checagens hoje, e a
falha conhecida deste repositório (F4a, do botão "Silenciar avisos") não existe mais
nesse recorte. A comparação que vale é com a **linha de base desta branch**:

| Execução | Resultado | Falhas |
|---|---|---|
| merge-base `3dfc6bb` | **71/72** | S2 |
| branch, 1ª rodada | 70/72 | S2 + **L5** |
| branch, 2ª rodada | **71/72** | S2 |

- **S2** ("o modal é acessível, tem preview ao vivo e não cria um segundo
  `AudioContext`") falha **também na base** — é pré-existente e não é desta entrega.
- **L5** (layout do chat) apareceu só na primeira rodada, com a máquina carregada logo
  depois da suíte unitária, e passou na segunda. É a classe de checagem de layout/rAF que
  este repositório já registra como intermitente sob carga.

Nada em `packages/client` ou `packages/server` muda por esta entrega além de um
comentário, então uma regressão de layout vinda daqui não teria por onde acontecer.

### 5.4 O que **não** foi medido nesta sessão

- **Tempo de vida do documento offscreen** com `reasons: ['WEB_RTC',
  'AUDIO_PLAYBACK']`, ocioso por 15 minutos (§7.2 do documento). O código cria o
  documento com as duas razões, nessa ordem, e a UI trata `port.onDisconnect` como
  perda do motor — mas a medição de 15 minutos não coube.
- **Política de autoplay sem a flag `--autoplay-policy`.** Os roteiros rodam com a
  flag ligada. O caminho de `onBlocked` existe e vira `notice` na UI, mas não foi
  exercitado num Chrome sem a flag.
- **`activeTab` lendo a URL do Meet num Chrome de verdade.** A derivação do id tem
  17 casos em `node --test` (incluindo `?authuser=`, `/lookup/`, `/new`, hash e
  paths inválidos), mas o caminho `chrome.tabs.query` → popup não tem teste
  automatizado — o roteiro manual está no §6.

---

## 6. Roteiro manual (o que um humano precisa conferir no Chrome)

1. `npm run build:extension`, carregar `packages/extension/dist` sem compactação.
2. Abrir `https://meet.google.com/abc-defg-hij` numa aba e clicar no ícone: o
   campo de sala deve vir com `abc-defg-hij`.
3. Ir para qualquer outro site e clicar no ícone: o campo traz a última sala e o
   popup **diz por que** não preencheu.
4. Conectar numa sala com o app aberto noutra janela; aprovar a entrada pelo app.
5. Tocar uma URL de áudio com CORS: a sala ouve. Fechar o popup: continua tocando.
6. Disparar um efeito: a sala ouve e o painel do app mostra a autoria.
7. Deixar o motor conectado e ocioso por 15 minutos e registrar se o Chrome fechou
   o documento offscreen (§5.3).

---

## 7. Achado fora do escopo: a música do app nasce muda

Medido enquanto se investigava "a sala não ouve a extensão", e **não é da
extensão** — é do app, e é pré-existente:

```ts
// packages/client/src/lib/useMusicRoom.ts (~linha 230)
const stored = Number(localStorage.getItem('wtk-meet:music-volume'));
return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 0.8;
```

`localStorage.getItem` devolve `null` quando a chave nunca foi escrita, e
`Number(null)` é **0** — que passa em `Number.isFinite`, em `>= 0` e em `<= 1`.
Resultado: **o default de `0.8` é inalcançável** e quem nunca mexeu no controle
de volume da música ouve tudo em silêncio. Vale para a música de **qualquer**
peer, não só a da extensão.

O sintoma é exatamente o que este projeto documenta como a pior classe de falha:
o `<audio>` toca (`paused: false`, `currentTime` avançando), os bytes chegam
(`bytesReceived > 0`), e o `totalAudioEnergy` fica em zero — indistinguível de
"o outro lado mandou silêncio" sem olhar o `volume` do elemento.

**Não foi corrigido aqui**: esta entrega não muda `packages/client` (a única
exceção é o comentário-âncora do §4), e o conserto — tratar `null` antes do
`Number` — é uma linha no app que merece o seu próprio teste. O roteiro
`extensionRoom.ts` semeia `wtk-meet:music-volume` para contornar, com o motivo
escrito ali.

## 8. Débito identificado

- **O proxy do MyInstants continua em aberto**, e agora em dois lugares: no app
  (que precisaria de um proxy no servidor) e na extensão (que precisaria de
  permissão de host ampla). Decisão de produto, não de implementação.
- **`packages/extension/src/lib/signaling.ts` duplica os nomes de evento** do
  client. A mitigação é um teste de caracterização que lê os dois arquivos do
  client e falha quando alguém renomeia um evento em um lado só.
- **As três falhas de `roomPhases.test.ts`** continuam na `main` (§1). Não são
  desta entrega e não foram tocadas aqui.
- **O volume da música do app nasce zero** (§7). Uma linha, no client, com teste
  próprio — precisa de aval por estar fora do escopo desta task.

---

## 9. Rodada de QA — 2026-09-16

Papel desta sessão: **QA**. Nenhuma linha de produção foi tocada; o que entra são
testes, e o que sai é um defeito confirmado.

### 9.1 O que foi medido, e com que resultado

| Portão | Antes desta rodada | Depois dos testes novos |
|---|---|---|
| `npm test` — client | **571/574** (3 falhas) | 571/574 (as mesmas 3) |
| `npm test` — server | 98/98 | 98/98 |
| `npm test` — extensão | 50/50 | **85/86 — 1 falha nova, e ela é real** |
| `npm run typecheck` | limpo | limpo |
| `npm run lint` | limpo (1 warning pré-existente no client) | idem |
| `npm run test:e2e:extension` | 16/16 | 16/16 |
| `npm run test:e2e:extension:room` | 7/7 | 7/7 |

As 3 falhas do client são `roomPhases.test.ts` (os três redirects) — **conferidas
nesta sessão**, e elas não têm relação com a extensão: nada em `packages/client`
mudou nesta entrega além de um comentário. Os dois roteiros Playwright foram
executados aqui e reproduzem, checagem a checagem, o que o §5 afirma.

### 9.2 Os 36 testes novos

| Arquivo | Casos | O que fecha |
|---|---|---|
| `test/repoContract.test.ts` | 10 | DoD 1 e 2 (manifest, permissões cruzadas com o uso no código e com `PERMISSIONS.md`, `dist/` carregável) e DoD 15 (a ausência de E2EE está escrita nos três documentos) |
| `test/engineQueue.test.ts` | 10 | §8 4, 11, 14 e 15 — snapshot completo para quem chega no meio da faixa, recusa com mensagem em vez de silêncio, `fileId` do IndexedDB, teto de tempo da sonda de CORS |
| `test/favorites.test.ts` | 7 | DoD 7 — teto de 50, duplicata, renome, remoção e o documento gravado no formato do app |
| `test/engineLifecycle.test.ts` | 9 | §8 8, 9 e 10 — badge (a única coisa que avisa com o popup fechado), motivo da recusa, desligamento que zera a sala |

### 9.3 O defeito encontrado — remover a faixa que está tocando para a música

Reprodução, com os dublês do próprio pacote:

```
antes  : fila [a, b, c], corrente a, tocando
remove a (a corrente)
depois : fila [b, c], corrente null, NÃO tocando, nenhuma mensagem
play   : volta a tocar b
```

`EngineCore.queueRemove` tira a entrada da sessão **antes** de chamar
`advance()`; lá dentro, `nextEntry(session, atual)` procura o sucessor de um id
que já não está na fila e, para id desconhecido, `nextEntry` devolve `null`
(`musicSession.ts`, `index < 0`). Resultado: `proxima` é `null`, `stopTrack()`
roda e a sala fica em silêncio com duas faixas ainda enfileiradas — sem erro em
lugar nenhum, que é a classe de falha que este repositório persegue desde a
WTK-MEET-9. O `skip` não sofre disso porque ele **não** remove antes de avançar.

O client já tem a função para este caso exato e diz isso no próprio comentário:
`nextEntryAfterKey` ("primeira entrada depois de uma chave que pode nem existir
mais na fila"). O conserto é de uma linha, e é do agente de desenvolvimento —
não desta sessão.

Teste que cobre: `test/engineQueue.test.ts` → *"remover a faixa corrente avança —
a fila não fica parada com nada tocando"*.

### 9.4 Duas observações que não são defeito

- **`host_permissions: https://meet.google.com/*` provavelmente é redundante.** O
  único caminho que lê a URL da aba é o `prefill`, e ele só é chamado pelo popup —
  ou seja, sempre no clique no ícone, que é exatamente quando `activeTab` é
  concedida. O DoD pede a host permission e `PERMISSIONS.md` a justifica, então
  ela fica; mas o §5.4 registra que ela nunca foi medida num Chrome de verdade, e
  é uma permissão a menos na revisão da Web Store se a medição confirmar.
- **A fila da extensão para em 10 faixas.** Todas as entradas do motor têm o mesmo
  autor (`extension`), então o `MAX_PER_PEER` do client vale para a fila inteira.
  A 11ª é recusada com a mensagem do app ("Você já tem o máximo de faixas na
  fila"), o que é correto — mas para um motor que existe para tocar playlist, 10 é
  um teto que merece decisão de produto. Caracterizado em `engineQueue.test.ts`.

---

## 10. Segunda rodada de QA — 2026-09-16 (confirmação e um defeito irmão)

Rodada independente sobre o mesmo commit (`5e295d7`). Tudo que o §9 afirma foi
**medido de novo aqui**, portão a portão — inclusive os dois roteiros Playwright,
que não são baratos e por isso costumam ser herdados em vez de refeitos.

### 10.1 Portões, medidos nesta sessão

| Portão | Resultado |
|---|---|
| `npm -w wtk-meet-server run test` | **98/98** |
| `npm -w wtk-meet-client run test` | **571/574** — as 3 de `roomPhases.test.ts` |
| `npm -w wtk-meet-extension run test` | **85/87 — 2 falhas, as duas reais** |
| `npm run typecheck` (raiz, os 4 workspaces) | limpo |
| `npm run lint` (raiz) | limpo — 1 warning pré-existente no client (`Room.tsx` 844, da #31) |
| `npm run test:e2e:extension` | **16/16** |
| `npm run test:e2e:extension:room` | **7/7** — a Alice ouve a faixa (rms 0.294) e o efeito (rms 0.345) |

As 3 falhas do client **não são desta entrega**, e desta vez com prova em vez de
argumento: `git diff main -- packages/client` devolve **9 linhas, todas de
comentário**, no `Room.tsx` (o aviso sobre religar a E2EE). Nenhuma linha de
comportamento do client mudou nesta branch.

### 10.2 O defeito do §9.3, confirmado na leitura do código

`EngineCore.queueRemove` (`src/engine/core.ts:365`) chama `advance()` **depois**
de já ter tirado a entrada da sessão. Dentro de `advance()`, `atual` vem do
snapshot publicado — que ainda traz o id removido — e `nextEntry(session, atual)`
procura esse id numa fila onde ele não está mais: `index < 0` → `null`
(`musicSession.ts:367`). Daí em diante: `stopTrack()`, `current = null`, e a
publicação sai com a fila cheia e nada tocando.

E ele é alcançável pela tela: `manager.ts:74` põe um botão **Remover** em *toda*
entrada da fila, inclusive na que está marcada com `▶`. Como o motor é a fonte do
áudio da sala, o clique não emudece uma aba — emudece a sala inteira.

O contrato do app é o oposto, e está escrito lá em código: em `useMusicRoom.ts`
(`removeFromQueue`, ~1285) remover a corrente é `advanceFrom(entryId, 'skipped')`
com o comentário *"Pular é remover a faixa corrente"*.

### 10.3 O defeito irmão — a faixa que não carrega leva o resto da fila junto

Mesmo ponto cego, outro caminho. `playEntry` (`core.ts:402`), quando
`loadTrack` recusa, avisa, remove a entrada, zera a corrente e **publica** — não
chama `advance()`. Com uma faixa só na fila isso é indistinguível do correto, e é
por isso que o teste que existia (`faixa que não carrega vira a mensagem do app`)
passava: ele usa uma fila de um item.

Reprodução com três faixas, sendo a do meio ruim:

```
fila [boa, ruim, outra], tocando boa
skip                       → advance() → playEntry(ruim) → loadTrack recusa
depois : aviso "não é áudio" ✔ , fila [outra] , corrente null , NÃO tocando
esperado: corrente = outra, tocando
```

O app, de novo, faz o contrário: erro de reprodução é
`advanceFrom(entryId, 'error')` (`useMusicRoom.ts:541` e `:550`).

Diferença em relação ao §10.2: aqui **há mensagem**, então não é o silêncio mudo
— é uma playlist que para na primeira URL podre. Em um motor cuja razão de
existir é tocar fila sem ninguém olhando, o efeito prático é o mesmo.

Teste que cobre: `test/engineQueue.test.ts` → *"uma faixa que não carrega não
leva o resto da fila junto"*.

### 10.4 Por que os dois voltam para o desenvolvimento, e não são consertados aqui

O conserto dos dois passa por `advance()` — que hoje deriva a próxima faixa de um
**id**, e precisa derivá-la de uma **chave de ordenação** para sobreviver à
entrada que já saiu da fila. O client tem a função escrita para exatamente isto,
com o caso no próprio comentário: `nextEntryAfterKey` (`musicSession.ts:384`,
*"primeira entrada depois de uma chave que pode nem existir mais na fila"*).
Escolher entre reusá-la e reordenar as chamadas é decisão de implementação, e
esta sessão é de QA: o que sai daqui são os dois testes vermelhos.

---

## 11. Terceira rodada de QA — 2026-09-16

Rodada independente sobre `f43b031`. Os dois defeitos do §10 **foram
reproduzidos e confirmados na leitura do código**, e esta rodada acrescenta duas
coisas que faltavam: a prova de que os testes vermelhos são **satisfazíveis**
(isto é, que eles ficam verdes com o conserto, e não por acidente), e o conserto
de um **defeito no próprio teste** que tornava um deles impossível de passar.

### 11.1 Portões, medidos nesta sessão

| Portão | Resultado |
|---|---|
| `npm -w wtk-meet-server run test` | **98/98** |
| `npm -w wtk-meet-client run test` | **571/574** — as 3 de `roomPhases.test.ts` |
| `npm -w wtk-meet-extension run test` | **85/87 — 2 falhas, as duas reais** |
| `npm run typecheck` (raiz, os 4 workspaces) | limpo |
| `npm run lint` (raiz) | 0 erros — 1 warning pré-existente (`Room.tsx:844`, da #31) |

As 3 falhas do client são pré-existentes, e a prova é mecânica: `git diff main --
packages/client` devolve **9 linhas, todas de comentário**, no `Room.tsx`. Nenhuma
linha de comportamento do client mudou nesta branch, então nenhuma falha do client
pode ter origem aqui. (Os dois roteiros Playwright não foram reexecutados nesta
rodada — os §5 e §10 os medem, e nada de produção mudou desde então.)

### 11.2 O defeito no teste: um vermelho que continuaria vermelho depois do conserto

O teste *"uma faixa que não carrega não leva o resto da fila junto"* (§10.3) usava
o `falhaAoCarregar` do dublê, que é **global e permanente**:

```ts
audio.falhaAoCarregar = 'not-audio';
await core.handleCommand({ … action: 'skip' }, aba);   // a cascata inteira roda AQUI
audio.falhaAoCarregar = null;                          // tarde demais
```

A cascata toda acontece dentro daquele único `await`. Com o motor **corrigido**,
`playEntry(ruim)` recusaria e chamaria `advance()` → `playEntry(outra)` — que
recusaria também, porque a bandeira ainda está ligada. Fim: fila vazia, corrente
`null`, e a asserção `current?.title === 'outra'` **falha do mesmo jeito**. Ou
seja: o teste acusava um defeito real, mas não teria como confirmar o conserto —
um vermelho permanente, que é a pior espécie de teste para devolver a alguém.

**Conserto (nesta rodada, e só no teste):** `AudioQueFalha` ganhou
`falhasPorTitulo: Map<string, string>`, que recusa **apenas** a faixa nomeada. O
teste agora marca só `'ruim'`, e as vizinhas continuam carregáveis — que é o
cenário que ele diz medir. O `falhaAoCarregar` global fica, porque o teste de uma
faixa só (§9.2) o usa legitimamente.

### 11.3 A prova de que os dois testes são satisfazíveis

Com os dois vermelhos em mãos, o conserto candidato foi aplicado **em caráter de
sonda**, medido, e **revertido** — `packages/extension/src/engine/core.ts` está
byte a byte igual ao de `f43b031`, e o único arquivo que esta rodada modifica é
`test/engineQueue.test.ts`.

```diff
--- queueRemove: deixar o advance() remover a corrente, em vez de removê-la antes
     const corrente = this.state.current?.entryId === entryId;
-    this.session = removeEntry(this.session, entryId);
-    this.fileIds.delete(entryId);
-    if (corrente) await this.advance();
-    else this.publish();
+    if (corrente) return this.advance();
+    this.session = removeEntry(this.session, entryId);
+    this.fileIds.delete(entryId);
+    this.publish();

--- playEntry: recusa ao carregar segue a fila, em vez de parar nela
       this.session = removeEntry(this.session, entry.id);
+      this.fileIds.delete(entry.id);
       this.currentEntryId = null;
       this.publish();
-      return;
+      return this.advance();
```

Resultado da sonda: **87/87**. Com o código de volta ao original: 85/87.

Isso responde a única pergunta que ainda estava em aberto sobre o §10 — se os
vermelhos eram acionáveis — e mostra que o conserto é pequeno. Ele **não** foi
entregue: alterar produção não é desta coluna, e a escolha entre este desenho e o
`nextEntryAfterKey` do client (§10.4) é de quem implementa.

### 11.4 Por que o defeito do §10.2 acontece, em uma linha

`advance()` lê `atual` de `this.state.current`, que é um campo **derivado e só
recalculado em `publish()`**. O `queueRemove` tira a entrada da sessão sem
publicar, então `advance()` enxerga um `atual` que a fila já não contém;
`nextEntry` devolve `null` para id desconhecido (`index < 0`) e o motor conclui
"acabou a fila" com duas faixas nela. É stale state, não lógica de fila — e é por
isso que o `skip`, que não remove antes de avançar, escapa.

---

## 12. Quarta rodada de QA — 2026-09-16

Rodada sobre `6775469`. Os dois defeitos do §10 **continuam vivos** — o
Development recebeu a task de volta três vezes (14:57, 15:03 e 15:09) e não há
**nenhum commit** nem **nenhuma alteração de arquivo** desde então
(`core.ts` tem mtime 15:06:28, que é a sonda revertida do §11.3). A suíte da
extensão fecha nos mesmos **85/87**, nos mesmos dois testes, com as mesmas duas
mensagens.

E esta rodada acha um defeito **maior que os dois**, num lugar onde nenhum teste
desta entrega olhava.

### 12.1 O defeito que bloqueia o DoD 1: o motor não está no repositório

```
$ git check-ignore -v packages/extension/src/engine/core.ts
.gitignore:10:core.*	packages/extension/src/engine/core.ts
```

A regra `core.*` da raiz — escrita para os **core dumps do Chromium** durante o
E2E — engole `packages/extension/src/engine/core.ts`, que é o `EngineCore`: a
fila, o player, o soundboard, o rate limit. O arquivo de 22 KB que **é** a
entrega. Ele existe neste worktree, nunca foi versionado, e `git status` diz
"clean" porque um arquivo ignorado não aparece.

Prova, num checkout limpo do `HEAD` (`git archive HEAD | tar -x`):

```
$ node build.ts
Error: Build failed with 1 error:
src/offscreen.ts:33:27: ERROR: Could not resolve "./engine/core.js"
```

Consequências, em ordem de gravidade:

1. **DoD 1 falha.** "`npm run build` produzindo um `dist/` carregável" não
   acontece para ninguém que clone o repositório. Só acontece aqui.
2. **Os DoD 5, 6, 7, 8, 9, 11, 12 e 13 estão medidos sobre um arquivo que o PR
   não leva.** Os 87 testes, os dois roteiros Playwright, o `typecheck` e o
   `lint` leem o disco — e no disco o arquivo está. Verde local, quebrado no
   clone.
3. **Explica o que as três devoluções anteriores não explicavam.** Qualquer
   sessão que tenha partido de um checkout limpo desta branch encontrou um
   pacote que não constrói e uma suíte que não sobe, sem nada no `git log` que
   justificasse — e o `git status` limpo esconde a causa.

`packages/extension/icons/` também está ignorado, e esse é **de propósito**: o
`build.ts` chama `tools/makeIcons.ts` quando os PNGs não existem, para não
versionar binário. Nenhum outro arquivo do repositório está nessa situação
(`git status --porcelain --ignored=matching`).

### 12.2 O teste que fecha o buraco

`test/repoContract.test.ts` → *"todo arquivo do pacote está versionado — o clone
recebe o que este worktree tem"*.

Ele cruza `git ls-files` com o que existe em disco, descontando os três
diretórios gerados de propósito (`dist/`, `icons/`, `node_modules/`), e a
mensagem de falha traz a **regra de `.gitignore` responsável**, para o conserto
não depender de adivinhação:

```
arquivo(s) do pacote fora do git — um clone não consegue construir a extensão:
  src/engine/core.ts — .gitignore:10:core.*	packages/extension/src/engine/core.ts
```

Era o ponto cego estrutural desta suíte: todos os outros testes de contrato
(inclusive o que roda `node build.ts`) afirmam coisas sobre **arquivos em
disco**. Nenhum perguntava se o disco e o `git` contam a mesma história.

### 12.3 Sonda do conserto, aplicada e revertida

```diff
--- a/.gitignore
+++ b/.gitignore
 # core dumps do Chromium headless durante os testes E2E
-core.*
+core.[0-9]*
```

Medido com a sonda no lugar:

- `core.12345` (o core dump real) **continua ignorado** — `.gitignore:10:core.[0-9]*`;
- `packages/extension/src/engine/core.ts` **deixa de ser ignorado**;
- com `git add packages/extension/src/engine/core.ts`, a suíte vai a **86/88** —
  o teste novo fecha verde e sobram exatamente os dois defeitos do §10.

Revertido: `.gitignore` e o índice estão como em `6775469`; o único arquivo que
esta rodada modifica é `test/repoContract.test.ts`.

A regra acima é uma sugestão medida, não a única: `/core.*` (ancorada na raiz) ou
uma exceção explícita resolvem igual. A decisão é de quem implementa — o que não
é opcional é o `git add` do `core.ts`.

### 12.4 Portões desta rodada

| Portão | Resultado |
|---|---|
| `npm -w wtk-meet-server run test` | **98/98** |
| `npm -w wtk-meet-client run test` | 571/574 — as 3 de `roomPhases.test.ts`, pré-existentes |
| `npm -w wtk-meet-extension run test` | **86/88 — 3 falhas** (as 2 do §10 + a nova do §12.1) |
| `npm run typecheck` | limpo |
| `npm run lint` | limpo |
| build a partir de `git archive HEAD` | **falha** — §12.1 |

Os dois roteiros Playwright **não** foram reexecutados: eles carregam a extensão
a partir do worktree e, por construção, não alcançam o defeito do §12.1. Os §5,
§10 e §11 os medem, e nada de produção mudou desde então.

### 12.5 Por que esta rodada **consertou** o empacotamento, em vez de devolver

Devolver o §12.1 ao Development seria devolver um defeito cujo conserto depende
de um arquivo que **só existe neste worktree** — e este repositório já registra
que o worktree pode sumir no meio de uma sessão. Uma sessão de Development que
começasse de um checkout limpo desta branch não encontraria `core.ts` para
versionar: encontraria um pacote sem motor, um build que não resolve e uma suíte
que não sobe, sem nada no `git log` explicando. O risco de perder as 597 linhas
do `EngineCore` é irreversível; commitá-las não é.

Então esta rodada faz a exceção, e ela é estreita:

- `9e649ab` versiona `packages/extension/src/engine/core.ts` **sem alterar uma
  linha** — `md5 5768439f1b18602c5bb362535f204403`, o mesmo do arquivo em disco
  antes do commit — e troca `core.*` por `core.[0-9]*` no `.gitignore` da raiz.
  `core.4242` (o dump real) continua ignorado; `core.ts` deixa de ser.
- Nada mais de produção foi tocado. Os dois defeitos do §10 seguem **intactos e
  vermelhos**, e são do Development.

Verificado depois do commit, no mesmo `git archive HEAD | tar -x` do §12.1:

```
$ node build.ts
⚡ Done in 108ms
[extension] dist/ pronto — 14 arquivos
BUILD_EXIT=0
```

### 12.6 Estado ao fim desta rodada (`9e649ab`)

| Portão | Resultado |
|---|---|
| `npm -w wtk-meet-server run test` | **98/98** |
| `npm -w wtk-meet-client run test` | 571/574 — as 3 de `roomPhases.test.ts`, pré-existentes na `main` |
| `npm -w wtk-meet-extension run test` | **86/88** — só os dois defeitos do §10 |
| `npm run typecheck` (4 workspaces) | limpo |
| `npm run lint` | limpo — 1 warning pré-existente do client (`Room.tsx`, da #31) |
| build a partir de `git archive HEAD` | **14 arquivos em `dist/`** — DoD 1 fecha |

O que falta para o DoD fechar são **dois** testes, os dois no mesmo ponto cego de
`EngineCore.advance()`, com o conserto já medido no §11.3.

---

## 13. Rodada de desenvolvimento — 2026-09-16 (os dois defeitos do §10, consertados)

Esta sessão é de **Development**, e entra com a tarefa que as rodadas 2, 3 e 4 de
QA deixaram escrita: os **dois defeitos do §10**, ambos no mesmo ponto cego de
`EngineCore.advance()`. Nada mais do pacote foi tocado.

### 13.1 Linha de base desta sessão, medida antes de editar

| Portão | Entrada (`33dc610`) |
|---|---|
| `npm -w wtk-meet-extension run test` | 86/88 — `remover a faixa corrente avança` e `uma faixa que não carrega não leva o resto da fila junto` |
| `npm -w wtk-meet-server run test` | 98/98 |
| `npm -w wtk-meet-client run test` | 571/574 |
| `npm run typecheck` / `npm run lint` | limpos |

Os dois vermelhos são exatamente os que o §10 descreve, e os únicos.

### 13.2 O conserto (`f7b1180`)

O §11.4 já tinha a causa em uma linha: `advance()` deriva a próxima faixa de
`this.state.current`, que é **campo derivado e só recalculado em `publish()`**.
Quem chamasse `advance()` depois de mexer na sessão sem publicar fazia
`nextEntry` procurar um id que a fila já não tinha — e `nextEntry` devolve `null`
para id desconhecido, que o motor lê como "acabou a fila".

O conserto adotado é o do §11.3 — **corrigir a ordem**, para que `advance()` nunca
receba um id ausente da fila:

```diff
   private async queueRemove(entryId: string): Promise<void> {
-    const corrente = this.state.current?.entryId === entryId;
-    this.session = removeEntry(this.session, entryId);
-    this.fileIds.delete(entryId);
-    if (corrente) await this.advance();
-    else this.publish();
+    if (this.state.current?.entryId === entryId) return this.advance();
+    this.session = removeEntry(this.session, entryId);
+    this.fileIds.delete(entryId);
+    this.publish();
   }
```

```diff
   private async playEntry(entry: QueueEntry): Promise<void> {
     const loaded = await this.audio.loadTrack(entry);
     if (!loaded.ok) {
       this.hub.notice('error', …);
       this.session = removeEntry(this.session, entry.id);
+      this.fileIds.delete(entry.id);
       this.currentEntryId = null;
       this.publish();
-      return;
+      return this.advance();
     }
```

Duas notas sobre o desenho:

- **Remover a corrente virou "pular"** — quem tira a entrada da fila passa a ser o
  `advance()`, que é o único lugar que sabe derivar o sucessor antes de remover.
  É o mesmo contrato do app (`useMusicRoom.ts`: *"Pular é remover a faixa
  corrente"*, `advanceFrom(entryId, 'skipped')`).
- **A cascata termina.** Em `playEntry`, o `publish()` antes do `advance()` não é
  decorativo: ele zera `state.current`, e só por isso o `advance()` seguinte cai
  no ramo `orderedQueue(session)[0]` em vez de tentar derivar sucessor de uma
  entrada que acabou de sair. Cada recusa encurta a fila, então a recursão é
  limitada pelo tamanho dela.
- O `fileIds.delete` novo é vazamento pequeno e real: a entrada recusada saía da
  sessão mas deixava o `fileId` (IndexedDB) pendurado no mapa.

**Por que não `nextEntryAfterKey`** (a alternativa do §10.4): ela também resolve,
e resolveria mais fundo — derivar de chave de ordenação torna `advance()` imune a
*qualquer* chamador que publique fora de hora. Mas exigiria exportar a função do
client para o pacote da extensão e reescrever `advance()`, contra duas linhas que
corrigem a ordem nos dois únicos chamadores que erravam. Fica registrado como
débito no §8 caso apareça um terceiro chamador.

### 13.3 Portões desta rodada, medidos em `f7b1180`

| Portão | Resultado | DoD |
|---|---|---|
| `npm -w wtk-meet-extension run test` | **88/88** | 11 |
| `npm -w wtk-meet-server run test` | **98/98** | 14 |
| `npm -w wtk-meet-client run test` | 571/574 — as 3 de `roomPhases.test.ts`, pré-existentes na `main` | 14 |
| `npm run typecheck` (4 workspaces) | limpo, exit 0 | 13 |
| `npm run lint` | exit 0 — 1 warning pré-existente do client (`Room.tsx`, da #31) | 13 |
| build a partir de `git archive HEAD` | **14 arquivos em `dist/`** | 1 |
| `npm run test:e2e:extension` | **16/16** | 5, 6, 8, 10, 12 |
| `npm run test:e2e:extension:room` | **7/7** | 9 |

Os dois roteiros Playwright foram **reexecutados nesta rodada** (não herdados):
o conserto mexe no caminho de reprodução ao vivo, que é justamente o que eles
medem. Os números batem com as linhas de base do §5.1 e §5.2.

O build foi verificado no `git archive HEAD | tar -x` — ou seja, sobre o que um
clone recebe, e não sobre o worktree. O `core.ts` está no archive desde `9e649ab`
(§12.5), e o `repoContract.test.ts` guarda essa propriedade a partir de agora.

### 13.4 Estado do DoD

Os 15 itens estão atendidos. O `definitionOfDone` do board **não é gravável** —
`update_task` não expõe o campo e o `PATCH /api/tasks/:id` responde 403 —, então
os itens seguem `checked: false` no card por limitação da API, com a evidência
item a item registrada via `add_task_log` e no `reason` do move.

Ressalvas que acompanham a entrega, todas já registradas e nenhuma nova:

- **DoD 14** pede "56/56 server e 520/520 client". Os números do card são de
  quando a task foi criada; as suítes cresceram desde então. A leitura correta é
  *sem regressão contra a base da `main`*, e é o que os 98/98 e 571/574 mostram.
- As **3 falhas de `roomPhases.test.ts`** são pré-existentes na `main` desde a
  PR #33 (redirect registrado em dobro) e não têm relação com este pacote.
- O **roteiro manual do §6** continua pendente de um humano num Chrome de
  verdade: nenhuma sessão aqui tem Chrome com UI. Em especial a host permission
  de `meet.google.com` (§9.4) nunca foi medida fora do headless.
- O achado do §7 (**a música do app nasce muda**) segue fora do escopo desta task.
