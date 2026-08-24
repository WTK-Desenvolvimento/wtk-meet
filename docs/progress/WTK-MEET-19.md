# WTK-MEET-19 — Entrar na sala com a câmera desligada, com tela de pré-entrada

**Status: implementação concluída e validada.** Branch
`agent/wtk-meet-19-toda-vez-q-alguem-entra-na-sala-j-vem-co`. Documento de
arquitetura seguido: `docs/agents/arch-temp-entrada-camera-desligada-lobby.md`.
**O DoD do board não conflitou com o documento desta vez** — os 15 itens do board
são os mesmos 15 critérios de aceite técnicos do §8, na mesma ordem. É a primeira
vez em várias tasks que não há divergência a declarar (ver WTK-MEET-10, 11 e 12).

## O problema

`getLocalStream` (`Room.jsx`) pedia `getUserMedia({ video: true, audio: true })`
como primeira tentativa, e `cameraOff` nascia `useState(false)`. Somados: **abrir
o link de uma sala acendia o LED da webcam antes de qualquer decisão de quem
abriu**, e o vídeo saía para todo mundo assim que a entrada era aprovada. O único
ponto de decisão antes da conexão era um campo de texto com um botão — sem
preview e sem nenhuma escolha sobre mídia.

Havia um segundo defeito, raro até aqui e que esta entrega tornaria o caso comum:
`VideoTile` decidia `showVideo = !!stream && !cameraOff`, e um stream **só de
áudio** satisfaz `!!stream`. Como o registro de participante nascia sem o campo
`cameraOff` (`!!undefined === false`), o tile do recém-chegado montava um
`<video>` sem track de vídeo — um retângulo preto no lugar do placeholder.

## O que foi feito

| Arquivo | Mudança |
|---|---|
| `lib/devices.js` | `startCameraOff` (default `true`) e `initialMediaPlan` puro |
| `components/PreJoin.jsx` | **novo** — o lobby, com preview opt-in |
| `pages/Room.jsx` | `cameraOff` da preferência, ramo do lobby, `DEFAULT_PARTICIPANT` |
| `components/VideoTile.jsx` | placeholder quando o stream não tem track de vídeo |
| `styles.css` | estilos do lobby |
| `test/devices.test.mjs` | 6 casos do campo novo + 2 literais atualizados |
| `test/joinCameraDefault.test.mjs` | **novo** — 13 casos |
| `e2e/harness.mjs` | opção `cameraOn`, entrada pelo lobby, `videoRequested` |
| `e2e/run.mjs` | seção **P** nova, checks A10–A14 e E0a–E0d, E./S. reordenadas |
| `README.md`, `ARCHITECTURE.md` | fluxo, subseção da pré-entrada, §6.1 e §6.10 |

`webrtcMesh.js` **não foi tocado**, de propósito: os quatro `addTransceiver`
continuam incondicionais, o canal de câmera nasce vazio e "Ativar câmera" segue
sendo `replaceTrack`. Confirmado no E2E (E0b/E0c), não alterado no código.

### A armadilha que o documento previu e que se confirmou

Com `startCameraOff`, a cadeia de fallback **colapsa**: a primeira e a segunda
tentativa viram a mesma requisição. `initialMediaPlan` devolve **duas**
tentativas nesse caso, não três com uma repetida — um `getUserMedia` a mais numa
falha é meio segundo de espera que ninguém entende.

### Correções de passagem, declaradas

1. O cabeçalho de `lib/devices.js` e o comentário de `Room.jsx:118` citavam
   `ARCHITECTURE.md §6.8` para a exceção de persistência. §6.8 é "Destaque de
   compartilhamento de tela"; a seção certa é **§6.10**.
2. §6.1 do `ARCHITECTURE.md` dizia "três transceivers". São **quatro** desde que
   a música entrou (mic, câmera, tela, música) — o texto ficou para trás do
   código.

## Divergência com o roteiro antigo do E2E

O roteiro assumia que **todo mundo entra com a câmera ligada**. Duas
consequências, e a segunda é a perigosa:

