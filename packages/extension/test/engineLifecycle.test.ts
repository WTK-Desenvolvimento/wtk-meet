/**
 * O ciclo de vida do motor visto de fora: badge, status da sala e desligamento.
 *
 * Três superfícies que o motor **não** desenha e que, por isso, são fáceis de
 * quebrar sem ninguém ver:
 *
 * - **o badge do ícone.** O motor não tem `chrome.action` (ele mora no documento
 *   offscreen); ele pede, e o service worker pinta. O que se afirma aqui é o
 *   pedido: contagem de pedidos de entrada, "está tocando" e o título. Com o
 *   popup fechado, o badge é a **única** coisa que avisa que alguém está
 *   batendo na porta da sala (critério 8 do §8);
 * - **o motivo da recusa.** `join-denied` com `room-full` precisa explicar que a
 *   extensão ocupa uma das seis vagas — sem isso, o relato que chega é "a sala
 *   está cheia e não entrou ninguém a mais" (critério 9);
 * - **o desligamento.** Desconectar tem que zerar o que era da sala. Um peer
 *   fantasma na lista depois de sair é a tela dizendo que há gente ouvindo
 *   quando não há (critério 10).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EngineCore } from '../src/engine/core.ts';
import { FakeAudio, FakePort, FakeRoom, MemoryStorage, relogio } from './engineDoubles.ts';

interface Badge {
  pending: number;
  playing: boolean;
  title: string;
}

function motor() {
  const audio = new FakeAudio();
  const room = new FakeRoom();
  const storage = new MemoryStorage();
  const clock = relogio(1000);
  const badges: Badge[] = [];
  const core = new EngineCore({
    audio,
    room,
    storage,
    now: clock.agora,
    engineId: 'eng-vida',
    onBadge: (badge) => badges.push(badge),
  });
  core.init();
  const aba = new FakePort('A');
  core.attach(aba);
  return { core, audio, room, aba, badges };
}

test('o badge leva a contagem de pedidos de entrada — é o que avisa com o popup fechado', () => {
  const { core, badges } = motor();

  core.setPendingJoins([
    { requesterId: 'p1', displayName: 'Alice' },
    { requesterId: 'p2', displayName: 'Bruno' },
  ]);

  assert.equal(badges.at(-1)?.pending, 2);
});

test('o badge diz o que está tocando, com o título da faixa', async () => {
  const { core, badges, aba } = motor();

  await core.handleCommand(
    { target: 'engine', type: 'queue-add', source: { kind: 'url', sourceRef: 'https://cdn.example/uma.mp3' } },
    aba,
  );

  assert.equal(badges.at(-1)?.playing, true);
  assert.match(badges.at(-1)?.title ?? '', /^Tocando: uma$/);
});

test('sem faixa tocando, o título volta a ser vazio — o padrão do ícone', async () => {
  const { core, badges, aba } = motor();
  await core.handleCommand(
    { target: 'engine', type: 'queue-add', source: { kind: 'url', sourceRef: 'https://cdn.example/uma.mp3' } },
    aba,
  );

  await core.handleCommand({ target: 'engine', type: 'transport', action: 'pause' }, aba);

  assert.equal(badges.at(-1)?.playing, false);
  assert.equal(badges.at(-1)?.title, '');
});

test('o motivo da recusa da sala chega à UI, e não só ao console', () => {
  const { core, aba } = motor();

  core.setStatus('denied', 'A sala está cheia (o limite é 6, e o motor da extensão ocupa uma das vagas).');

  assert.equal(aba.estado.status, 'denied');
  assert.match(aba.estado.lastError ?? '', /vaga/);
});

test('`room-full` explica que a extensão ocupa uma vaga (caracterização de `engine/room.ts`)', () => {
  // A tabela `DENY_REASONS` é privada do módulo e o `ExtensionRoom` só se monta
  // com socket e `RTCPeerConnection` de verdade — fora do alcance do
  // `node --test`. Ler o fonte é o que resta, e é o mesmo recurso (e o mesmo
  // motivo) de `signalingContract.test.ts`: o teste não impede a mudança, ele
  // faz alguém *ver* que a mensagem some.
  const fonte = readFileSync(fileURLToPath(new URL('../src/engine/room.ts', import.meta.url)), 'utf8');
  const tabela = fonte.slice(fonte.indexOf('DENY_REASONS'), fonte.indexOf('export class'));
  assert.match(tabela, /'room-full'/);
  assert.match(tabela, /vaga/, 'a recusa por sala cheia precisa citar a vaga que a extensão ocupa');
});

test('desconectar zera o que era da sala e desliga uma vez só', async () => {
  const { core, room, aba } = motor();
  core.setStatus('connected', null);
  core.setPeers([{ id: 'p1', displayName: 'Alice' }]);
  core.setPendingJoins([{ requesterId: 'p2', displayName: 'Bruno' }]);

  await core.handleCommand({ target: 'engine', type: 'disconnect' }, aba);

  assert.equal(aba.estado.status, 'idle');
  assert.deepEqual(aba.estado.peers, [], 'peer fantasma é a tela dizendo que há gente ouvindo');
  assert.deepEqual(aba.estado.pendingJoins, []);
  assert.equal(room.desconexoes, 1);
});

test('o volume de monitoração é fixado em 0..1 antes de virar estado', async () => {
  const { core, aba } = motor();

  await core.handleCommand({ target: 'engine', type: 'volume', value: 5 }, aba);
  assert.equal(aba.estado.volume, 1);

  await core.handleCommand({ target: 'engine', type: 'volume', value: -3 }, aba);
  assert.equal(aba.estado.volume, 0);
});

test('`lastCommand` registra o que chegou — a resposta para "o clique chegou?"', async () => {
  const { core, aba } = motor();

  await core.handleCommand({ target: 'engine', type: 'transport', action: 'pause' }, aba);

  // Entre o clique e o motor há um service worker, um documento offscreen e duas
  // filas. Sem este campo, comando perdido no caminho e comando que chegou e
  // falhou em silêncio são indistinguíveis.
  assert.equal(aba.estado.lastCommand, 'transport');
});

test('uma aba que sai para de contar como espectadora', () => {
  // `motor()` já anexa a primeira aba — a de baixo é a segunda.
  const { core } = motor();
  const outra = new FakePort('B');
  core.attach(outra);
  assert.equal(core.viewers, 2);

  core.detach(outra);

  assert.equal(core.viewers, 1);
});
