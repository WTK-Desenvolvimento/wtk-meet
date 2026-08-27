/**
 * Troca de faixa: a decisão, e a convergência de uma playlist longa.
 *
 * Duas coisas se provam aqui, e nenhuma delas precisa de navegador.
 *
 * A primeira é que os **quatro motivos de avanço** — `skipped` (alguém apertou
 * Pular), `ended` (a faixa acabou), `error` (o vídeo é privado, removido ou não
 * permite incorporação) e `owner-left` (quem transmitia fechou a aba) — chegam
 * ao mesmo estado saudável. Eles diferem em uma coisa só, o `endedReason`, e
 * tratar isso como coincidência é o que fazia um dos caminhos se comportar
 * diferente dos outros. `planAdvance` é pura justamente para que essa igualdade
 * seja uma asserção e não uma esperança.
 *
 * A segunda é a **playlist longa com três participantes**. O e2e roda o mesmo
 * roteiro em três navegadores de verdade, mas leva minutos e depende de rede;
 * aqui as três réplicas são três `session` no mesmo processo, e o "canal" é uma
 * função que entrega a mensagem a todo mundo. É a rede de segurança de quando o
 * navegador não colabora — e é ela que consegue percorrer 18 transições sem
 * custo nenhum.
 *
 * O teto de `MAX_PER_PEER = 10` é o motivo de a playlist ser obrigatoriamente
 * coletiva: 15 faixas de um participante só seriam **descartadas em silêncio**
 * pelo `enforceLimits`, e o teste passaria medindo uma fila de 10.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MAX_PER_PEER,
  addEntry,
  applyPlayback,
  createSession,
  emptyPlayback,
  entryById,
  orderedQueue,
  ownerFor,
  planAdvance,
  removeEntry,
  sanitizeEntry,
} = await import('../src/lib/musicSession.js');

import type { MusicSession, Playback, QueueEntry } from '../src/lib/musicSession.js';

const PEERS = ['peer-alice', 'peer-bob', 'peer-carol'];
const NAMES: Record<string, string> = {
  'peer-alice': 'Alice',
  'peer-bob': 'Bob',
  'peer-carol': 'Carol',
};

/**
 * Uma faixa válida. O `!` é a asserção da fixture: `sanitizeEntry` só devolve
 * `null` para payload malformado, e este é bem formado por construção.
 */
function track({
  id,
  addedBy,
  lamport,
  kind = 'url',
  sourceRef,
}: {
  id: string;
  addedBy: string;
  lamport: number;
  kind?: string;
  sourceRef?: string;
}): QueueEntry {
  return sanitizeEntry(
    {
      id,
      kind,
      title: `Faixa ${id}`,
      sourceRef: sourceRef ?? (kind === 'youtube' ? id.padEnd(11, 'x').slice(0, 11) : `https://cdn.example.com/${id}.mp3`),
      addedByName: NAMES[addedBy],
      lamport,
    },
    { addedBy },
  )!;
}

function sessionWith(entries: QueueEntry[], playback: Partial<Playback> = {}): MusicSession {
  const base = entries.reduce((acc, item) => addEntry(acc, item).session, createSession());
  return { ...base, playback: { ...emptyPlayback(), ...playback } };
}

/** Três faixas de autores diferentes, na ordem total `(lamport, autor, id)`. */
function trio() {
  return [
    track({ id: 'a1', addedBy: 'peer-alice', lamport: 1 }),
    track({ id: 'b1', addedBy: 'peer-bob', lamport: 2 }),
    track({ id: 'c1', addedBy: 'peer-carol', lamport: 3 }),
  ];
}

// ------------------------------------------------- os quatro motivos de avanço

test('AC14. os quatro motivos produzem o mesmo plano; só o endedReason muda', () => {
  const entries = trio();
  const session = sessionWith(entries, { entryId: 'a1', ownerId: 'peer-alice', playing: true, version: 3 });

  const plans = ['skipped', 'ended', 'error', 'owner-left'].map((reason) => ({
    reason,
    plan: planAdvance({
      session,
      finishedEntryId: 'a1',
      reason,
      presentIds: PEERS,
      selfId: 'peer-bob',
      delivery: 'stream',
    }),
  }));

  for (const { reason, plan } of plans) {
    assert.equal(plan.removedEntryId, 'a1', reason);
    assert.equal(plan.broadcastRemove, true, reason);
    assert.equal(plan.publish!.entryId, 'b1', reason);
    assert.equal(plan.publish!.playing, true, reason);
    assert.equal(plan.publish!.positionSec, 0, reason);
    assert.equal(plan.publish!.endedReason, reason, 'o motivo viaja, mas não decide');
  }

  // A prova de que o motivo não decide nada: apagado o `endedReason`, os quatro
  // planos são o mesmo objeto.
  const semMotivo = plans.map(({ plan }) => JSON.stringify({ ...plan, publish: { ...plan.publish, endedReason: null } }));
  assert.equal(new Set(semMotivo).size, 1, semMotivo.join('\n'));
});

