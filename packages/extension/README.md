# wtk-meet — extensão Chrome (MV3)

Um motor de áudio **único** — uma fila, um player, um soundboard, um
`AudioContext` — compartilhado por todas as abas e conectado a uma sala wtk-meet
paralela, que serve de canal de transmissão para quem está no app.

A documentação de produto está no [README da raiz](../../README.md#extensão-chrome-um-motor-de-áudio-para-todas-as-abas)
(instalação, uso, `CLIENT_ORIGIN`) e o desenho está no
[`ARCHITECTURE.md` §11](../../ARCHITECTURE.md). Este arquivo é para quem vai
**mexer no código**.

## Comandos

```bash
npm run build:extension   # (da raiz) gera dist/, carregável sem compactação
npm run pack:extension    # (da raiz) empacota dist/ em release/wtk-meet-extension-v<versão>.zip
npm test                  # (da raiz) inclui os unitários daqui
npm run test:e2e:extension        # duas abas, um motor só
npm run test:e2e:extension:room   # o app ouve o que sai do motor
```

## Os três contextos, e quem pode o quê

| Contexto | Arquivo | O que tem |
|---|---|---|
| Service worker | `src/background.ts` | `chrome.offscreen`, `chrome.tabs`, `chrome.action`, `chrome.storage`. **Efêmero**: nenhum estado vivo mora aqui |
| Documento offscreen (**o motor**) | `src/offscreen.ts`, `src/engine/` | `chrome.runtime` e nada mais — nem `chrome.storage` |
| UI (popup e `manager`) | `src/popup.ts`, `src/manager.ts` | `chrome.runtime`, `chrome.storage` |

**O motor só fala `chrome.runtime`.** `chrome.storage` é `undefined` num documento
offscreen (medido, não deduzido), e `chrome.tabs`/`chrome.action` também não
existem ali. Tudo o mais é pedido ao service worker por mensagem
(`target: 'sw'`), e o lint recusa o global `chrome` em `offscreen.ts` e em
`engine/` para que a regra falhe antes do navegador.

## Onde procurar cada coisa

```
src/background.ts     service worker: ciclo de vida do offscreen, badge, prefill, disco
src/offscreen.ts      boot do motor; o onConnect é registrado antes de qualquer await
src/engine/core.ts    o motor: fila, favoritos, rate limit, espelhamento. Sem DOM, sem chrome
src/engine/audio.ts   AudioContext, MusicEngine, SoundboardPlayer, medidor de saída
src/engine/room.ts    sinalização + WebRTCMesh; sem getRoomKey e sem localStream
src/lib/protocol.ts   união discriminada das mensagens e o EngineState (puro)
src/lib/hub.ts        o espelho: snapshot no attach, deltas depois (puro)
src/lib/meetCode.ts   URL do Meet → endereço da sala (puro)
src/lib/storage.ts    chrome.storage.local com cara de localStorage; dois backends
test/                 node --test sobre o que é puro, com dublês em engineDoubles.ts
```

Os módulos do client (`musicEngine`, `soundboardPlayer`, `soundboard`,
`soundboardRate`, `musicSources`, `musicSession`, `musicProtocol`, `webrtcMesh`,
`iceServers`, `audioFileStorage`, `roomSlug`) entram por **import relativo**, sem
cópia — copiar produz divergência, e este repositório já pagou por isso.

## Depurar

- `chrome://extensions` → "service worker" abre o DevTools do SW; o documento
  offscreen aparece na mesma lista de views quando existe.
- O popup expõe uma sonda invisível (`#diag`) com `engineId`, `playCount`,
  `audioContexts`, `audioState`, `outputLevel` e `lastCommand`. É o que os
  roteiros E2E leem, e é o primeiro lugar a olhar quando "a sala não ouve":
  `outputLevel` em zero com a faixa tocando é silêncio digital saindo daqui;
  `outputLevel` alto e ninguém ouvindo é problema do outro lado.
- Recarregar a extensão em `chrome://extensions` mata o documento offscreen: o
  popup passa a mostrar "o motor caiu".
