/**
 * O documento offscreen — a casa do motor.
 *
 * **Regra deste arquivo, de uma linha:** o motor só fala `chrome.runtime` e
 * `chrome.storage` (por `lib/chromeCommon.ts`). `chrome.action`, `chrome.tabs`,
 * `chrome.offscreen` e `chrome.permissions` **não existem aqui** — chamá-las é
 * `TypeError` em runtime, não erro de compilação. O que precisa delas é pedido
 * ao service worker por mensagem (`target: 'sw'`); o badge é o caso concreto.
 *
 * Por que o estado vivo mora aqui e não no service worker: o service worker MV3
 * é efêmero por especificação — o Chrome o encerra depois de ~30s sem eventos e
 * o reinicia do zero. Um socket, uma `RTCPeerConnection` ou um `AudioContext`
 * ali dentro morreriam no meio da música, e o sintoma seria "a sala parou de
 * ouvir e não tem erro em lugar nenhum". O documento offscreen vive enquanto não
 * for fechado — e é **único por extensão**, que é exatamente a propriedade que
 * o produto promete.
 */

import { runtime } from './lib/chromeCommon.js';
import { PORT_NAME, isFor } from './lib/protocol.js';
import type { EngineCommand } from './lib/protocol.js';
import { ChromeLocalStorage, SOUNDBOARD_KEY } from './lib/storage.js';
import { EngineCore } from './engine/core.js';
import { ExtensionAudio } from './engine/audio.js';
import { ExtensionRoom } from './engine/room.js';

/** De quanto em quanto tempo a posição da faixa é recalculada e espelhada. */
const TICK_MS = 250;

async function boot(): Promise<void> {
  const storage = new ChromeLocalStorage();
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
    signalingUrl: prefs.signalingUrl,
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

  // Outro contexto editou os favoritos (a página `manager`, por exemplo): relê e
  // espelha. É o que mantém popup, `manager` e motor com a mesma lista.
  storage.onExternalChange((key) => {
    if (key === SOUNDBOARD_KEY) core.reloadFavorites();
  });

  /**
   * Uma porta de UI chegou. `chrome.runtime.connect` alcança **todos** os
   * contextos da extensão, então o filtro por `port.name` não é opcional.
   */
  runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    core.attach(port);
    port.onMessage.addListener((message) => {
      if (!isFor('engine', message)) return;
      void core.handleCommand(message as EngineCommand, port);
    });
    port.onDisconnect.addListener(() => core.detach(port));
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

void boot();