test('AC15. quem publica é o dono da faixa seguinte — exatamente um escritor por transição', () => {
  const entries = trio();
  const session = sessionWith(entries, { entryId: 'a1', ownerId: 'peer-alice', playing: true, version: 1 });

  const publishers = PEERS.filter(
    (selfId) => planAdvance({ session, finishedEntryId: 'a1', reason: 'ended', presentIds: PEERS, selfId }).publish,
  );

  assert.deepEqual(publishers, ['peer-bob'], 'a próxima é b1, de Bob: só ele publica');
});

test('AC15. com o autor da próxima ausente, o sucessor de menor id assume — e só ele', () => {
  const entries = trio();
  const session = sessionWith(entries, { entryId: 'a1', ownerId: 'peer-alice', playing: true, version: 1 });
  const present = ['peer-alice', 'peer-carol']; // Bob saiu

  const publishers = present.filter(
    (selfId) => planAdvance({ session, finishedEntryId: 'a1', reason: 'owner-left', presentIds: present, selfId }).publish,
  );

  assert.equal(ownerFor(entryById(session, 'b1'), present), 'peer-alice');
  assert.deepEqual(publishers, ['peer-alice']);
});

test('AC16. a faixa que já virou tombstone ainda encontra a seguinte, pela chave', () => {
  const entries = trio();
  // `owner-left` e o skip vindo do canal chegam com a entrada já removida
  // daqui: procurar pelo id na fila não acharia nada e a fila pararia.
  const session = removeEntry(
    sessionWith(entries, { entryId: 'a1', ownerId: 'peer-alice', playing: true, version: 2 }),
    'a1',
  );
  assert.equal(entryById(session, 'a1'), null, 'a premissa do caso');

  const plan = planAdvance({
    session,
    finishedEntryId: 'a1',
    reason: 'owner-left',
    presentIds: PEERS,
    selfId: 'peer-bob',
  });

  assert.equal(plan.publish!.entryId, 'b1', 'sem a busca por chave a fila pararia aqui');
  assert.equal(plan.removedEntryId, 'a1', 'o tombstone vale mesmo para quem já não está na fila');
  assert.equal(plan.broadcastRemove, false, 'ninguém precisa saber de uma remoção que já aconteceu');
});

test('AC17. fila vazia: quem estava tocando declara o silêncio, e ninguém mais', () => {
  const only = [track({ id: 'a1', addedBy: 'peer-alice', lamport: 1 })];
  const session = sessionWith(only, { entryId: 'a1', ownerId: 'peer-alice', playing: true, version: 5 });

  const mine = planAdvance({ session, finishedEntryId: 'a1', reason: 'ended', presentIds: PEERS, selfId: 'peer-alice' });
  assert.deepEqual(mine.publish, { entryId: null, playing: false, positionSec: 0, endedReason: 'ended' });

  for (const selfId of ['peer-bob', 'peer-carol']) {
    const plan = planAdvance({ session, finishedEntryId: 'a1', reason: 'ended', presentIds: PEERS, selfId });
    assert.equal(plan.publish, null, `${selfId} não pode declarar silêncio pela sala`);
  }
});

test('a entrega da faixa seguinte é injetada, e valor inválido cai para stream', () => {
  const entries = trio();
  const session = sessionWith(entries, { entryId: 'a1', ownerId: 'peer-alice', version: 1 });

  const local = planAdvance({
    session,
    finishedEntryId: 'a1',
    reason: 'skipped',
    presentIds: PEERS,
    selfId: 'peer-bob',
    delivery: (entry) => (entry.id === 'b1' ? 'local' : 'stream'),
  });
  assert.equal(local.publish!.delivery, 'local', 'a sonda de CORS decide, e ela é rede');

  const lixo = planAdvance({
    session,
    finishedEntryId: 'a1',
    reason: 'skipped',
    presentIds: PEERS,
    selfId: 'peer-bob',
    delivery: () => 'carrier-pigeon',
  });
  assert.equal(lixo.publish!.delivery, 'stream');
});

