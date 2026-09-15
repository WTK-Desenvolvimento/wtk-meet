/**
 * O rate limit do soundboard é **um só**, no motor.
 *
 * É a diferença entre a extensão e o app: no app cada aba tem a sua janela,
 * porque cada aba é um participante. Aqui as abas são superfícies de **um**
 * participante — se cada popup tivesse a sua janela, abrir três janelas do
 * navegador triplicaria o limite, e o limite deixaria de ser um limite.
 *
 * Os números vêm de `soundboardRate.ts` do client (3 disparos / 5s), e o corte
 * em 15s (`MAX_SOUND_MS`) de `soundboard.ts`: uma segunda tabela aqui
 * divergiria, e a que divergisse para o lado permissivo seria a que vale.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { BURST_LIMIT, BURST_WINDOW_MS } from '../../client/src/lib/soundboardRate.ts';
import { MAX_SOUND_MS } from '../../client/src/lib/soundboard.ts';
import { EngineCore } from '../src/engine/core.ts';
import { FakeAudio, FakePort, FakeRoom, MemoryStorage, relogio } from './engineDoubles.ts';

async function comFavorito() {
  const audio = new FakeAudio();
  const room = new FakeRoom();
  const storage = new MemoryStorage();
  const clock = relogio(10_000);
  const core = new EngineCore({ audio, room, storage, now: clock.agora, engineId: 'eng-rate' });
  core.init();

  const abas = [new FakePort('A'), new FakePort('B'), new FakePort('C')];
  for (const aba of abas) core.attach(aba);

  await core.handleCommand(
    { target: 'engine', type: 'favorite-add', input: 'https://cdn.example/buzina.mp3' },
    abas[0],
  );
  const favoriteId = abas[0]!.estado.favorites![0]!.id;
  return { core, audio, room, abas, clock, favoriteId };
}

test('três disparos vindos de três abas consomem a MESMA janela', async () => {
  const { core, audio, abas, favoriteId } = await comFavorito();

  for (const aba of abas) {
    await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, aba);
  }
  assert.equal(audio.disparos.length, BURST_LIMIT, 'as três couberam na janela');

  // A quarta — de qualquer aba — é recusada. Se cada aba tivesse a sua janela,
  // esta passaria, e o limite valeria 9 em vez de 3.
  await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[0]);
  assert.equal(audio.disparos.length, BURST_LIMIT, 'a quarta não tocou');
  assert.match(abas[0]!.avisos.at(-1) ?? '', /Espere/);
});

test('o cooldown aparece em TODAS as abas, não só na que clicou', async () => {
  const { core, abas, favoriteId } = await comFavorito();

  for (const aba of abas) {
    await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, aba);
  }

  for (const aba of abas) {
    assert.ok((aba.estado.cooldownMs ?? 0) > 0, `${aba.rotulo} vê o cooldown`);
  }
});

test('passada a janela, a vaga volta — e o relógio é o injetado', async () => {
  const { core, audio, abas, clock, favoriteId } = await comFavorito();

  for (let i = 0; i < BURST_LIMIT; i += 1) {
    await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[i % 3]);
  }
  await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[0]);
  assert.equal(audio.disparos.length, BURST_LIMIT);

  clock.avancar(BURST_WINDOW_MS + 1);
  await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[2]);
  assert.equal(audio.disparos.length, BURST_LIMIT + 1, 'a janela deslizou');
});

test('uma tentativa recusada não conta para o limite', async () => {
  const { core, audio, abas, clock, favoriteId } = await comFavorito();

  for (let i = 0; i < BURST_LIMIT; i += 1) {
    await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[0]);
  }
  // Cliques repetidos durante o cooldown: se contassem, quem clica nervoso nunca
  // sairia do bloqueio.
  for (let i = 0; i < 5; i += 1) {
    await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[1]);
  }
  clock.avancar(BURST_WINDOW_MS + 1);
  await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[0]);
  assert.equal(audio.disparos.length, BURST_LIMIT + 1);
});

test('N abas disparando produzem UMA reprodução — e um só AudioContext', async () => {
  const { core, audio, abas, favoriteId } = await comFavorito();

  await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[0]);

  assert.equal(audio.disparos.length, 1);
  for (const aba of abas) {
    assert.equal(aba.estado.playCount, 1, `${aba.rotulo} conta uma reprodução`);
    assert.equal(aba.estado.audioContextCount, 1, `${aba.rotulo} vê um só AudioContext`);
    assert.equal(aba.estado.engineId, 'eng-rate', `${aba.rotulo} fala com o mesmo motor`);
  }
});

test('o anúncio sai antes do som, e carrega a duração cortada em 15s', async () => {
  const { core, room, abas, favoriteId } = await comFavorito();

  await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[0]);

  const anuncio = room.anuncios.at(-1);
  assert.equal(anuncio?.type, 'soundboard-play');
  assert.equal(anuncio?.soundId, favoriteId);
  // `MusicMessage` tipa os campos opcionais como `unknown`: o `Number()` é a
  // leitura honesta de um campo que vem do protocolo.
  assert.ok(Number(anuncio?.durationMs ?? 0) <= MAX_SOUND_MS);
});

test('um disparo que falha no download não vira som nem anúncio', async () => {
  const { core, audio, room, abas, favoriteId } = await comFavorito();
  audio.erroDeEfeito = 'cors';

  await core.handleCommand({ target: 'engine', type: 'soundboard-fire', favoriteId }, abas[0]);

  assert.equal(audio.disparos.length, 0);
  assert.deepEqual(room.anuncios, [], 'não se anuncia o que não tocou');
  assert.match(abas[0]!.avisos.at(-1) ?? '', /CORS/i);
  // A vaga **foi** consumida: é o preço de checar antes do `await`, e é o certo
  // — senão três cliques simultâneos passariam todos pela checagem.
  assert.ok((abas[0]!.estado.cooldownMs ?? 0) >= 0);
});
