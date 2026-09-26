/**
 * Os favoritos do soundboard **pelo caminho da extensão**.
 *
 * `storage.test.ts` prova que o adaptador de `chrome.storage.local` fala o
 * formato do app sob a mesma chave. Aqui a pergunta é outra: o que acontece
 * quando os comandos da UI passam pelo motor — o teto de 50, a duplicata, o
 * renome, e a lista que muda porque **outro contexto** escreveu.
 *
 * É o item do DoD que diz "até 50 itens, título editável", e ele tem um detalhe
 * que só aparece quando se olha pelo motor: quem grava é o `EngineCore`, e o que
 * ele publica para as abas precisa ser o que ficou **efetivamente** gravado — e
 * não o que a UI pediu. Um teto que recusa em silêncio, ou uma lista que diverge
 * do disco, são a mesma classe de falha: a tela mostra um favorito que não
 * existe mais no reload seguinte.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FAVORITES,
  SCHEMA_VERSION,
  SOUNDBOARD_ERRORS,
  STORAGE_KEY,
} from '../../client/src/lib/soundboard.ts';
import type { SoundboardPreferences } from '../../client/src/lib/soundboard.ts';
import { EngineCore } from '../src/engine/core.ts';
import { FakeAudio, FakePort, FakeRoom, MemoryStorage, relogio } from './engineDoubles.ts';

function motor() {
  const audio = new FakeAudio();
  const room = new FakeRoom();
  const storage = new MemoryStorage();
  const clock = relogio(1000);
  const core = new EngineCore({ audio, room, storage, now: clock.agora, engineId: 'eng-fav' });
  core.init();
  const aba = new FakePort('A');
  core.attach(aba);
  return { core, storage, aba };
}

function favoritar(core: EngineCore, input: string, aba?: FakePort) {
  return core.handleCommand({ target: 'engine', type: 'favorite-add', input }, aba);
}

/** O que está **no disco**, não o que a UI tem na tela. */
function gravado(storage: MemoryStorage): SoundboardPreferences {
  return JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as SoundboardPreferences;
}

test('o documento gravado é o do app: mesma chave, mesma versão de esquema', async () => {
  const { core, storage, aba } = motor();

  await favoritar(core, 'https://cdn.example/buzina.mp3', aba);

  const disco = gravado(storage);
  assert.equal(disco.version, SCHEMA_VERSION);
  assert.equal(disco.favorites.length, 1);
  assert.equal(disco.favorites[0]?.sourceRef, 'https://cdn.example/buzina.mp3');
  assert.equal(disco.favorites[0]?.title, 'buzina');
  // É este formato idêntico que permite copiar a lista do app para a extensão e
  // vice-versa sem conversão nenhuma.
  assert.equal(typeof disco.favorites[0]?.addedAt, 'number');
});

test('a mesma URL duas vezes é recusada com a mensagem do app', async () => {
  const { core, aba } = motor();
  await favoritar(core, 'https://cdn.example/buzina.mp3', aba);

  await favoritar(core, 'https://cdn.example/buzina.mp3', aba);

  assert.equal(aba.estado.favorites?.length, 1);
  assert.equal(aba.avisos.at(-1), SOUNDBOARD_ERRORS.duplicate);
});

test('o teto de 50 favoritos vale no motor, e a recusa diz o que fazer', async () => {
  const { core, storage, aba } = motor();
  for (let i = 0; i < MAX_FAVORITES; i += 1) {
    await favoritar(core, `https://cdn.example/efeito-${i}.mp3`, aba);
  }
  assert.equal(aba.estado.favorites?.length, MAX_FAVORITES);

  await favoritar(core, 'https://cdn.example/um-a-mais.mp3', aba);

  assert.equal(aba.estado.favorites?.length, MAX_FAVORITES, 'o 51º não entrou');
  assert.equal(gravado(storage).favorites.length, MAX_FAVORITES, 'e nem chegou ao disco');
  assert.equal(aba.avisos.at(-1), SOUNDBOARD_ERRORS.full);
});

test('renomear muda o título na tela e no disco, nos dois ao mesmo tempo', async () => {
  const { core, storage, aba } = motor();
  await favoritar(core, 'https://cdn.example/buzina.mp3', aba);
  const favoriteId = aba.estado.favorites![0]!.id;

  await core.handleCommand(
    { target: 'engine', type: 'favorite-rename', favoriteId, title: 'Buzina do vizinho' },
    aba,
  );

  assert.equal(aba.estado.favorites?.[0]?.title, 'Buzina do vizinho');
  assert.equal(gravado(storage).favorites[0]?.title, 'Buzina do vizinho');
});

test('remover tira das duas abas e do disco', async () => {
  const { core, storage, aba } = motor();
  const outra = new FakePort('B');
  core.attach(outra);
  await favoritar(core, 'https://cdn.example/buzina.mp3', aba);
  const favoriteId = aba.estado.favorites![0]!.id;

  await core.handleCommand({ target: 'engine', type: 'favorite-remove', favoriteId }, aba);

  assert.equal(aba.estado.favorites?.length, 0);
  assert.equal(outra.estado.favorites?.length, 0, 'a aba que não clicou também soube');
  assert.equal(gravado(storage).favorites.length, 0);
});

test('uma escrita vinda de outro contexto espelha em todas as abas', async () => {
  const { core, storage, aba } = motor();
  const outra = new FakePort('B');
  core.attach(outra);

  // É o que acontece quando a página `manager` edita a lista: quem escreve é
  // outro contexto, e o motor sabe pelo `storage-changed` do service worker.
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: SCHEMA_VERSION,
      favorites: [{ id: 's-externo', title: 'Veio da manager', sourceRef: 'https://cdn.example/x.mp3', addedAt: 1 }],
      mutedAll: false,
      monitorVolume: 1,
      soundboardVolume: 1,
    }),
  );
  core.reloadFavorites();

  for (const porta of [aba, outra]) {
    assert.equal(porta.estado.favorites?.length, 1);
    assert.equal(porta.estado.favorites?.[0]?.title, 'Veio da manager');
  }
});

test('uma URL que não serve como efeito não entra — e o texto é o do app', async () => {
  const { core, storage, aba } = motor();

  await favoritar(core, 'javascript:alert(1)', aba);

  assert.equal(aba.estado.favorites?.length, 0);
  assert.equal(storage.getItem(STORAGE_KEY), null, 'nada foi gravado por uma recusa');
  assert.equal(aba.avisos.at(-1), SOUNDBOARD_ERRORS['unsupported-scheme']);
});
