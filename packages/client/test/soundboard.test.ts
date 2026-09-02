/**
 * Favoritos do soundboard, o limitador de disparo e o anúncio que trafega.
 *
 * O que importa aqui é o que **não** deve acontecer: `javascript:` virando
 * favorito, `localStorage` com lixo derrubando o painel, o teto de 50 itens
 * gravando truncado em silêncio, e o quarto disparo em 5s passando. Tudo isso é
 * puro — nenhum caso abaixo precisa de navegador, de timer real ou de jsdom.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MAX_FAVORITES,
  MAX_SOUND_MS,
  MAX_SOURCE_REF,
  MAX_TITLE,
  SOUNDBOARD_ERRORS,
  STORAGE_KEY,
  addFavorite,
  parseFavoriteInput,
  readSoundboard,
  removeFavorite,
  renameFavorite,
  writeSoundboard,
} = await import('../src/lib/soundboard.js');

const { BURST_LIMIT, BURST_WINDOW_MS, consume, createRateState, retryInMs } = await import(
  '../src/lib/soundboardRate.js'
);

const { MUSIC_MESSAGE_TYPES, sanitizeMusicMessage, soundboardPlayMessage } = await import(
  '../src/lib/musicProtocol.js'
);

import type { PreferenceStorage, SoundboardPreferences } from '../src/lib/soundboard.js';

/** Um `localStorage` de mentira, com o conteúdo inicial que o caso quiser. */
function fakeStorage(initial: string | null = null) {
  let valor = initial;
  const calls: string[] = [];
  const storage: PreferenceStorage & { get value(): string | null; calls: string[] } = {
    getItem(key: string) {
      calls.push(`get:${key}`);
      return valor;
    },
    setItem(key: string, value: string) {
      calls.push(`set:${key}`);
      valor = value;
    },
    get value() {
      return valor;
    },
    calls,
  };
  return storage;
}

const SOM = 'https://cdn.exemplo.com/media/sounds/bruh.mp3';

// ------------------------------------------------------------------ parsing

test('URL http(s) de áudio vira favorito com título derivado do nome do arquivo', () => {
  const parsed = parseFavoriteInput(SOM);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.sourceRef, SOM);
  assert.equal(parsed.title, 'bruh');
});

test('esquemas perigosos são recusados com mensagem, um a um', () => {
  for (const entrada of [
    'javascript:alert(1)',
    'data:audio/mpeg;base64,AAAA',
    'blob:https://exemplo.com/9a1b',
    'file:///home/alguem/bruh.mp3',
  ]) {
    const parsed = parseFavoriteInput(entrada);
    assert.equal(parsed.ok, false, `deveria recusar ${entrada}`);
    if (parsed.ok) continue;
    assert.equal(parsed.reason, 'unsupported-scheme');
    assert.ok(SOUNDBOARD_ERRORS[parsed.reason], 'toda recusa tem mensagem');
  }
});

test('texto solto, campo vazio e link de YouTube são recusados com razões distintas', () => {
  assert.deepEqual(parseFavoriteInput(''), { ok: false, reason: 'empty' });
  assert.deepEqual(parseFavoriteInput('bruh'), { ok: false, reason: 'unsupported' });
  assert.deepEqual(parseFavoriteInput('https://youtu.be/dQw4w9WgXcQ'), {
    ok: false,
    reason: 'youtube-disabled',
  });
});

test('URL acima de MAX_SOURCE_REF é recusada antes de virar favorito', () => {
  const longa = `https://cdn.exemplo.com/${'a'.repeat(MAX_SOURCE_REF)}.mp3`;
  assert.ok(longa.length > MAX_SOURCE_REF);
  const parsed = parseFavoriteInput(longa);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.reason, 'too-long');
});

test('título default é truncado em MAX_TITLE', () => {
  const parsed = parseFavoriteInput(`https://cdn.exemplo.com/${'b'.repeat(400)}.mp3`);
  // A URL inteira passa de MAX_SOURCE_REF, então esta é curta o bastante:
  const curta = parseFavoriteInput(`https://cdn.exemplo.com/${'b'.repeat(200)}.mp3`);
  assert.equal(parsed.ok, false); // 400 caracteres estouram o limite da URL
  assert.equal(curta.ok, true);
  if (!curta.ok) return;
  assert.equal(curta.title.length, MAX_TITLE);
});

// ---------------------------------------------------------------- favoritos

test('favoritar duas vezes a mesma URL não duplica, e recusa com mensagem', () => {
  const um = addFavorite(null, SOM, { now: 10, id: 'a' });
  assert.equal(um.ok, true);
  assert.equal(um.prefs.favorites.length, 1);
  const dois = addFavorite(um.prefs, SOM, { now: 20, id: 'b' });
  assert.equal(dois.ok, false);
  assert.equal(dois.reason, 'duplicate');
  assert.equal(dois.prefs.favorites.length, 1);
});

