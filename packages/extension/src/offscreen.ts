/**
 * O documento offscreen — a casa do motor.
 *
 * **Regra deste arquivo, de uma linha:** o motor só fala `chrome.runtime` e
 * `chrome.storage` (por `lib/chromeCommon.ts`). `chrome.action`, `chrome.tabs`,
 * `chrome.offscreen` e `chrome.permissions` **não existem aqui** — chamá-las é
 * `TypeError` em runtime, não erro de compilação. O que precisa delas é pedido
 * ao service worker por mensagem (`target: 'sw'`); o badge é o caso concreto.
 * O lint recusa o global `chrome` neste arquivo, para que a regra falhe antes
 * do navegador.
 *
 * Por que o estado vivo mora aqui e não no service worker: o service worker MV3
 * é efêmero por especificação — o Chrome o encerra depois de ~30s sem eventos e
 * o reinicia do zero. Um socket, uma `RTCPeerConnection` ou um `AudioContext`
 * ali dentro morreriam no meio da música, e o sintoma seria "a sala parou de
 * ouvir e não tem erro em lugar nenhum". O documento offscreen vive enquanto não
 * for fechado — e é **único por extensão**, que é exatamente a propriedade que
 * o produto promete.
 *
 * **O `onConnect` é registrado no primeiro tique, antes de qualquer `await`.**
 * O boot do motor é assíncrono (ele espera o `chrome.storage` hidratar), e quem
 * abre o popup chama `ensure-engine` e conecta a porta em seguida — se o
 * listener só existisse depois do `await`, a primeira porta conectaria a
 * ninguém: a aba ficaria com a tela vazia e sem erro, e só um segundo popup
 * funcionaria. As portas que chegam durante o boot ficam numa fila e são
 * anexadas quando o motor existe.
 */

import { runtime } from './lib/chromeCommon.js';
import { PORT_NAME, isFor } from './lib/protocol.js';
import type { EngineCommand } from './lib/protocol.js';
import { ChromeLocalStorage, SOUNDBOARD_KEY, messageBackend } from './lib/storage.js';
import { EngineCore } from './engine/core.js';
import { ExtensionAudio } from './engine/audio.js';
import { ExtensionRoom } from './engine/room.js';
import type { PortLike } from './lib/hub.js';

/** De quanto em quanto tempo a posição da faixa é recalculada e espelhada. */
const TICK_MS = 250;

/** O motor, quando existir. As portas que chegarem antes esperam na fila. */
let motor: EngineCore | null = null;
/**
 * Por que o motor não subiu, quando não sobe.
 *
 * Um boot que rejeita em silêncio é a pior falha possível aqui: o documento
 * existe, o `ping` responde, e a UI fica esperando um estado que nunca vem —
 * sem erro em lugar nenhum. O motivo viaja na resposta do `ping` para que o
 * service worker (e quem estiver depurando) possa vê-lo.
 */
let falhaNoBoot: string | null = null;
const fila: ChromePort[] = [];
/**
 * Comandos que chegaram antes de o motor existir.
 *
 * Descartá-los seria a falha silenciosa clássica desta arquitetura: a página
 * `manager` abre, cria o documento offscreen e manda `queue-add` no mesmo
 * segundo — o motor ainda está hidratando o storage, o comando cai num
 * `motor?.` e some. Quem clicou vê um botão que não fez nada, sem erro.
 */
const comandosPendentes: { comando: EngineCommand; porta: ChromePort }[] = [];

function aceitar(port: ChromePort): void {
  if (!motor) {
    fila.push(port);
    return;
  }
  motor.attach(port as PortLike);
}

runtime.onConnect.addListener((port) => {
  // `chrome.runtime.connect` alcança **todos** os contextos da extensão — o
  // filtro por nome não é opcional.
  if (port.name !== PORT_NAME) return;
  aceitar(port);
  port.onMessage.addListener((message) => {
    if (!isFor('engine', message)) return;
    const comando = message as EngineCommand;
    if (!motor) {
      comandosPendentes.push({ comando, porta: port });
      return;
    }
    void motor.handleCommand(comando, port as PortLike);
  });
  port.onDisconnect.addListener(() => {
    motor?.detach(port as PortLike);
    const i = fila.indexOf(port);
    if (i >= 0) fila.splice(i, 1);
  });
});

