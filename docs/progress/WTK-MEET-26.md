# WTK-MEET-26 — Extensão Chrome (MV3) com motor de áudio único

> Documento de arquitetura: `docs/agents/arch-temp-extensao-chrome-motor-audio-unico.md`
> Branch: `agent/wtk-meet-26-quero-criar-uma-extens-o-para-o-navegado`
> Início: 2026-09-15 · Status: **COMPLETED**

O registro do que a implementação encontrou: a linha de base medida antes de
qualquer alteração, as três decisões que o documento deixou em aberto e como
foram resolvidas, o que o documento afirmava sobre a plataforma e **não era
verdade**, e o que fica como débito.

---

## 1. Linha de base, medida nesta branch antes de qualquer alteração

| Portão | Valor | Observação |
|---|---|---|
| `npm test` (client) | **571/574** | 3 falhas **pré-existentes** em `test/roomPhases.test.ts` |
| `npm test` (server) | 98/98 | |
| `npm run typecheck` | limpo | |
| `npm run lint` | limpo | 1 warning pré-existente em `useMusicRoom.ts` |

As três falhas do client são de redirecionamento duplo (`"/a/b" devia voltar para
a Home` e as duas irmãs): o efeito de canonicalização navega **duas** vezes onde o
teste espera uma. Medidas em `1e88073`, **antes** de qualquer arquivo desta
entrega existir, e em arquivos que esta entrega não toca. O número da memória do
projeto (520/520) é de uma linha de base mais velha — a suíte cresceu desde então.

O E2E de 3 participantes (`npm run test:e2e`) **não** foi executado nesta branch:
nada em `packages/client` ou `packages/server` muda por esta entrega, exceto um
comentário em `pages/Room.tsx` (§4). Os dois roteiros novos da extensão foram
executados, e estão descritos no §5.

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

### 3.4 `context.route` do Playwright **não alcança** o documento offscreen

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

Roteiro com servidor de sinalização, TURN local, o app e a extensão na mesma sala.
Duas coisas do ambiente que ele precisa resolver, e que são o mesmo problema de um
deploy real: a origem `chrome-extension://<id>` no `CLIENT_ORIGIN` (o caminho que o
README documenta) e o TURN, que entra pelo proxy (§3.4).

### 5.3 O que **não** foi medido nesta sessão

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

## 7. Débito identificado

- **O proxy do MyInstants continua em aberto**, e agora em dois lugares: no app
  (que precisaria de um proxy no servidor) e na extensão (que precisaria de
  permissão de host ampla). Decisão de produto, não de implementação.
- **`packages/extension/src/lib/signaling.ts` duplica os nomes de evento** do
  client. A mitigação é um teste de caracterização que lê os dois arquivos do
  client e falha quando alguém renomeia um evento em um lado só.
- **As três falhas de `roomPhases.test.ts`** continuam na `main` (§1). Não são
  desta entrega e não foram tocadas aqui.