1. A seção E. abria com "Desligar câmera", um botão que deixou de existir na
   entrada — a suíte parava ali. Verificado antes de mexer: 38/38 e então um
   timeout de 30s.
2. Silenciosa: a checagem **E3** ("peers remotos mostram placeholder") passaria a
   ser trivialmente verdadeira **desde antes do clique**. Verde sem verificar
   nada.

Correção: o harness ganhou a opção `cameraOn` (default `false`, que é o caminho
de 100% dos usuários) e a seção E. passou a **ligar** a câmera e **esperar o
placeholder sumir** no tile remoto antes de desligar. E. continua terminando com
a câmera ligada, que é o que a seção S. pressupõe.

Dois checks precisaram acompanhar o comportamento novo:

- **S7** afirmava "exatamente as quatro chaves" em `wtk-meet:devices`. São cinco.
- **S16** (preferência obsoleta se corrige sozinha) passou a falhar de verdade, e
  a falha estava **certa**: `reconcilePreferences` compara o que foi pedido com o
  que o navegador abriu, e sem track de câmera não existe "o que foi aberto".
  Entrar desligado deixa o `videoInputId` obsoleto gravado — comportamento
  correto, e não o que a checagem existe para verificar. O Dave passou a entrar
  pelo lobby com a câmera **ligada**, que é o cenário que o check descreve.

## Validação

| Item | Resultado |
|------|-----------|
| `cd client && npm test` | ✅ **438/438** (426 antes; +12 desta entrega) |
| `cd client && npm run lint` | ✅ limpo |
| `node e2e/run.mjs` | ✅ **134/135** — a única falha é a F4a, pré-existente |

O placar do E2E era **119/120** (F4a falhando) antes desta entrega; foram +15
checagens (6 da seção P do lobby, 5 da entrada sem vídeo, 4 do primeiro
acendimento da câmera).

### O que as checagens novas provam

- **P2** — abrir o link de uma sala faz `getUserMedia === 0` e
  `localStorage === null`. Não é "chamado e negado": é **não chamado**. É a
  diferença entre o LED piscar e não acender.
- **A13** — o tile do recém-chegado nunca existiu sem `.video-placeholder`. Um
  `MutationObserver` instalado **antes** de a terceira aba entrar, e não um
  `waitFor` depois: um `waitFor` que encontra o placeholder prova só que ele está
  lá agora, não que esteve lá o tempo todo.
- **E0c** — ligar a câmera pela primeira vez não move `setLocalDescription`
  (6 → 6). É a prova de que o canal que nasceu vazio dispensa renegociação.

## Débito identificado, NÃO corrigido

- **F4a do E2E** — falha desde antes desta branch, alheia a esta entrega. Sem
  mudança de status.
- **Quem vem da Home nunca vê o toggle.** Pela decisão D1 do documento, o caminho
  Home → sala não passa pelo lobby (o nome já está em `sessionStorage`). Quem só
  cria salas pela Home não tem como **persistir** "entrar com a câmera ligada" —
  vai clicar em "Ativar câmera" toda vez. O padrão de fábrica (desligada) é o
  seguro, então é lacuna, não regressão. Encaminhamento sugerido: expor o toggle
  no `SettingsModal`, que é alcançável da Home, seguindo o precedente do
  `noiseSuppression` (um campo que o modal carrega mesmo morando em outra chave).
  Não feito agora: alarga o contrato do modal no meio de uma entrega de
  privacidade. Documentado no README.

## Três sessões simultâneas na mesma task

Esta task teve **três** sessões no mesmo worktree (dev, UI e QA), ativadas quase
ao mesmo tempo. A fronteira foi negociada **por arquivo**, não por trecho, antes
de qualquer escrita em disco: a sessão de UI entregou `PreJoin.jsx` e o bloco de
CSS do lobby; as outras duas encerraram no meio (`ListAgents` → "No reachable
agents") e o restante — núcleo, testes, E2E e documentação — foi feito nesta
sessão. Rodar `ListAgents` antes da primeira escrita é o que evitou o
sobrescrever mútuo; combinar por arquivo (e não "você faz a metade de baixo do
Room.jsx") é o que tornou a fronteira verificável com `git status`.