test('sem sessão e sem faixa corrente o plano é inerte', () => {
  assert.deepEqual(planAdvance(), { removedEntryId: null, broadcastRemove: false, publish: null });
  assert.deepEqual(planAdvance({ session: null }), { removedEntryId: null, broadcastRemove: false, publish: null });

  // Nada tocando e a fila tem faixa: o dono da primeira assume.
  const session = sessionWith(trio());
  const plan = planAdvance({ session, finishedEntryId: null, reason: null, presentIds: PEERS, selfId: 'peer-alice' });
  assert.equal(plan.publish!.entryId, 'a1');
  assert.equal(plan.removedEntryId, null);
});

// ------------------------------------------- playlist longa em três réplicas

/**
 * Três réplicas e um canal que entrega a todas — o mesmo desenho do hook, sem
 * React. Cada réplica é uma `session`; cada mensagem é aplicada por todas,
 * inclusive por quem a emitiu (é o que o `updateSession` local faz antes do
 * `send`).
 */
function createRoom(entries: QueueEntry[]) {
  const replicas = new Map(PEERS.map((id) => [id, sessionWith(entries)]));

  const applyRemove = (entryId: string) => {
    for (const id of PEERS) replicas.set(id, removeEntry(replicas.get(id)!, entryId));
  };
  const applyPublish = (playback: Playback) => {
    for (const id of PEERS) replicas.set(id, applyPlayback(replicas.get(id)!, playback, 0));
  };

  return {
    replicas,
    get(id: string) {
      return replicas.get(id)!;
    },
    /**
     * Roda o avanço em **todas** as réplicas, como acontece de verdade: o efeito
     * de "nada tocando e a fila tem faixa" dispara em todo mundo, e a decisão de
     * quem publica é de `planAdvance`.
     */
    advance(finishedEntryId: string | null, reason: string | null, { present = PEERS } = {}) {
      const plans = present.map((selfId) => ({
        selfId,
        plan: planAdvance({
          session: replicas.get(selfId)!,
          finishedEntryId,
          reason,
          presentIds: present,
          selfId,
          delivery: (entry: QueueEntry) => (entry.kind === 'youtube' ? 'local' : 'stream'),
        }),
      }));

      const writers = plans.filter(({ plan }) => plan.publish);
      // A invariante mais cara de perder: dois escritores fazem o estado oscilar
      // entre duas faixas e a sala "recupera trocando de sala".
      assert.ok(writers.length <= 1, `${writers.length} escritores na transição de ${finishedEntryId}`);

      const broadcaster = plans.find(({ plan }) => plan.broadcastRemove) || plans[0];
      if (broadcaster?.plan.removedEntryId) applyRemove(broadcaster.plan.removedEntryId);

      if (writers.length === 1) {
        const { selfId, plan } = writers[0]!;
        const current = replicas.get(selfId)!.playback;
        applyPublish({
          ...current,
          ...plan.publish,
          version: current.version + 1,
          ownerId: selfId,
          receivedAt: 0,
        });
      }
      return { writers: writers.map(({ selfId }) => selfId), plans };
    },
    /** Todas as réplicas veem a mesma faixa corrente, a mesma fila e a mesma autoria. */
    /** A visão convergida, relida do JSON — é a forma que as asserções leem. */
    assertConverged(label: string): {
      current: string | null;
      owner: string | null;
      playing: boolean;
      queue: [string, string, string, string][];
    } {
      const views = PEERS.map((id) => {
        const session = replicas.get(id)!;
        return JSON.stringify({
          current: session.playback.entryId,
          owner: session.playback.ownerId,
          playing: session.playback.playing,
          queue: orderedQueue(session).map((e) => [e.id, e.addedBy, e.addedByName, e.title]),
        });
      });
      assert.equal(new Set(views).size, 1, `${label}\n${views.join('\n')}`);
      return JSON.parse(views[0]!);
    },
  };
}

/** 18 faixas: 6 de cada participante, abaixo do teto de 10 por peer. */
function longPlaylist() {
  const entries: QueueEntry[] = [];
  let lamport = 0;
  for (let round = 0; round < 6; round += 1) {
    for (const peer of PEERS) {
      lamport += 1;
      const index = entries.length;
      entries.push(
        track({
          id: `t${String(index).padStart(2, '0')}`,
          addedBy: peer,
          lamport,
          // Alterna as origens para que a playlist exercite as três combinações
          // de troca: YouTube→YouTube, YouTube→arquivo/URL e o inverso.
          kind: index % 3 === 0 ? 'youtube' : 'url',
        }),
      );
    }
  }
  return entries;
}

