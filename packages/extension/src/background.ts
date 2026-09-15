/**
 * O service worker: um roteador sem estado, dono do ciclo de vida do documento
 * offscreen e a única mão que pinta o badge.
 *
 * Ele faz **três** coisas, e nada mais:
 *
 * 1. Garantir que o documento offscreen existe (`ensure-engine`).
 * 2. Responder o que só ele pode ver — a URL da aba ativa (`prefill`) — e abrir
 *    a página `manager`.
 * 3. Escrever o badge e o título do ícone quando o motor pede.
 *
 * Nenhum estado vivo mora aqui, e isso não é estilo: o Chrome encerra o service
 * worker depois de ~30s sem eventos e o reinicia do zero. Qualquer coisa
 * guardada em variável de módulo some no meio da música — e um `setInterval`
 * "para manter vivo" não mantém (o SW não é dono do documento offscreen),
 * esconde o problema e queima bateria.
 */

import { prefillFromTab } from './lib/meetCode.js';
import { ChromeLocalStorage } from './lib/storage.js';
import { isFor } from './lib/protocol.js';

const OFFSCREEN_PATH = 'offscreen.html';

/**
 * Guarda contra a corrida do `createDocument`.
 *
 * Só pode existir **um** documento offscreen, e a segunda chamada concorrente
 * **lança** — dois cliques rápidos, ou o popup e a `manager` abertos juntos,
 * reproduzem isso na primeira semana. A promessa em memória resolve o caso
 * comum; o `hasDocument()` resolve o caso em que o service worker foi reiniciado
 * entre as duas chamadas, que a memória sozinha não cobre.
 */
let ensuring: Promise<void> | null = null;

async function ensureEngine(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (ensuring) return ensuring;
  ensuring = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      // A ordem importa: `WEB_RTC` primeiro. O Chrome documenta fechamento
      // automático de documentos criados só por `AUDIO_PLAYBACK` depois de um
      // período sem áudio — e um fechamento levaria junto o socket, o mesh e a
      // sala, com o popup ainda dizendo "conectado".
      reasons: ['WEB_RTC', 'AUDIO_PLAYBACK'],
      justification:
        'Mantém um único motor de áudio (fila, player e soundboard) e a conexão WebRTC com a sala wtk-meet, compartilhado por todas as abas.',
    })
    .catch(async (err: unknown) => {
      // "Only a single offscreen document may be created" é sucesso disfarçado:
      // outro contexto ganhou a corrida.
      if (await chrome.offscreen.hasDocument()) return;
      throw err;
    })
    .finally(() => {
      ensuring = null;
    });
  return ensuring;
}

/** O endereço sugerido para o campo de sala, lido da aba ativa. */
async function prefill(): Promise<{ value: string; fromMeet: boolean; notice: string | null }> {
  const storage = new ChromeLocalStorage();
  await storage.hydrate();
  const { lastRoom } = storage.readPreferences();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // `pendingUrl` cobre a aba que ainda está navegando — sem ele, abrir o popup
  // no instante em que a reunião carrega devolveria "não é o Meet".
  const url = tab?.url || tab?.pendingUrl;
  return prefillFromTab(url, lastRoom);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // `chrome.runtime` entrega a **todos** os contextos: sem este filtro, o
  // service worker responderia mensagens que a UI mandou para o motor.
  if (!isFor('sw', message)) return undefined;

  switch (message.type) {
    case 'ensure-engine':
      ensureEngine().then(
        () => sendResponse({ ok: true }),
        (err: unknown) => sendResponse({ ok: false, error: String(err) }),
      );
      return true;

    case 'prefill':
      prefill().then(
        (result) => sendResponse({ target: 'ui', type: 'prefill', ...result }),
        () => sendResponse({ target: 'ui', type: 'prefill', value: '', fromMeet: false, notice: null }),
      );
      return true;

    case 'open-manager':
      void chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
      return undefined;

    case 'badge': {
      // A única superfície que o motor não alcança. Pedido dele, escrito aqui.
      const text = message.pending > 0 ? String(message.pending) : message.playing ? '♪' : '';
      void chrome.action.setBadgeText({ text });
      void chrome.action.setBadgeBackgroundColor({ color: message.pending > 0 ? '#c2410c' : '#1d4ed8' });
      void chrome.action.setTitle({
        title: message.title || 'wtk-meet — motor de áudio',
      });
      return undefined;
    }

    default:
      return undefined;
  }
});

/**
 * Nada de reconectar sozinho no `onStartup`: conectar é sempre ato explícito.
 * Um motor que entra em sala ao abrir o navegador é áudio vindo de lugar nenhum
 * — e o caminho que a pessoa encontra para parar é desinstalar a extensão.
 *
 * O `onInstalled` existe só para deixar o badge limpo.
 */
chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeText({ text: '' });
});

