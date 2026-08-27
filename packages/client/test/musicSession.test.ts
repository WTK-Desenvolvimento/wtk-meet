/**
 * Estado musical replicado. Sem servidor e sem líder, a convergência é
 * responsabilidade destas funções — e é aqui, não no navegador, que ela se
 * verifica: ordem total independente da chegada, união com tombstones e
 * reprodução com escritor único.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MAX_PER_PEER,
  MAX_QUEUE,
  addEntry,
  applyDuration,
  applyPlayback,
  applyReorder,
  buildSnapshot,
  bumpLamport,
  compareEntries,
  countByPeer,
  createSession,
  emptyPlayback,
  estimatePosition,
  hasSameSource,
  isNewerPlayback,
  mergeSnapshot,
  nextEntry,
  nextEntryAfterKey,
  observeLamport,
  orderedQueue,
  ownerFor,
  planPositionHeartbeat,
  previousEntry,
  removeEntriesBy,
  removeEntry,
  sanitizeEntry,
  sanitizePlayback,
  successorOwner,
} = await import('../src/lib/musicSession.js');

import type { MusicSession, QueueEntry } from '../src/lib/musicSession.js';

/**
 * Uma entrada válida. O `!` é a asserção da fixture: `sanitizeEntry` só
 * devolve `null` para payload malformado, e este aqui é bem formado por
 * construção — os casos de payload torto montam o seu próprio.
 */
function entry(overrides: Partial<QueueEntry> & { addedBy?: string } = {}): QueueEntry {
  return sanitizeEntry(
    {
      id: 'e1',
      kind: 'url',
      title: 'Faixa',
      sourceRef: 'https://cdn.example.com/a.mp3',
      lamport: 1,
      addedByName: 'Ana',
      ...overrides,
    },
    { addedBy: overrides.addedBy || 'peer-a' },
  )!;
}

function withEntries(session: MusicSession, entries: QueueEntry[]): MusicSession {
  return entries.reduce((acc, item) => addEntry(acc, item).session, session);
}

test('relógio lógico: emitir anda um passo, receber salta para o maior + 1', () => {
  const session = createSession();
  const { session: after, lamport } = bumpLamport(session);
  assert.equal(lamport, 1);
  assert.equal(after.lamport, 1);
  assert.equal(observeLamport(after, 9).lamport, 10);
  assert.equal(observeLamport(after, 0).lamport, 2);
  assert.equal(observeLamport(after, 'ontem').lamport, 2);
});

test('a fila tem ordem total e ela não depende da ordem de chegada', () => {
  const a = entry({ id: 'e-a', lamport: 2, addedBy: 'peer-a' });
  const b = entry({ id: 'e-b', lamport: 1, addedBy: 'peer-b' });
  const c = entry({ id: 'e-c', lamport: 2, addedBy: 'peer-a' });

  const um = orderedQueue(withEntries(createSession(), [a, b, c])).map((e) => e.id);
  const dois = orderedQueue(withEntries(createSession(), [c, b, a])).map((e) => e.id);
  const tres = orderedQueue(withEntries(createSession(), [b, c, a])).map((e) => e.id);

  assert.deepEqual(um, ['e-b', 'e-a', 'e-c']);
  assert.deepEqual(dois, um);
  assert.deepEqual(tres, um);
  // Empate de lamport e de autor desempata pelo id — nunca por relógio de parede.
  assert.equal(compareEntries(a, c) < 0, true);
});

test('sanitizeEntry sobrescreve o autor pelo peer da conexão', () => {
  const forjada = entry({ id: 'e9', addedBy: 'peer-a' });
  const recebida = sanitizeEntry({ ...forjada, addedBy: 'peer-vitima' }, { addedBy: 'peer-atacante' })!;
  assert.equal(recebida.addedBy, 'peer-atacante');
  assert.equal(recebida.id, 'e9', 'o id da entrada é a identidade compartilhada e não é regerado');
});

