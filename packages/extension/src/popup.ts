/**
 * O popup: conectar, transporte, volume, disparar favoritos e aprovar quem pede
 * para entrar.
 *
 * DOM direto, sem framework. A superfície é pequena e orientada a evento, e três
 * bundles autocontidos (`background`, `offscreen`, `popup`/`manager`) sem
 * `splitting` é o que mantém a extensão livre de `import()` dinâmico sob
 * `chrome-extension://` — ver `ARCHITECTURE.md` §11.9.
 *
 * **O popup não guarda estado.** Ele desenha o que o motor manda. Fechá-lo
 * desconecta a porta e o motor volta a ficar mudo — sem parar de tocar.
 *
 * O que **não** está aqui, de propósito: `<input type="file">`. O popup fecha
 * quando perde o foco, e abrir um seletor de arquivo tira o foco dele — o
 * diálogo abre, o popup morre, a promessa nunca resolve e o arquivo some. Quem
 * tem seletor de arquivo é a página `manager`, que é uma aba comum (§11.10).
 */

import { formatDuration } from '../../client/src/lib/musicSources.js';
import { normalizeRoomPathInput } from '../../client/src/lib/roomSlug.js';
import { EngineClient } from './ui/engineClient.js';
import { emptyState } from './lib/protocol.js';
import type { EngineState } from './lib/protocol.js';
import { ChromeLocalStorage } from './lib/storage.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  status: $<HTMLSpanElement>('status'),
  room: $<HTMLInputElement>('room'),
  prefillNotice: $<HTMLParagraphElement>('prefill-notice'),
  name: $<HTMLInputElement>('name'),
  connect: $<HTMLButtonElement>('connect'),
  disconnect: $<HTMLButtonElement>('disconnect'),
  pendingBox: $<HTMLElement>('pending-box'),
  pending: $<HTMLUListElement>('pending'),
  current: $<HTMLParagraphElement>('current'),
  play: $<HTMLButtonElement>('play'),
  pause: $<HTMLButtonElement>('pause'),
  skip: $<HTMLButtonElement>('skip'),
  volume: $<HTMLInputElement>('volume'),
  favorites: $<HTMLDivElement>('favorites'),
  favForm: $<HTMLFormElement>('fav-form'),
  favInput: $<HTMLInputElement>('fav-input'),
  cooldown: $<HTMLSpanElement>('cooldown'),
  notice: $<HTMLParagraphElement>('notice'),
  manage: $<HTMLButtonElement>('manage'),
  diag: $<HTMLSpanElement>('diag'),
};

const STATUS_TEXT: Record<EngineState['status'], string> = {
  idle: 'desligado',
  connecting: 'conectando…',
  'waiting-approval': 'esperando aprovação',
  connected: 'na sala',
  denied: 'entrada recusada',
  error: 'erro',
};

const storage = new ChromeLocalStorage();
let state: EngineState = emptyState();

const client = new EngineClient({
  onState: (next) => {
    state = next;
    render();
  },
  onNotice: ({ kind, text }) => showNotice(text, kind),
  onLost: () => {
    els.status.textContent = 'o motor caiu — reabra para reconectar';
  },
});

function showNotice(text: string, kind: 'error' | 'info' = 'error'): void {
  els.notice.hidden = false;
  els.notice.textContent = text;
  els.notice.dataset.kind = kind;
}

function render(): void {
  els.status.textContent = state.lastError
    ? `${STATUS_TEXT[state.status]} · ${state.lastError}`
    : STATUS_TEXT[state.status];
  els.status.dataset.status = state.status;

  const naSala = state.status === 'connected' || state.status === 'waiting-approval';
  els.connect.disabled = naSala;
  els.disconnect.disabled = !naSala;
  if (naSala && state.roomPath) els.room.value = state.roomPath;

  els.current.textContent = state.current
    ? `${state.current.title} · ${formatDuration(state.current.positionSec)} / ${formatDuration(
        state.current.durationSec,
      )}${state.current.playing ? '' : ' (pausado)'}`
    : state.queue.length
      ? `${state.queue.length} na fila, nada tocando`
      : 'nada na fila';

  els.volume.value = String(state.volume);
  els.cooldown.textContent = state.cooldownMs > 0 ? `aguarde ${Math.ceil(state.cooldownMs / 1000)}s` : '';

  // A sonda do E2E (ver `popup.html`). Escrita no render para acompanhar o
  // estado sem um caminho próprio de atualização.
  els.diag.dataset.engineId = state.engineId;
  els.diag.dataset.playCount = String(state.playCount);
  els.diag.dataset.audioContexts = String(state.audioContextCount);
  els.diag.dataset.queueLength = String(state.queue.length);
  els.diag.dataset.favorites = String(state.favorites.length);
  els.diag.dataset.cooldownMs = String(state.cooldownMs);
  els.diag.dataset.playing = String(!!state.current?.playing);
  els.diag.dataset.position = String(Math.round(state.current?.positionSec ?? 0));
  els.diag.dataset.peers = String(state.peers.length);
  els.diag.dataset.audioState = state.audioState;
  els.diag.dataset.outputLevel = String(state.outputLevel);

  renderPending();
  renderFavorites();
}

