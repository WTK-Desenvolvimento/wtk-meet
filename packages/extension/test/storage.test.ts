/**
 * O adaptador que dá cara de `localStorage` ao `chrome.storage.local`.
 *
 * O que se afirma aqui é o contrato que os favoritos dependem:
 *
 * - a chave é `wtk-meet:soundboard` e o valor é a **mesma string JSON** que o
 *   app grava no `localStorage` (é o que permite copiar a lista de um lado para
 *   o outro sem conversão);
 * - a leitura é síncrona depois do `hydrate` — `lib/soundboard.ts` do client é
 *   puro e síncrono de propósito, e não tem onde esperar uma promessa;
 * - uma escrita de **outro contexto** chega por `chrome.storage.onChanged` e
 *   atualiza o cache, que é o que mantém popup, `manager` e motor com a mesma
 *   lista.
 *
 * O dublê de `chrome` é montado antes do import porque `lib/chromeCommon.ts`
 * lê o global no topo do módulo — exatamente como acontece no navegador.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

const disco = new Map<string, string>();
const listeners: Listener[] = [];

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: 'teste',
    getURL: (path: string) => `chrome-extension://teste/${path}`,
    onConnect: { addListener() {} },
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
  },
  storage: {
    local: {
      async get(keys: string[]) {
        const out: Record<string, unknown> = {};
        for (const key of keys) if (disco.has(key)) out[key] = disco.get(key);
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) disco.set(key, String(value));
      },
      async remove() {},
    },
    onChanged: {
      addListener(listener: Listener) {
        listeners.push(listener);
      },
    },
  },
};

const { ChromeLocalStorage, EXTENSION_KEY, SOUNDBOARD_KEY, sanitizePreferences } = await import(
  '../src/lib/storage.ts'
);
const { addFavorite, readSoundboard, writeSoundboard } = await import(
  '../../client/src/lib/soundboard.ts'
);

test('a chave dos favoritos é a mesma do app', () => {
  assert.equal(SOUNDBOARD_KEY, 'wtk-meet:soundboard');
});

test('depois do hydrate, a leitura é síncrona e o formato é o do app', async () => {
  // Uma lista gravada pelo app, verbatim.
  const doApp = writeSoundboard(null, addFavorite(readSoundboard(null), 'https://cdn.example/a.mp3', { now: 1 }).prefs);
  disco.set(SOUNDBOARD_KEY, JSON.stringify(doApp));

  const storage = new ChromeLocalStorage();
  await storage.hydrate();

  const lido = readSoundboard(storage);
  assert.equal(lido.favorites.length, 1);
  assert.equal(lido.favorites[0]?.sourceRef, 'https://cdn.example/a.mp3');
});

test('a escrita é write-through: vai para o cache e para o disco', async () => {
  const storage = new ChromeLocalStorage();
  await storage.hydrate();

  const prefs = addFavorite(readSoundboard(storage), 'https://cdn.example/b.mp3', { now: 2 }).prefs;
  writeSoundboard(storage, prefs);

  assert.equal(readSoundboard(storage).favorites.length, prefs.favorites.length);
  // O `set` do `chrome.storage.local` é assíncrono; um tique basta.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.parse(disco.get(SOUNDBOARD_KEY)!).favorites.length, prefs.favorites.length);
});

test('uma escrita de outro contexto chega pelo onChanged', async () => {
  const storage = new ChromeLocalStorage();
  await storage.hydrate();
  const visto: string[] = [];
  storage.onExternalChange((key) => visto.push(key));

  const novo = JSON.stringify({ version: 1, favorites: [], mutedAll: true, monitorVolume: 1, soundboardVolume: 1 });
  for (const listener of listeners) listener({ [SOUNDBOARD_KEY]: { newValue: novo } }, 'local');

  assert.deepEqual(visto, [SOUNDBOARD_KEY]);
  assert.equal(readSoundboard(storage).mutedAll, true);
});

test('mudança em outra área (`sync`) é ignorada', async () => {
  const storage = new ChromeLocalStorage();
  await storage.hydrate();
  const antes = storage.getItem(SOUNDBOARD_KEY);
  for (const listener of listeners) listener({ [SOUNDBOARD_KEY]: { newValue: 'lixo' } }, 'sync');
  assert.equal(storage.getItem(SOUNDBOARD_KEY), antes);
});

test('preferência corrompida vira default, sem lançar', () => {
  assert.equal(sanitizePreferences(undefined).displayName, 'Música (extensão)');
  assert.equal(sanitizePreferences({ volume: 'alto' }).volume, 1);
  assert.equal(sanitizePreferences({ volume: 12 }).volume, 1, 'volume é clampado');
  assert.equal(sanitizePreferences({ displayName: '   ' }).displayName, 'Música (extensão)');
  assert.equal(sanitizePreferences({ lastRoom: 'x'.repeat(200) }).lastRoom.length, 64);
});

test('as preferências da extensão têm chave própria — não misturam com favoritos', async () => {
  const storage = new ChromeLocalStorage();
  await storage.hydrate();
  storage.writePreferences({ ...storage.readPreferences(), lastRoom: 'abc-defg-hij' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(EXTENSION_KEY, 'wtk-meet:extension');
  assert.equal(JSON.parse(disco.get(EXTENSION_KEY)!).lastRoom, 'abc-defg-hij');
  assert.ok(disco.has(SOUNDBOARD_KEY), 'os favoritos continuam na chave deles');
});
