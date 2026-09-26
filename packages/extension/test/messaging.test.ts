/**
 * Roteamento entre abas: uma verdade no motor, N abas espelhando.
 *
 * É a propriedade central da entrega, e ela é verificável sem navegador: as
 * "abas" são portas dublê, e o que se afirma é que **todas** veem a mesma fila,
 * a mesma faixa corrente e os mesmos favoritos depois de um comando vindo de
 * qualquer uma.
 *
 * O teste também cobre a regra que o `chrome.runtime` impõe e que é fácil
 * esquecer: a mensagem é entregue a *todos* os contextos, então `target` é o
 * endereçamento — e um listener que não filtra responde por engano.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EngineCore } from '../src/engine/core.ts';
import { UiHub, diffState } from '../src/lib/hub.ts';
import { emptyState, isFor } from '../src/lib/protocol.ts';
import { FakeAudio, FakePort, FakeRoom, MemoryStorage, relogio } from './engineDoubles.ts';

function motor() {
  const audio = new FakeAudio();
  const room = new FakeRoom();
  const storage = new MemoryStorage();
  const clock = relogio(1000);
  const core = new EngineCore({ audio, room, storage, now: clock.agora, engineId: 'eng-teste' });
  core.init();
  return { core, audio, room, storage, clock };
}

test('`isFor` filtra por destino — e recusa forma desconhecida', () => {
  assert.equal(isFor('engine', { target: 'engine', type: 'disconnect' }), true);
  // Endereçada a outro contexto: o listener do motor precisa ignorar.
  assert.equal(isFor('engine', { target: 'sw', type: 'ensure-engine' }), false);
  assert.equal(isFor('ui', { target: 'ui', type: 'state', state: emptyState() }), true);
  for (const lixo of [null, undefined, 'texto', 42, {}, { target: 'engine' }, { type: 'x' }]) {
    assert.equal(isFor('engine', lixo), false, String(lixo));
  }
});

test('quem chega recebe o estado inteiro; quem já estava recebe só o delta', () => {
  const hub = new UiHub();
  const a = new FakePort('A');
  const estado = emptyState('eng-1');
  hub.attach(a, estado);
  assert.equal(a.mensagens[0]?.type, 'state');

  hub.broadcast({ volume: 0.5 });
  assert.equal(a.mensagens[1]?.type, 'patch');

  const b = new FakePort('B');
  hub.attach(b, { ...estado, volume: 0.5 });
  // A aba nova **não** recebe delta: ela precisa do snapshot, ou monta meia tela.
  assert.equal(b.mensagens[0]?.type, 'state');
  assert.equal(b.mensagens.length, 1);
});

test('o delta só carrega o que mudou de verdade', () => {
  const antes = emptyState('eng-1');
  const depois = { ...antes, volume: 0.3, queue: [...antes.queue] };
  const patch = diffState(antes, depois);
  // `queue` é um array novo com o mesmo conteúdo: comparar por identidade
  // mandaria a fila inteira a cada tique de posição.
  assert.deepEqual(patch, { volume: 0.3 });
  assert.equal(diffState(antes, { ...antes }), null);
});

test('uma porta morta é esquecida, e as outras continuam recebendo', () => {
  const hub = new UiHub();
  const viva = new FakePort('viva');
  const morta = new FakePort('morta');
  hub.attach(viva, emptyState());
  hub.attach(morta, emptyState());
  morta.morta = true;

  hub.broadcast({ volume: 0.2 });
  assert.equal(hub.size, 1, 'a porta que lançou saiu do conjunto');
  hub.broadcast({ volume: 0.4 });
  assert.equal(viva.estado.volume, 0.4);
});

test('três abas veem a mesma fila depois de um "adicionar" numa delas', async () => {
  const { core } = motor();
  const abas = [new FakePort('A'), new FakePort('B'), new FakePort('C')];
  for (const aba of abas) core.attach(aba);

  await core.handleCommand(
    { target: 'engine', type: 'queue-add', source: { kind: 'url', sourceRef: 'https://cdn.example/a.mp3' } },
    abas[0],
  );

  for (const aba of abas) {
    assert.equal(aba.estado.queue?.length, 1, aba.rotulo);
    assert.equal(aba.estado.queue?.[0]?.title, 'a', aba.rotulo); // titleFromUrl tira a extensão
    assert.equal(aba.estado.current?.title, 'a', aba.rotulo);
    assert.equal(aba.estado.engineId, 'eng-teste', aba.rotulo);
  }
});

test('pausar numa aba aparece nas outras', async () => {
  const { core } = motor();
  const [a, b] = [new FakePort('A'), new FakePort('B')];
  core.attach(a);
  core.attach(b);

  await core.handleCommand(
    { target: 'engine', type: 'queue-add', source: { kind: 'url', sourceRef: 'https://cdn.example/x.mp3' } },
    a,
  );
  assert.equal(b.estado.current?.playing, true);

  await core.handleCommand({ target: 'engine', type: 'transport', action: 'pause' }, b);
  assert.equal(a.estado.current?.playing, false, 'a aba que não clicou também vê a pausa');
});

test('favoritar numa aba aparece nas outras, e persiste no storage', async () => {
  const { core, storage } = motor();
  const [a, b] = [new FakePort('A'), new FakePort('B')];
  core.attach(a);
  core.attach(b);

  await core.handleCommand(
    { target: 'engine', type: 'favorite-add', input: 'https://cdn.example/efeito.mp3' },
    a,
  );

  assert.equal(a.estado.favorites?.length, 1);
  assert.deepEqual(
    b.estado.favorites?.map((f) => f.sourceRef),
    ['https://cdn.example/efeito.mp3'],
  );
  // Mesma chave e mesmo formato do app — é o que permite copiar a lista de um
  // lado para o outro sem conversão.
  const bruto = storage.getItem('wtk-meet:soundboard');
  assert.ok(bruto, 'gravou na chave do app');
  assert.equal(JSON.parse(bruto).favorites.length, 1);
});

test('a aba que fecha para de receber, e as outras seguem', async () => {
  const { core } = motor();
  const [a, b] = [new FakePort('A'), new FakePort('B')];
  core.attach(a);
  core.attach(b);
  core.detach(a);
  const antes = a.mensagens.length;

  await core.handleCommand({ target: 'engine', type: 'volume', value: 0.25 }, b);

  assert.equal(a.mensagens.length, antes, 'a aba desconectada não recebe mais nada');
  assert.equal(b.estado.volume, 0.25);
});

test('URL sem CORS é recusada com mensagem — e não entra na fila', async () => {
  const { core, audio } = motor();
  const aba = new FakePort('A');
  core.attach(aba);
  audio.corsOk = false;

  await core.handleCommand(
    { target: 'engine', type: 'queue-add', source: { kind: 'url', sourceRef: 'https://www.myinstants.com/x.mp3' } },
    aba,
  );

  assert.equal(aba.estado.queue?.length, 0, 'nada entrou na fila');
  assert.match(aba.avisos.at(-1) ?? '', /CORS/i);
});

test('link de YouTube é recusado com a mensagem do app, sem inventar texto', async () => {
  const { core } = motor();
  const aba = new FakePort('A');
  core.attach(aba);

  await core.handleCommand(
    { target: 'engine', type: 'queue-add', source: { kind: 'url', sourceRef: 'https://youtu.be/dQw4w9WgXcQ' } },
    aba,
  );

  assert.equal(aba.estado.queue?.length, 0);
  assert.match(aba.avisos.at(-1) ?? '', /YouTube/);
});

test('o motor nunca aprova sozinho: a decisão vem de um comando da UI', async () => {
  const { core, room } = motor();
  const aba = new FakePort('A');
  core.attach(aba);

  core.setPendingJoins([{ requesterId: 'p1', displayName: 'Alice' }]);
  assert.equal(aba.estado.pendingJoins?.length, 1);
  assert.deepEqual(room.decisoes, [], 'nada foi decidido sem clique');

  await core.handleCommand(
    { target: 'engine', type: 'join-decision', requesterId: 'p1', approve: true },
    aba,
  );
  assert.deepEqual(room.decisoes, [{ requesterId: 'p1', approve: true }]);
  assert.equal(aba.estado.pendingJoins?.length, 0);
});

test('conectar normaliza o endereço e recusa o que não vira sala', async () => {
  const { core, room } = motor();
  const aba = new FakePort('A');
  core.attach(aba);

  await core.handleCommand(
    { target: 'engine', type: 'connect', roomPath: 'ABC-DEFG-HIJ', displayName: 'Música' },
    aba,
  );
  assert.deepEqual(room.conexoes, [{ roomPath: 'abc-defg-hij', displayName: 'Música' }]);

  await core.handleCommand({ target: 'engine', type: 'connect', roomPath: '---', displayName: 'x' }, aba);
  assert.equal(room.conexoes.length, 1, 'endereço vazio não vira conexão');
  assert.ok(aba.avisos.length > 0);
});