function renderPending(): void {
  els.pendingBox.hidden = state.pendingJoins.length === 0;
  els.pending.replaceChildren(
    ...state.pendingJoins.map((join) => {
      const item = document.createElement('li');
      const nome = document.createElement('span');
      nome.textContent = join.displayName;
      const sim = document.createElement('button');
      sim.type = 'button';
      sim.textContent = 'Aprovar';
      sim.dataset.testid = `approve-${join.requesterId}`;
      sim.addEventListener('click', () =>
        client.send({
          target: 'engine',
          type: 'join-decision',
          requesterId: join.requesterId,
          approve: true,
        }),
      );
      const nao = document.createElement('button');
      nao.type = 'button';
      nao.textContent = 'Negar';
      nao.addEventListener('click', () =>
        client.send({
          target: 'engine',
          type: 'join-decision',
          requesterId: join.requesterId,
          approve: false,
        }),
      );
      item.append(nome, sim, nao);
      return item;
    }),
  );
}

function renderFavorites(): void {
  els.favorites.replaceChildren(
    ...state.favorites.map((favorite) => {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'efeito';
      botao.textContent = favorite.title;
      botao.dataset.testid = `fire-${favorite.id}`;
      botao.disabled = state.cooldownMs > 0;
      botao.addEventListener('click', () =>
        client.send({ target: 'engine', type: 'soundboard-fire', favoriteId: favorite.id }),
      );
      return botao;
    }),
  );
  if (!state.favorites.length) {
    const vazio = document.createElement('p');
    vazio.className = 'nota';
    vazio.textContent = 'Nenhum favorito ainda — cole a URL de um efeito abaixo.';
    els.favorites.replaceChildren(vazio);
  }
}

// ------------------------------------------------------------------ eventos

els.connect.addEventListener('click', () => {
  const roomPath = els.room.value.trim();
  const displayName = els.name.value.trim();
  const prefs = storage.readPreferences();
  storage.writePreferences({ ...prefs, lastRoom: roomPath, displayName });
  client.send({ target: 'engine', type: 'connect', roomPath, displayName });
});

els.disconnect.addEventListener('click', () => client.send({ target: 'engine', type: 'disconnect' }));
els.play.addEventListener('click', () => client.send({ target: 'engine', type: 'transport', action: 'play' }));
els.pause.addEventListener('click', () => client.send({ target: 'engine', type: 'transport', action: 'pause' }));
els.skip.addEventListener('click', () => client.send({ target: 'engine', type: 'transport', action: 'skip' }));

els.volume.addEventListener('input', () =>
  client.send({ target: 'engine', type: 'volume', value: Number(els.volume.value) }),
);

els.room.addEventListener('input', () => {
  // Normaliza enquanto se digita, com a mesma regra do app — o valor que vira
  // endereço passa por `normalizeRoomPath` no motor de qualquer jeito.
  els.room.value = normalizeRoomPathInput(els.room.value);
});

els.favForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = els.favInput.value.trim();
  if (!input) return;
  client.send({ target: 'engine', type: 'favorite-add', input });
  els.favInput.value = '';
});

els.manage.addEventListener('click', () => EngineClient.openManager());

// --------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  await storage.hydrate();
  const prefs = storage.readPreferences();
  els.name.value = prefs.displayName;
  els.volume.value = String(prefs.volume);

  // O campo de sala: código da reunião da aba ativa, se houver; senão a última
  // sala usada — **com a razão escrita na tela**, para que "não preencheu" nunca
  // seja uma coisa que a pessoa tenha que adivinhar.
  const prefill = await EngineClient.prefill();
  els.room.value = prefill.value;
  els.room.dataset.fromMeet = String(prefill.fromMeet);
  if (prefill.notice) {
    els.prefillNotice.hidden = false;
    els.prefillNotice.textContent = prefill.notice;
  }

  await client.start();
  render();
}

void boot();
