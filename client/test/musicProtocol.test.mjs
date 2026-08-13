/**
 * Sanitização do que chega pelo data channel.
 *
 * Estes casos existem por duas razões distintas, e vale separá-las:
 *
 * 1. **Robustez.** Mensagem malformada não pode lançar nem alterar o estado. Num
 *    mesh sem servidor, uma exceção dentro do `onmessage` de um data channel não
 *    derruba nada visivelmente — ela só faz aquele participante parar de
 *    processar música, silenciosamente, para sempre.
 * 2. **Identidade.** O autor de qualquer mensagem é **o peer da conexão em que
 *    ela chegou**, nunca um campo do payload. Sem essa regra, um cliente
 *    modificado votaria e comandaria em nome de outro participante — e a votação
 *    inteira, que é o mecanismo de consentimento da sala, viraria decoração.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeMusicMessage } from '../src/lib/musicProtocol.js';

const FROM = 'peer-remetente';

function entry(overrides = {}) {
  return {
    id: 'entry-1',
    kind: 'url',
    title: 'Uma faixa',
    sourceRef: 'https://exemplo.test/audio.mp3',
    addedBy: 'quem-o-payload-diz',
    addedByName: 'Fulano',
    lamport: 3,
    ...overrides,
  };
}

test('mensagem fora do protocolo, sem tipo ou sem remetente é descartada', () => {
  assert.equal(sanitizeMusicMessage(null, { fromPeerId: FROM }), null);
  assert.equal(sanitizeMusicMessage({ type: 'chat' }, { fromPeerId: FROM }), null);
  assert.equal(sanitizeMusicMessage({ type: 'music-desconhecido' }, { fromPeerId: FROM }), null);
  // Sem peer de origem não há identidade possível — e identidade é o contrato.
  assert.equal(sanitizeMusicMessage({ type: 'music-queue-add', entry: entry() }, {}), null);
});

test('o autor da entrada é a conexão, não o que o payload declara', () => {
  const result = sanitizeMusicMessage(
    { type: 'music-queue-add', entry: entry() },
    { fromPeerId: FROM },
  );
  assert.equal(result.entry.addedBy, FROM);
  // O id, ao contrário do autor, é preservado: ele é a identidade compartilhada
  // da entrada, e regerá-lo faria a mesma faixa existir duas vezes na sala.
  assert.equal(result.entry.id, 'entry-1');
});

test('voto declarado em nome de outro é contado como voto de quem enviou', () => {
  const result = sanitizeMusicMessage(
    { type: 'music-vote-cast', voteId: 'v1', vote: 'yes', voterId: 'vitima' },
    { fromPeerId: FROM },
  );
  assert.equal(result.voterId, FROM);
  assert.equal(result.vote, 'yes');
});

test('opção de voto fora de yes/no é descartada', () => {
  const votes = ['talvez', '', null, 1, true];
  for (const vote of votes) {
    assert.equal(
      sanitizeMusicMessage({ type: 'music-vote-cast', voteId: 'v1', vote }, { fromPeerId: FROM }),
      null,
      `vote=${String(vote)} deveria ser descartado`,
    );
  }
});

test('esquema perigoso em sourceRef derruba a mensagem inteira', () => {
  for (const sourceRef of [
    'javascript:alert(1)',
    'data:audio/mp3;base64,AAAA',
    'file:///etc/passwd',
    'blob:https://exemplo.test/abc',
  ]) {
    assert.equal(
      sanitizeMusicMessage(
        { type: 'music-queue-add', entry: entry({ sourceRef }) },
        { fromPeerId: FROM },
      ),
      null,
      `${sourceRef} deveria ser descartado`,
    );
  }
});

test('kind desconhecido, campos faltando e tipos trocados são descartados', () => {
  const podres = [
    entry({ kind: 'torrent' }),
    entry({ kind: undefined }),
    entry({ id: undefined }),
    entry({ id: 42 }),
    entry({ title: '   ' }),
    entry({ title: 12 }),
    // YouTube só aceita videoId de 11 caracteres do alfabeto base64url.
    { ...entry(), kind: 'youtube', sourceRef: 'https://youtube.com/watch?v=abc' },
    // Arquivo local não carrega referência nenhuma: o arquivo não sai da máquina.
    { ...entry(), kind: 'file', sourceRef: 'https://exemplo.test/roubado.mp3' },
  ];
  for (const raw of podres) {
    assert.equal(
      sanitizeMusicMessage({ type: 'music-queue-add', entry: raw }, { fromPeerId: FROM }),
      null,
      `entrada podre aceita: ${JSON.stringify(raw)}`,
    );
  }
});

test('videoId válido do YouTube passa; o resto da entrada é normalizado', () => {
  const result = sanitizeMusicMessage(
    {
      type: 'music-queue-add',
      entry: entry({ kind: 'youtube', sourceRef: 'dQw4w9WgXcQ', title: 'x'.repeat(400) }),
    },
    { fromPeerId: FROM },
  );
  assert.equal(result.entry.sourceRef, 'dQw4w9WgXcQ');
  assert.equal(result.entry.title.length, 120);
});

test('reprodução só pode ser publicada em nome de quem envia', () => {
  const result = sanitizeMusicMessage(
    {
      type: 'music-playback',
      version: 7,
      ownerId: 'outro-participante',
      entryId: 'entry-1',
      positionSec: 12.5,
      playing: true,
      delivery: 'stream',
    },
    { fromPeerId: FROM },
  );
  assert.equal(result.playback.ownerId, FROM);
  assert.equal(result.playback.version, 7);
  assert.equal(result.playback.positionSec, 12.5);
});

test('reprodução com versão inválida ou entrega desconhecida é normalizada ou descartada', () => {
  assert.equal(
    sanitizeMusicMessage({ type: 'music-playback', version: -1 }, { fromPeerId: FROM }),
    null,
  );
  assert.equal(
    sanitizeMusicMessage({ type: 'music-playback', version: 'dois' }, { fromPeerId: FROM }),
    null,
  );
  const result = sanitizeMusicMessage(
    { type: 'music-playback', version: 1, entryId: 'e', playing: true, delivery: 'carteiro' },
    { fromPeerId: FROM },
  );
  assert.equal(result.playback.delivery, 'stream');
});

test('comando sem ação conhecida é descartado; ação conhecida carrega o autor', () => {
  assert.equal(
    sanitizeMusicMessage(
      { type: 'music-command', entryId: 'e1', action: 'apagar-tudo' },
      { fromPeerId: FROM },
    ),
    null,
  );
  const result = sanitizeMusicMessage(
    { type: 'music-command', entryId: 'e1', action: 'pause' },
    { fromPeerId: FROM },
  );
  assert.equal(result.action, 'pause');
  assert.equal(result.byId, FROM);
});

test('abertura de votação sem eleitorado é descartada e o proponente é o remetente', () => {
  assert.equal(
    sanitizeMusicMessage(
      { type: 'music-vote-open', voteId: 'v1', electorate: [] },
      { fromPeerId: FROM },
    ),
    null,
  );
  const result = sanitizeMusicMessage(
    {
      type: 'music-vote-open',
      voteId: 'v1',
      electorate: ['a', 'b', FROM],
      proposerName: 'Fulano',
      // Prazo absurdo não pode virar um card eterno na tela de todo mundo.
      durationMs: 99_999_999,
      lamport: 4,
    },
    { fromPeerId: FROM },
  );
  assert.equal(result.proposerId, FROM);
  assert.equal(result.durationMs, 30_000);
  assert.deepEqual(result.electorate, ['a', 'b', FROM]);
});

test('snapshot chega limitado e com o remetente identificado', () => {
  const result = sanitizeMusicMessage(
    {
      type: 'music-snapshot',
      enabled: true,
      lamport: 9,
      entries: Array.from({ length: 500 }, (_, i) => entry({ id: `e${i}` })),
      tombstones: ['t1', 42, null, 't2'],
      playback: { version: 2, entryId: 'e1' },
    },
    { fromPeerId: FROM },
  );
  assert.equal(result.fromPeerId, FROM);
  assert.equal(result.snapshot.enabled, true);
  assert.equal(result.snapshot.entries.length, 200);
  assert.deepEqual(result.snapshot.tombstones, ['t1', 't2']);
});