test('playlist de 18 faixas: as três réplicas convergem a cada avanço, com autoria preservada', () => {
  const entries = longPlaylist();
  assert.equal(entries.length, 18);
  assert.ok(entries.every(Boolean), 'toda entrada tem que sobreviver ao sanitizeEntry');
  for (const peer of PEERS) {
    assert.ok(
      entries.filter((e) => e.addedBy === peer).length <= MAX_PER_PEER,
      'passar do teto por participante faria enforceLimits descartar em silêncio',
    );
  }

  const room = createRoom(entries);
  // Primeira faixa: ninguém tocando ainda.
  room.advance(null, null);
  let view = room.assertConverged('início da playlist');
  assert.equal(view.queue.length, 18, 'nenhuma faixa pode ter sumido no caminho');

  const REASONS = ['skipped', 'ended', 'error', 'owner-left'];
  const played = [];
  for (let step = 0; step < 17; step += 1) {
    const finished = view.current;
    assert.ok(finished, `parou de tocar no passo ${step}`);
    played.push(finished);

    const { writers } = room.advance(finished, REASONS[step % REASONS.length]);
    assert.equal(writers.length, 1, `passo ${step}: exatamente um escritor por transição`);

    view = room.assertConverged(`passo ${step} (${REASONS[step % REASONS.length]})`);
    assert.equal(view.queue.length, 17 - step, `passo ${step}: a faixa que acabou sai da fila`);
    assert.ok(!view.queue.some(([id]) => id === finished), `passo ${step}: ${finished} continua na fila`);
    assert.equal(view.playing, true, `passo ${step}: a faixa seguinte tem que assumir tocando`);
    assert.equal(
      view.owner,
      ownerFor(entryById(room.get('peer-alice'), view.current), PEERS),
      `passo ${step}: o dono publicado é o autor da faixa corrente`,
    );
    // Autoria preservada: o `addedByName` que a UI mostra em `.music-queue-by`
    // continua sendo o de quem adicionou, e não o de quem publicou o estado.
    for (const [id, addedBy, addedByName] of view.queue) {
      const original = entries.find((e) => e.id === id)!;
      assert.equal(addedBy, original.addedBy, `autoria de ${id}`);
      assert.equal(addedByName, NAMES[original.addedBy], `nome do autor de ${id}`);
    }
  }

  played.push(view.current);
  // A ordem tocada é a ordem total da fila — e cada faixa tocou uma vez só.
  assert.deepEqual(played, entries.map((e) => e.id).sort());
  assert.equal(new Set(played).size, 18, 'pular duas de uma vez é o sintoma do evento de iframe morto');

  // A última faixa acaba: a sala declara silêncio, uma vez só.
  const { writers } = room.advance(view.current, 'ended');
  assert.equal(writers.length, 1);
  const final = room.assertConverged('fim da playlist');
  assert.equal(final.current, null);
  assert.equal(final.playing, false);
  assert.equal(final.queue.length, 0);
});

test('playlist longa: dono que sai no meio não trava a fila nem duplica escritor', () => {
  const entries = longPlaylist();
  const room = createRoom(entries);
  room.advance(null, null);
  let view = room.assertConverged('início');

  // Bob cai. Quem responde pelas faixas dele passa a ser o presente de menor id,
  // e as transições seguem com um escritor só.
  const present = ['peer-alice', 'peer-carol'];
  for (let step = 0; step < 6; step += 1) {
    const finished = view.current;
    const { writers } = room.advance(finished, 'owner-left', { present });
    assert.equal(writers.length, 1, `passo ${step}: um escritor mesmo com o autor ausente`);
    assert.ok(present.includes(writers[0]), `passo ${step}: quem publicou tem que estar na sala`);
    view = room.assertConverged(`passo ${step} sem Bob`);
    assert.ok(view.current, `passo ${step}: a fila não pode parar`);
  }

  // As faixas de Bob continuam na fila com a autoria dele: sair da sala não
  // apaga o crédito de quem adicionou.
  const doBob = view.queue.filter(([, addedBy]) => addedBy === 'peer-bob');
  assert.ok(doBob.length > 0);
  assert.ok(doBob.every(([, , name]) => name === 'Bob'));
});