test('no teto de MAX_FAVORITES a adição é recusada, não gravada truncada', () => {
  let prefs: SoundboardPreferences | null = null;
  for (let i = 0; i < MAX_FAVORITES; i += 1) {
    const r = addFavorite(prefs, `https://cdn.exemplo.com/s${i}.mp3`, { now: i, id: `f${i}` });
    assert.equal(r.ok, true, `favorito ${i} deveria caber`);
    prefs = r.prefs;
  }
  assert.equal(prefs?.favorites.length, MAX_FAVORITES);
  const excedente = addFavorite(prefs, 'https://cdn.exemplo.com/gota.mp3', { now: 99, id: 'x' });
  assert.equal(excedente.ok, false);
  assert.equal(excedente.reason, 'full');
  assert.equal(excedente.prefs.favorites.length, MAX_FAVORITES);
  assert.ok(SOUNDBOARD_ERRORS.full.includes(String(MAX_FAVORITES)));
});

test('renomear troca só o título; título vazio volta ao default da URL', () => {
  const { prefs } = addFavorite(null, SOM, { now: 1, id: 'a' });
  const renomeado = renameFavorite(prefs, 'a', '  Bruh   sound  ');
  assert.equal(renomeado.favorites[0]!.title, 'Bruh sound');
  assert.equal(renomeado.favorites[0]!.sourceRef, SOM);
  assert.equal(renameFavorite(renomeado, 'a', '   ').favorites[0]!.title, 'bruh');
});

test('remover por id inexistente devolve a lista intacta', () => {
  const { prefs } = addFavorite(null, SOM, { now: 1, id: 'a' });
  assert.equal(removeFavorite(prefs, 'nao-existe').favorites.length, 1);
  assert.equal(removeFavorite(prefs, 'a').favorites.length, 0);
});

// ----------------------------------------------------------------- storage

test('o que foi gravado sobrevive à releitura (o reload da aba)', () => {
  const storage = fakeStorage();
  const { prefs } = addFavorite(readSoundboard(storage), SOM, { now: 5, id: 'a' });
  writeSoundboard(storage, prefs);
  assert.ok(storage.calls.includes(`set:${STORAGE_KEY}`));

  const relido = readSoundboard(storage);
  assert.equal(relido.favorites.length, 1);
  assert.equal(relido.favorites[0]!.sourceRef, SOM);
  assert.equal(relido.favorites[0]!.title, 'bruh');
});

test('mute global persiste; nada mais além do que o esquema declara', () => {
  const storage = fakeStorage();
  writeSoundboard(storage, { mutedAll: true, monitorVolume: 0.4 });
  const relido = readSoundboard(storage);
  assert.equal(relido.mutedAll, true);
  assert.equal(relido.monitorVolume, 0.4);
  assert.deepEqual(Object.keys(JSON.parse(storage.value!)).sort(), [
    'favorites',
    'monitorVolume',
    'mutedAll',
    'soundboardVolume',
    'version',
  ]);
});

test('storage corrompido resolve para lista vazia, sem lançar', () => {
  for (const bruto of [
    'isto não é json',
    '{',
    'null',
    '[]',
    '"texto"',
    '{"version":99,"favorites":[{"id":"a","sourceRef":"https://x.com/a.mp3"}]}',
  ]) {
    const prefs = readSoundboard(fakeStorage(bruto));
    assert.deepEqual(prefs.favorites, [], `esperava lista vazia para ${bruto}`);
    assert.equal(prefs.mutedAll, false);
  }
});

test('item malformado é descartado sem levar os favoritos válidos junto', () => {
  const bruto = JSON.stringify({
    version: 1,
    favorites: [
      { id: 'a', sourceRef: 'javascript:alert(1)', title: 'mau' },
      { id: 'b', sourceRef: SOM, title: 'bom', addedAt: 3 },
      { sourceRef: 'https://cdn.exemplo.com/sem-id.mp3' },
      'nem objeto é',
      { id: 'c', sourceRef: SOM, title: 'duplicata do bom' },
    ],
  });
  const prefs = readSoundboard(fakeStorage(bruto));
  assert.equal(prefs.favorites.length, 1);
  assert.equal(prefs.favorites[0]!.id, 'b');
});

test('storage ausente ou lançando cai nos defaults, sem exceção', () => {
  assert.deepEqual(readSoundboard(null).favorites, []);
  assert.deepEqual(readSoundboard(undefined).favorites, []);
  const explosivo: PreferenceStorage = {
    getItem() {
      throw new Error('modo privado');
    },
    setItem() {
      throw new Error('cota estourada');
    },
  };
  assert.deepEqual(readSoundboard(explosivo).favorites, []);
  // Gravar num storage que lança não quebra a chamada: só não persiste.
  const efetivo = writeSoundboard(explosivo, { mutedAll: true });
  assert.equal(efetivo.mutedAll, true);
});

test('a leitura poda a lista gravada ao teto, mesmo que alguém a infle à mão', () => {
  const favorites = Array.from({ length: MAX_FAVORITES + 10 }, (_, i) => ({
    id: `f${i}`,
    sourceRef: `https://cdn.exemplo.com/s${i}.mp3`,
    title: `s${i}`,
    addedAt: i,
  }));
  const prefs = readSoundboard(fakeStorage(JSON.stringify({ version: 1, favorites })));
  assert.equal(prefs.favorites.length, MAX_FAVORITES);
});