/**
 * O handshake do service worker.
 *
 * `ensure-engine` só pode responder "pronto" quando **este** script já rodou:
 * `chrome.offscreen.createDocument` resolve quando o documento existe, o que é
 * cedo demais — a porta que a UI abre em seguida chegaria a um `onConnect` sem
 * listener, seria desconectada na hora, e o popup mostraria uma tela vazia sem
 * nenhum erro. Este `ping` é a diferença entre "o documento existe" e "o motor
 * atende".
 */
runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isFor('engine', message) || (message as { type: string }).type !== 'ping') return undefined;
  sendResponse({ ready: motor !== null, error: falhaNoBoot });
  return undefined;
});

async function boot(): Promise<void> {
  // `messageBackend`, e não o direto: **o documento offscreen não tem
  // `chrome.storage`** (ver o cabeçalho de `lib/storage.ts`). Usar o direto aqui
  // é um `TypeError` dentro de um boot assíncrono — o documento sobe, responde
  // ao `ping`, e a UI espera para sempre um estado que nunca chega.
  const storage = new ChromeLocalStorage(messageBackend());
  await storage.hydrate();
  const prefs = storage.readPreferences();

  // Identidade desta instância. Duas abas vendo o mesmo `engineId` é a prova de
  // que **um** motor atendeu as duas (é o que o E2E afirma).
  const engineId = `eng-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const audio: ExtensionAudio = new ExtensionAudio({
    fileIdOf: (entryId) => core.fileIdOf(entryId),
    onEnded: () => void core.advance(),
    onError: (reason) => core.onTrackError(reason),
    onBlocked: () =>
      core.setStatus(core.snapshot().status, 'O navegador bloqueou a reprodução — clique em tocar.'),
  });

  const room = new ExtensionRoom({
    getSignalingUrl: () => storage.readPreferences().signalingUrl,
    getMusicTrack: () => audio.musicTrack(),
    events: {
      onStatus: (status, detail) => core.setStatus(status, detail),
      onPeers: (peers) => core.setPeers(peers),
      onPendingJoins: (pending) => core.setPendingJoins(pending),
      onRemoteMusic: (peerId, stream) => playRemoteMusic(peerId, stream),
    },
  });

  const core: EngineCore = new EngineCore({
    audio,
    room,
    storage,
    engineId,
    now: () => performance.now(),
    onBadge: (badge) => {
      // `chrome.action` é do service worker. Aqui só se pede.
      void runtime.sendMessage({ target: 'sw', type: 'badge', ...badge }).catch(() => {
        // Sem receptor (o SW ainda não acordou): o próximo `publish` repete.
      });
    },
  });
  core.init();
  audio.setMonitorVolume(prefs.volume);

  motor = core;
  // As portas que chegaram durante o boot recebem o snapshot agora…
  for (const port of fila.splice(0)) core.attach(port as PortLike);
  // …e o que elas mandaram nesse meio-tempo é executado, na ordem em que chegou.
  for (const { comando, porta } of comandosPendentes.splice(0)) {
    await core.handleCommand(comando, porta as PortLike);
  }

  // Outro contexto editou os favoritos (a página `manager`, por exemplo): relê e
  // espelha. É o que mantém popup, `manager` e motor com a mesma lista.
  storage.onExternalChange((key) => {
    if (key === SOUNDBOARD_KEY) core.reloadFavorites();
  });

  // O tique só existe quando há alguém olhando: a posição da faixa muda a cada
  // 250 ms, e calculá-la com o popup fechado é trabalho que ninguém vê.
  setInterval(() => {
    if (core.viewers === 0) return;
    core.refreshCooldown();
  }, TICK_MS);

  // Um peer novo pode entrar depois de o grafo de áudio existir; reatar o track
  // é idempotente e barato.
  setInterval(() => {
    if (core.snapshot().status === 'connected') room.refreshMusicTrack();
  }, 5_000);
}

/**
 * O canal de música de outro peer. Duas extensões na mesma sala ouvem a música
 * uma da outra — e nada mais: voz e tela não chegam aqui (ver `engine/room.ts`).
 */
function playRemoteMusic(peerId: string, stream: MediaStream): void {
  const id = `remote-music-${peerId}`;
  let element = document.getElementById(id) as HTMLAudioElement | null;
  if (!element) {
    element = document.createElement('audio');
    element.id = id;
    element.autoplay = true;
    document.body.appendChild(element);
  }
  element.srcObject = stream;
  void element.play().catch(() => {
    // Autoplay bloqueado num documento sem gesto: o motor continua transmitindo
    // o que **ele** toca; ouvir os outros é um extra.
  });
}

void boot().catch((err: unknown) => {
  falhaNoBoot = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error('[offscreen] o motor não subiu:', err);
});