test('sanitizeEntry descarta payload malformado sem lançar', () => {
  const bases = [
    null,
    42,
    'texto',
    {},
    { id: 'x' },
    { id: 'x', kind: 'torrent', title: 't', sourceRef: '' },
    { id: 'x', kind: 'url', title: 't', sourceRef: 'javascript:alert(1)' },
    { id: 'x', kind: 'url', title: 't', sourceRef: 'data:audio/mp3;base64,AA' },
    { id: 'x', kind: 'url', title: 't', sourceRef: 'não é url' },
    { id: 'x', kind: 'youtube', title: 't', sourceRef: 'curto' },
    { id: 'x', kind: 'file', title: 't', sourceRef: 'https://x.example/roubado.mp3' },
    { id: 'x', kind: 'url', title: '   ', sourceRef: 'https://x.example/a.mp3' },
    { id: '', kind: 'url', title: 't', sourceRef: 'https://x.example/a.mp3' },
  ];
  for (const bad of bases) {
    assert.equal(sanitizeEntry(bad, { addedBy: 'peer-a' }), null, `deveria recusar ${JSON.stringify(bad)}`);
  }
  // Sem autor confiável não existe entrada.
  assert.equal(sanitizeEntry(entry(), {}), null);
});

test('sanitizeEntry limita título, nome e duração', () => {
  const e = sanitizeEntry(
    {
      id: 'e1',
      kind: 'file',
      title: 'T'.repeat(500),
      sourceRef: '',
      addedByName: 'N'.repeat(200),
      durationSec: -5,
      lamport: -3,
    },
    { addedBy: 'peer-a' },
  )!;
  assert.equal(e.title.length, 120);
  assert.equal(e.addedByName.length, 40);
  assert.equal(e.durationSec, null);
  assert.equal(e.lamport, 0);
});

test('id já conhecido é ignorado (first-write-wins) e id removido não ressuscita', () => {
  let session = withEntries(createSession(), [entry({ id: 'e1', title: 'Original' })]);
  const conflito = addEntry(session, entry({ id: 'e1', title: 'Sequestro', addedBy: 'peer-b' }));
  assert.equal(conflito.ok, false);
  assert.equal(conflito.reason, 'duplicate');
  assert.equal(orderedQueue(conflito.session)[0].title, 'Original');

  session = removeEntry(session, 'e1');
  const volta = addEntry(session, entry({ id: 'e1' }));
  assert.equal(volta.ok, false);
  assert.equal(volta.reason, 'removed');
  assert.equal(orderedQueue(volta.session).length, 0);
});

test('teto por participante e da sala: recusa a excedente e mantém a fila estável', () => {
  let session = createSession();
  for (let i = 0; i < MAX_PER_PEER; i += 1) {
    session = addEntry(session, entry({ id: `a${i}`, lamport: i, addedBy: 'peer-a' })).session;
  }
  const excedente = addEntry(session, entry({ id: 'a-extra', lamport: 99, addedBy: 'peer-a' }));
  assert.equal(excedente.ok, false);
  assert.equal(excedente.reason, 'peer-limit');
  assert.equal(countByPeer(excedente.session, 'peer-a'), MAX_PER_PEER);

  // O teto da sala é aplicado por regra determinística (sobrevive a menor chave),
  // não por ordem de chegada — dois clients ficam com a mesma fila.
  let cheia = createSession();
  for (let i = 0; i < MAX_QUEUE; i += 1) {
    cheia = addEntry(cheia, entry({ id: `x${i}`, lamport: i, addedBy: `peer-${i % 20}` })).session;
  }
  assert.equal(orderedQueue(cheia).length, MAX_QUEUE);
  const cheiaMais = addEntry(cheia, entry({ id: 'x-extra', lamport: 999, addedBy: 'peer-novo' }));
  assert.equal(cheiaMais.ok, false);
  assert.equal(cheiaMais.reason, 'queue-full');
  assert.equal(orderedQueue(cheiaMais.session).length, MAX_QUEUE);
});

test('remoção vira tombstone e o tombstone vence o snapshot de quem não viu', () => {
  const e1 = entry({ id: 'e1', lamport: 1 });
  const e2 = entry({ id: 'e2', lamport: 2 });
  const A = removeEntry(withEntries(createSession(), [e1, e2]), 'e1');

  // C nunca viu a remoção e manda o snapshot com a entrada viva.
  const C = withEntries(createSession(), [e1, e2]);
  const B = mergeSnapshot(A, buildSnapshot(C));
  assert.deepEqual(orderedQueue(B).map((e) => e.id), ['e2'], 'e1 não pode ressuscitar');

  // E o inverso: quem recebe o tombstone mata a entrada que ainda tinha.
  const D = mergeSnapshot(C, buildSnapshot(A));
  assert.deepEqual(orderedQueue(D).map((e) => e.id), ['e2']);
});

