/**
 * A página `manager`: fila completa, arquivo local, favoritos e configuração.
 *
 * Por que ela existe em vez de tudo caber no popup: o popup **fecha quando perde
 * o foco**, e abrir um seletor de arquivo tira o foco dele — o diálogo abre, o
 * popup morre, a promessa nunca resolve e o arquivo some. `pickAudioFile` do
 * client usa exatamente as duas APIs que sofrem disso (`showOpenFilePicker` e um
 * `<input type="file">` temporário). Uma aba comum não tem esse problema, e
 * ainda dá espaço para uma fila que não caberia em 360 px.
 *
 * O arquivo escolhido vai para o **IndexedDB da origem da extensão**, e o que
 * viaja até o motor é só o `fileId`: `File` e `Blob` não atravessam mensagem de
 * extensão (a serialização é JSON), e um object URL criado aqui seria revogado
 * quando esta aba fosse descarregada — o áudio pararia ao fechar a página.
 */

import { formatDuration } from '../../client/src/lib/musicSources.js';
import { generateRoomSlug } from '../../client/src/lib/roomSlug.js';
import { pickAudioFile, saveAudioFile } from '../../client/src/lib/audioFileStorage.js';
import { EngineClient } from './ui/engineClient.js';
import { emptyState } from './lib/protocol.js';
import type { EngineState } from './lib/protocol.js';
import { ChromeLocalStorage } from './lib/storage.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  status: $<HTMLSpanElement>('status'),
  queue: $<HTMLOListElement>('queue'),
  urlForm: $<HTMLFormElement>('url-form'),
  urlInput: $<HTMLInputElement>('url-input'),
  fileAdd: $<HTMLButtonElement>('file-add'),
  favorites: $<HTMLUListElement>('favorites'),
  favForm: $<HTMLFormElement>('fav-form'),
  favInput: $<HTMLInputElement>('fav-input'),
  displayName: $<HTMLInputElement>('display-name'),
  signaling: $<HTMLInputElement>('signaling'),
  appUrl: $<HTMLInputElement>('app-url'),
  save: $<HTMLButtonElement>('save'),
  randomRoom: $<HTMLButtonElement>('random-room'),
  invite: $<HTMLParagraphElement>('invite'),
  notice: $<HTMLParagraphElement>('notice'),
};

const storage = new ChromeLocalStorage();
let state: EngineState = emptyState();

const client = new EngineClient({
  onState: (next) => {
    state = next;
    render();
  },
  onNotice: ({ text }) => {
    els.notice.hidden = false;
    els.notice.textContent = text;
  },
  onLost: () => {
    els.status.textContent = 'o motor caiu — recarregue esta página';
  },
});

function render(): void {
  els.status.textContent = state.status;
  els.status.dataset.status = state.status;

  els.queue.replaceChildren(
    ...state.queue.map((entry) => {
      const item = document.createElement('li');
      const titulo = document.createElement('span');
      titulo.textContent =
        entry.entryId === state.current?.entryId
          ? `▶ ${entry.title} · ${formatDuration(state.current.positionSec)}`
          : `${entry.title}${entry.durationSec ? ` · ${formatDuration(entry.durationSec)}` : ''}`;
      const remover = document.createElement('button');
      remover.type = 'button';
      remover.textContent = 'Remover';
      remover.dataset.testid = `remove-${entry.entryId}`;
      remover.addEventListener('click', () =>
        client.send({ target: 'engine', type: 'queue-remove', entryId: entry.entryId }),
      );
      item.append(titulo, remover);
      return item;
    }),
  );

  els.favorites.replaceChildren(
    ...state.favorites.map((favorite) => {
      const item = document.createElement('li');
      const titulo = document.createElement('input');
      titulo.type = 'text';
      titulo.value = favorite.title;
      titulo.dataset.testid = `title-${favorite.id}`;
      // O título é editável: renomear grava na mesma chave e todas as abas veem.
      titulo.addEventListener('change', () =>
        client.send({
          target: 'engine',
          type: 'favorite-rename',
          favoriteId: favorite.id,
          title: titulo.value,
        }),
      );
      const disparar = document.createElement('button');
      disparar.type = 'button';
      disparar.textContent = 'Disparar';
      disparar.addEventListener('click', () =>
        client.send({ target: 'engine', type: 'soundboard-fire', favoriteId: favorite.id }),
      );
      const remover = document.createElement('button');
      remover.type = 'button';
      remover.textContent = 'Remover';
      remover.addEventListener('click', () =>
        client.send({ target: 'engine', type: 'favorite-remove', favoriteId: favorite.id }),
      );
      item.append(titulo, disparar, remover);
      return item;
    }),
  );
}

els.urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const sourceRef = els.urlInput.value.trim();
  if (!sourceRef) return;
  client.send({ target: 'engine', type: 'queue-add', source: { kind: 'url', sourceRef } });
  els.urlInput.value = '';
});

els.fileAdd.addEventListener('click', async () => {
  const file = await pickAudioFile();
  if (!file) return;
  const fileId = `ef-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await saveAudioFile(fileId, file);
  client.send({
    target: 'engine',
    type: 'queue-add',
    source: { kind: 'file', fileId, title: file.name },
  });
});

els.favForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = els.favInput.value.trim();
  if (!input) return;
  client.send({ target: 'engine', type: 'favorite-add', input });
  els.favInput.value = '';
});

els.save.addEventListener('click', () => {
  const prefs = storage.readPreferences();
  const next = storage.writePreferences({
    ...prefs,
    displayName: els.displayName.value,
    signalingUrl: els.signaling.value,
    appUrl: els.appUrl.value,
  });
  els.displayName.value = next.displayName;
  els.signaling.value = next.signalingUrl;
  els.appUrl.value = next.appUrl;
  els.notice.hidden = false;
  els.notice.textContent = 'Salvo. A URL do servidor vale já na próxima conexão.';
});

/**
 * "Usar um endereço aleatório" é a mitigação barata para o endereço derivado do
 * código da reunião: quem não quer que a sala seja adivinhável a partir do Meet
 * clica aqui e dita o endereço por voz.
 */
els.randomRoom.addEventListener('click', () => {
  const slug = generateRoomSlug();
  const prefs = storage.writePreferences({ ...storage.readPreferences(), lastRoom: slug });
  els.invite.textContent = `Próxima sala: ${slug} — convite: ${prefs.appUrl.replace(/\/$/, '')}/${slug}`;
});

async function boot(): Promise<void> {
  await storage.hydrate();
  const prefs = storage.readPreferences();
  els.displayName.value = prefs.displayName;
  els.signaling.value = prefs.signalingUrl;
  els.appUrl.value = prefs.appUrl;
  if (prefs.lastRoom) {
    els.invite.textContent = `Última sala: ${prefs.lastRoom} — convite: ${prefs.appUrl.replace(/\/$/, '')}/${prefs.lastRoom}`;
  }
  await client.start();
  render();
}

void boot();