// ------------------------------------------------------------- rate limit

test(`${BURST_LIMIT} disparos passam na janela; o seguinte não`, () => {
  let state = createRateState();
  for (let i = 0; i < BURST_LIMIT; i += 1) {
    const d = consume(state, 1000 + i * 100);
    assert.equal(d.allowed, true, `disparo ${i + 1} deveria passar`);
    state = d.state;
  }
  const quarto = consume(state, 1300);
  assert.equal(quarto.allowed, false);
  assert.ok(quarto.retryInMs > 0);
});

test('a recusa não conta para o limite — clicar de novo não estende o cooldown', () => {
  let state = createRateState();
  for (let i = 0; i < BURST_LIMIT; i += 1) state = consume(state, 1000).state;
  const primeira = consume(state, 1500);
  const segunda = consume(primeira.state, 1600);
  assert.equal(primeira.allowed, false);
  assert.equal(segunda.allowed, false);
  // Só o tempo que passou encurtou a espera; a segunda tentativa não a alongou.
  assert.equal(primeira.retryInMs, BURST_WINDOW_MS - 500);
  assert.equal(segunda.retryInMs, BURST_WINDOW_MS - 600);
});

test('passada a janela, a vaga volta — e o relógio é o do parâmetro', () => {
  let state = createRateState();
  for (let i = 0; i < BURST_LIMIT; i += 1) state = consume(state, 1000).state;
  assert.equal(consume(state, 1000 + BURST_WINDOW_MS - 1).allowed, false);
  const depois = consume(state, 1000 + BURST_WINDOW_MS);
  assert.equal(depois.allowed, true);
  assert.equal(retryInMs(depois.state, 1000 + BURST_WINDOW_MS), 0);
});

test('carimbo do futuro (relógio que andou para trás) não bloqueia disparo', () => {
  const state = [10_000_000, 10_000_001, 10_000_002];
  assert.equal(consume(state, 1000).allowed, true);
});

test('estado corrompido (nulo, não-array, item que não é número) é tratado como vazio', () => {
  assert.equal(consume(null, 1).allowed, true);
  assert.equal(consume(undefined, 1).allowed, true);
  assert.equal(consume(['x', NaN, Infinity] as unknown as number[], 1).allowed, true);
  assert.equal(retryInMs(null, 1), 0);
});

// ------------------------------------------------------- anúncio no fio

test('o anúncio entra na tabela de tipos, e um client antigo o ignoraria', () => {
  assert.ok(MUSIC_MESSAGE_TYPES.has('soundboard-play'));
  const message = soundboardPlayMessage({ soundId: 'a', title: 'Bruh', durationMs: 1200 });
  assert.equal(message.type, 'soundboard-play');
  // Nenhuma URL trafega: quem recebe não baixa nada.
  assert.deepEqual(Object.keys(message).sort(), ['durationMs', 'soundId', 'title', 'type']);
});

test('a autoria é a conexão: um campo `from` no payload é ignorado, não validado', () => {
  const sanitized = sanitizeMusicMessage(
    { type: 'soundboard-play', soundId: 'a', title: 'Bruh', durationMs: 900, from: 'vitima' },
    { fromPeerId: 'alice' },
  );
  assert.equal(sanitized?.type, 'soundboard-play');
  if (sanitized?.type !== 'soundboard-play') return;
  assert.equal(sanitized.peerId, 'alice');
});

test('duração hostil vira teto; anúncio sem soundId é descartado', () => {
  const gigante = sanitizeMusicMessage(
    { type: 'soundboard-play', soundId: 'a', title: 'x', durationMs: 600_000 },
    { fromPeerId: 'alice' },
  );
  assert.equal(gigante?.type === 'soundboard-play' && gigante.durationMs, MAX_SOUND_MS);

  const negativa = sanitizeMusicMessage(
    { type: 'soundboard-play', soundId: 'a', title: 'x', durationMs: -5 },
    { fromPeerId: 'alice' },
  );
  assert.equal(negativa?.type === 'soundboard-play' && negativa.durationMs, 0);

  assert.equal(
    sanitizeMusicMessage({ type: 'soundboard-play', title: 'x' }, { fromPeerId: 'alice' }),
    null,
  );
  assert.equal(
    sanitizeMusicMessage(
      { type: 'soundboard-play', soundId: 'a' },
      { fromPeerId: '' },
    ),
    null,
  );
});

test('título ausente ou não-texto cai no default, e é truncado', () => {
  const semTitulo = sanitizeMusicMessage(
    { type: 'soundboard-play', soundId: 'a', durationMs: 1 },
    { fromPeerId: 'alice' },
  );
  assert.equal(semTitulo?.type === 'soundboard-play' && semTitulo.title, 'Efeito');

  const enorme = sanitizeMusicMessage(
    { type: 'soundboard-play', soundId: 'a', title: 'x'.repeat(500), durationMs: 1 },
    { fromPeerId: 'alice' },
  );
  assert.equal(enorme?.type === 'soundboard-play' && enorme.title.length, 120);
});