test('mergeSnapshot é união: um snapshot velho não apaga adição recente', () => {
  const antigo = withEntries(createSession(), [entry({ id: 'e1', lamport: 1 })]);
  const local = withEntries(antigo, [entry({ id: 'e2', lamport: 5, addedBy: 'peer-b' })]);
  const merged = mergeSnapshot(local, buildSnapshot(antigo));
  assert.deepEqual(orderedQueue(merged).map((e) => e.id), ['e1', 'e2']);
});

test('habilitar o player é monotônico no merge: nunca volta para desligado', () => {
  const ligado = { ...createSession(), enabled: true };
  assert.equal(mergeSnapshot(ligado, buildSnapshot(createSession())).enabled, true);
  assert.equal(mergeSnapshot(createSession(), buildSnapshot(ligado)).enabled, true);
});

test('quem entra no meio converge para a mesma fila e para a faixa corrente', () => {
  let dono = withEntries(createSession(), [
    entry({ id: 'e1', lamport: 1 }),
    entry({ id: 'e2', lamport: 2 }),
    entry({ id: 'e3', lamport: 3, addedBy: 'peer-b' }),
  ]);
  dono = { ...dono, enabled: true };
  dono = applyPlayback(
    dono,
    sanitizePlayback(
      { version: 4, entryId: 'e2', positionSec: 42, playing: true, delivery: 'stream' },
      { ownerId: 'peer-a' },
    ),
    0,
  );

  const novato = mergeSnapshot(createSession(), buildSnapshot(dono), 1_000);
  assert.deepEqual(orderedQueue(novato).map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.equal(novato.enabled, true);
  assert.equal(novato.playback.entryId, 'e2');
  assert.equal(novato.playback.playing, true);
  // Entra no meio da música, não do começo.
  assert.equal(estimatePosition(novato.playback, 3_000), 44);
});

test('estimatePosition usa só relógio local a partir da recepção', () => {
  const parado = { ...emptyPlayback(), entryId: 'e1', positionSec: 10, playing: false, receivedAt: 0 };
  assert.equal(estimatePosition(parado, 60_000), 10, 'pausado não anda');
  const tocando = { ...parado, playing: true, receivedAt: 5_000 };
  assert.equal(estimatePosition(tocando, 12_500), 17.5);
  assert.equal(estimatePosition(emptyPlayback(), 1_000), 0);
});

test('reprodução tem escritor único: só (version, ownerId) maior é aplicado', () => {
  const base = sanitizePlayback({ version: 3, entryId: 'e1', playing: true }, { ownerId: 'peer-b' });
  let session = applyPlayback(createSession(), base, 0);
  assert.equal(session.playback.version, 3);

  const velho = sanitizePlayback({ version: 2, entryId: 'e9', playing: false }, { ownerId: 'peer-z' });
  session = applyPlayback(session, velho, 0);
  assert.equal(session.playback.entryId, 'e1', 'estado velho não pode voltar');

  // Mesma versão de dois donos: desempate lexicográfico, igual em todos.
  const empate = sanitizePlayback({ version: 3, entryId: 'e5', playing: true }, { ownerId: 'peer-c' });
  assert.equal(isNewerPlayback(empate, session.playback), true);
  assert.equal(isNewerPlayback(base, { ...session.playback, ownerId: 'peer-c' }), false);

  const novo = sanitizePlayback({ version: 4, entryId: 'e2', playing: true }, { ownerId: 'peer-a' });
  session = applyPlayback(session, novo, 0);
  assert.equal(session.playback.entryId, 'e2');
});

test('sanitizePlayback recusa lixo e normaliza os campos', () => {
  assert.equal(sanitizePlayback(null, { ownerId: 'p' }), null);
  assert.equal(sanitizePlayback({ version: -1 }, { ownerId: 'p' }), null);
  assert.equal(sanitizePlayback({ version: 'x' }, { ownerId: 'p' }), null);
  assert.equal(sanitizePlayback({ version: 1 }, {}), null);

  const p = sanitizePlayback(
    { version: 1, entryId: 'e1', positionSec: -5, playing: 'sim', delivery: 'carta' },
    { ownerId: 'peer-a' },
  )!;
  assert.equal(p.positionSec, 0);
  assert.equal(p.playing, true);
  assert.equal(p.delivery, 'stream');
  // Sem faixa não existe "tocando".
  assert.equal(sanitizePlayback({ version: 1, playing: true }, { ownerId: 'peer-a' })!.playing, false);
});

test('navegação: próxima, anterior e a próxima depois de uma faixa que sumiu', () => {
  const e1 = entry({ id: 'e1', lamport: 1 });
  const e2 = entry({ id: 'e2', lamport: 2 });
  const e3 = entry({ id: 'e3', lamport: 3 });
  const session = withEntries(createSession(), [e1, e2, e3]);

  assert.equal(nextEntry(session, null)!.id, 'e1');
  assert.equal(nextEntry(session, 'e2')!.id, 'e3');
  assert.equal(nextEntry(session, 'e3'), null);
  assert.equal(previousEntry(session, 'e2')!.id, 'e1');
  assert.equal(previousEntry(session, 'e1'), null);

  const semE2 = removeEntry(session, 'e2');
  assert.equal(nextEntry(semE2, 'e2'), null, 'a faixa removida não tem sucessora conhecida por id');
  assert.equal(nextEntryAfterKey(semE2, e2)!.id, 'e3', 'mas tem pela chave de ordenação');
  assert.equal(nextEntryAfterKey(semE2, null)!.id, 'e1');
});

test('quando um peer sai, as faixas dele saem da fila com tombstone', () => {
  const session = withEntries(createSession(), [
    entry({ id: 'e1', lamport: 1, addedBy: 'peer-a' }),
    entry({ id: 'e2', lamport: 2, addedBy: 'peer-b' }),
    entry({ id: 'e3', kind: 'file', sourceRef: '', lamport: 3, addedBy: 'peer-a' }),
  ]);
  const semA = removeEntriesBy(session, 'peer-a');
  assert.deepEqual(orderedQueue(semA).map((e) => e.id), ['e2']);
  assert.equal(semA.tombstones.includes('e1'), true);

  // Só as de arquivo, quando é essa a regra (as demais qualquer um consegue tocar).
  const soArquivo = removeEntriesBy(session, 'peer-a', { kinds: ['file'] });
  assert.deepEqual(orderedQueue(soArquivo).map((e) => e.id), ['e1', 'e2']);
});

test('sucessão do dono é determinística: o presente de menor id', () => {
  assert.equal(successorOwner(['peer-c', 'peer-a', 'peer-b']), 'peer-a');
  assert.equal(successorOwner(['peer-a']), 'peer-a');
  assert.equal(successorOwner([]), null);
  assert.equal(successorOwner(null), null);
});

test('ownerFor: quem adicionou responde pela faixa; ausente, o presente de menor id', () => {
  const minha = entry({ id: 'e1', addedBy: 'peer-b' });

  // Presente: o autor responde, mesmo não sendo o menor id da sala.
  assert.equal(ownerFor(minha, ['peer-a', 'peer-b', 'peer-c']), 'peer-b');
  // Ausente: cai para o sucessor determinístico, e todos chegam à mesma conclusão
  // sem trocar mensagem — é o que faz exatamente um cliente publicar.
  assert.equal(ownerFor(minha, ['peer-c', 'peer-a']), 'peer-a');
  // Sala vazia ou entrada inexistente não elegem ninguém.
  assert.equal(ownerFor(minha, []), null);
  assert.equal(ownerFor(null, ['peer-a']), null);
  assert.equal(ownerFor(minha, null), null);
});

test('ownerFor é estável ao longo da fila: a resposta não depende da ordem dos presentes', () => {
  const fila = [
    entry({ id: 'e1', addedBy: 'peer-a', lamport: 1 }),
    entry({ id: 'e2', addedBy: 'peer-b', lamport: 2 }),
    entry({ id: 'e3', addedBy: 'peer-c', lamport: 3 }),
  ];
  const presentes = ['peer-a', 'peer-b', 'peer-c'];
  const embaralhado = ['peer-c', 'peer-b', 'peer-a'];

  for (const item of fila) {
    assert.equal(ownerFor(item, presentes), ownerFor(item, embaralhado), item.id);
    assert.equal(ownerFor(item, presentes), item.addedBy);
  }
});

test('a ordem que planAdvance percorre é a mesma para quem viu as adições em ordens diferentes', () => {
  const fila = [
    entry({ id: 'e2', addedBy: 'peer-b', lamport: 5 }),
    entry({ id: 'e1', addedBy: 'peer-a', lamport: 5 }),
    entry({ id: 'e3', addedBy: 'peer-a', lamport: 4 }),
  ];
  // Mesmo conjunto, ordens de chegada opostas: a fila resultante tem que ser a
  // mesma, senão dois clientes avançariam para faixas diferentes.
  const daqui = orderedQueue(withEntries(createSession(), fila));
  const dali = orderedQueue(withEntries(createSession(), [...fila].reverse()));
  assert.deepEqual(daqui.map((e) => e.id), dali.map((e) => e.id));
  assert.deepEqual(daqui.map((e) => e.id), ['e3', 'e1', 'e2'], '(lamport, autor, id), nesta ordem');

  // E a busca por chave — a que sustenta o avanço com a faixa já tombstoneada —
  // concorda com a navegação por id enquanto a entrada existe.
  const session = withEntries(createSession(), fila);
  for (const item of daqui) {
    assert.deepEqual(nextEntryAfterKey(session, item)?.id, nextEntry(session, item.id)?.id, item.id);
  }
});

test('reordenar só anda para frente, então reordenações concorrentes convergem', () => {
  const session = withEntries(createSession(), [
    entry({ id: 'e1', lamport: 1 }),
    entry({ id: 'e2', lamport: 2 }),
  ]);
  const paraOFim = applyReorder(session, 'e1', 9);
  assert.deepEqual(orderedQueue(paraOFim).map((e) => e.id), ['e2', 'e1']);
  // Um reorder mais velho chegando depois não desfaz o mais novo.
  assert.deepEqual(orderedQueue(applyReorder(paraOFim, 'e1', 3)).map((e) => e.id), ['e2', 'e1']);
  assert.equal(applyReorder(session, 'inexistente', 5), session);
});

test('applyDuration anota o que só se descobre ao carregar a mídia', () => {
  const session = withEntries(createSession(), [entry({ id: 'e1' })]);
  assert.equal(orderedQueue(session)[0].durationSec, null);
  const comDuracao = applyDuration(session, 'e1', 212);
  assert.equal(orderedQueue(comDuracao)[0].durationSec, 212);
  assert.equal(applyDuration(comDuracao, 'e1', 212), comDuracao);
  assert.equal(applyDuration(comDuracao, 'e1', 0), comDuracao);
});

test('hasSameSource evita duplicar link, mas nunca bloqueia arquivo local', () => {
  const session = withEntries(createSession(), [entry({ id: 'e1' })]);
  assert.equal(hasSameSource(session, 'url', 'https://cdn.example.com/a.mp3'), true);
  assert.equal(hasSameSource(session, 'url', 'https://cdn.example.com/b.mp3'), false);
  assert.equal(hasSameSource(session, 'file', ''), false);
});

test('mergeSnapshot ignora snapshot inválido e entradas podres dentro dele', () => {
  const session = withEntries(createSession(), [entry({ id: 'e1' })]);
  assert.equal(mergeSnapshot(session, null), session);
  assert.equal(mergeSnapshot(session, 'texto'), session);
  const sujo = mergeSnapshot(session, {
    entries: [{ id: 'mau', kind: 'url', title: 't', sourceRef: 'javascript:alert(1)', addedBy: 'p' }, null, 7],
    tombstones: ['ok', 42],
    playback: { version: 'x' },
  });
  assert.deepEqual(orderedQueue(sujo).map((e) => e.id), ['e1']);
  assert.deepEqual(sujo.tombstones, ['ok']);
});

// ------------------------------------------- heartbeat de posição (5s do dono)
//
// Os players falsos abaixo espelham os formatos reais, e não uma combinação
// conveniente. `YouTubeTrackPlayer` em buffering está no estado 3, então o
// getter `playing` dele devolve `false`; `MusicEngine` engasgado tem
// `readyState < 3` mas o `element` não está `paused`, então o `playing` dele
// continua `true`. Ou seja: o bug se manifesta hoje só por um dos dois — e é
// por isso que os dois são cobertos. O que se fixa aqui é a invariante (o tique
// nunca rebaixa `playing`), não o sintoma de um player.

/** YouTube: estado 3 (BUFFERING) — `playing` falso, posição válida. */
function youtubeBuffering(positionSec = 42) {
  return { loading: false, buffering: true, playing: false, positionSec };
}

/** MusicEngine: `readyState < 3` com o elemento não pausado. */
function engineBuffering(positionSec = 42) {
  return { loading: false, buffering: true, playing: true, positionSec };
}

function tocando(overrides = {}) {
  return { ...emptyPlayback(), entryId: 'e1', playing: true, positionSec: 30, version: 3, ownerId: 'peer-a', ...overrides };
}

test('heartbeat: buffering do YouTube não pausa a sala — publica a intenção, não o transporte', () => {
  const plan = planPositionHeartbeat({ playback: tocando(), player: youtubeBuffering(42) });
  assert.deepEqual(plan.publish, { positionSec: 42, playing: true });
});

test('heartbeat: buffering do MusicEngine (readyState < 3) publica igual', () => {
  const plan = planPositionHeartbeat({ playback: tocando(), player: engineBuffering(42) });
  assert.deepEqual(plan.publish, { positionSec: 42, playing: true });
});

test('heartbeat: com a sala tocando, nenhum estado de player produz playing:false', () => {
  const players = [
    youtubeBuffering(42),
    engineBuffering(42),
    { loading: false, buffering: false, playing: false, positionSec: 42 }, // autoplay bloqueado
    { loading: false, buffering: false, playing: true, positionSec: 42 },
    { loading: false, buffering: true, playing: false, positionSec: 0.5 },
  ];
  for (const player of players) {
    const { publish } = planPositionHeartbeat({ playback: tocando(), player });
    assert.notEqual(publish?.playing, false, `player ${JSON.stringify(player)} rebaixou a sala`);
  }
});

test('heartbeat: a guarda de loading continua valendo na troca de faixa', () => {
  const trocando = { loading: true, buffering: false, playing: false, positionSec: 0 };
  assert.equal(planPositionHeartbeat({ playback: tocando(), player: trocando }).publish, null);
  // Mesmo com o player já reportando posição, `loading` decide: a leitura é da
  // faixa velha.
  assert.equal(
    planPositionHeartbeat({ playback: tocando(), player: { ...trocando, positionSec: 99 } }).publish,
    null,
  );
});

test('heartbeat: leitura 0 em buffering com a sala adiante não rebobina ninguém', () => {
  const player = youtubeBuffering(0);
  assert.equal(planPositionHeartbeat({ playback: tocando({ positionSec: 30 }), player }).publish, null);
  // No começo da faixa não há o que preservar: o tique publica normalmente.
  assert.deepEqual(
    planPositionHeartbeat({ playback: tocando({ positionSec: 0 }), player }).publish,
    { positionSec: 0, playing: true },
  );
});

test('heartbeat: sala pausada e player ausente não publicam nada', () => {
  assert.equal(planPositionHeartbeat({ playback: tocando({ playing: false }), player: youtubeBuffering() }).publish, null);
  assert.equal(planPositionHeartbeat({ playback: tocando(), player: null }).publish, null);
  assert.equal(planPositionHeartbeat({}).publish, null);
});

test('heartbeat: buffering prolongado não interrompe a referência de posição', () => {
  // Quem está em `local` corrige deriva contra estas publicações; silenciar o
  // tique durante o engasgo trocaria um bug audível por um silencioso.
  const posicoes = [42, 42, 42.5, 43];
  const publicados = posicoes.map(
    (positionSec) => planPositionHeartbeat({ playback: tocando(), player: engineBuffering(positionSec) }).publish,
  )!;
  assert.equal(publicados.filter(Boolean).length, posicoes.length);
  assert.deepEqual(publicados.map((p) => p!.positionSec), posicoes);
});

test('heartbeat: pausa deliberada do dono propaga na hora e o tique não a desfaz', () => {
  // A pausa não passa pelo heartbeat: ela é publicada direto, com `playing`
  // explícito, e chega a todos por `applyPlayback`.
  const antes = { ...tocando(), receivedAt: 0 };
  const pausa = sanitizePlayback({ ...antes, playing: false, version: antes.version + 1 }, { ownerId: 'peer-a' })!;
  assert.equal(pausa.playing, false);
  const naSala = applyPlayback(withEntries(createSession(), [entry({ id: 'e1' })]), pausa, 100);
  assert.equal(naSala.playback.playing, false);
  assert.equal(naSala.playback.version, antes.version + 1);
  // E a partir daí o tique não republica nada: não há `playing: true` para
  // ressuscitar a faixa por baixo do usuário.
  assert.equal(planPositionHeartbeat({ playback: naSala.playback, player: engineBuffering(42) }).publish, null);
});
