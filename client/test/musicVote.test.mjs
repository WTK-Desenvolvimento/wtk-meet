/**
 * Votação da sala. Duas regras diferentes convivem aqui e as duas precisam ser
 * determinísticas: qualquer divergência de apuração vira "metade da sala com
 * música ligada", que é indepurável em produção.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  REPROPOSE_COOLDOWN_MS,
  VOTE_DURATION_MS,
  canPropose,
  castVote,
  chooseVote,
  cooldownRemainingMs,
  createVote,
  finalizeVote,
  isConclusive,
  isExpired,
  majorityOf,
  quorumFor,
  remainingMs,
  tally,
} = await import('../src/lib/musicVote.js');

function open(kind, electorate, proposerId = 'a') {
  return createVote({ voteId: 'v1', kind, proposerId, proposerName: 'Ana', electorate, openedAt: 0 });
}

test('o prazo padrão da votação é de 30 segundos', () => {
  assert.equal(VOTE_DURATION_MS, 30_000);
  assert.equal(remainingMs(open('enable', ['a']), 10_000), 20_000);
  assert.equal(isExpired(open('enable', ['a']), 30_000), true);
  assert.equal(isExpired(open('enable', ['a']), 29_999), false);
});

test('quórum é metade do eleitorado; maioria é metade mais um', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(quorumFor), [1, 1, 2, 2, 3, 3]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(majorityOf), [1, 2, 2, 3, 3, 4]);
});

test('habilitar: aprova com maioria dos votos válidos e quórum atingido', () => {
  let vote = open('enable', ['a', 'b', 'c']);
  vote = castVote(vote, 'a', 'yes');
  vote = castVote(vote, 'b', 'yes');
  const result = tally(vote);
  assert.equal(result.yes, 2);
  assert.equal(result.abstained, 1);
  assert.equal(result.quorumMet, true);
  assert.equal(result.approved, true);
});

test('habilitar: abstenção não conta como sim — só o voto do proponente reprova', () => {
  let vote = open('enable', ['a', 'b', 'c']);
  vote = castVote(vote, 'a', 'yes');
  const result = tally(vote);
  assert.equal(result.yes, 1);
  assert.equal(result.valid, 1);
  assert.equal(result.quorum, 2);
  assert.equal(result.quorumMet, false, 'um voto não atinge o quórum de 3 eleitores');
  assert.equal(result.approved, false);
});

test('habilitar: empate entre válidos não é maioria', () => {
  let vote = open('enable', ['a', 'b', 'c', 'd']);
  vote = castVote(vote, 'a', 'yes');
  vote = castVote(vote, 'b', 'yes');
  vote = castVote(vote, 'c', 'no');
  vote = castVote(vote, 'd', 'no');
  assert.equal(tally(vote).approved, false);
});

test('habilitar: participante sozinho liga o player sem depender de ninguém', () => {
  const vote = castVote(open('enable', ['a']), 'a', 'yes');
  assert.equal(tally(vote).approved, true);
  assert.equal(isConclusive(vote), true);
});

test('pular: exige maioria dos presentes, e abstenção pesa como ausência de apoio', () => {
  let vote = open('skip', ['a', 'b', 'c']);
  vote = castVote(vote, 'a', 'yes');
  assert.equal(tally(vote).approved, false, '1 de 3 não é maioria');
  vote = castVote(vote, 'b', 'yes');
  assert.equal(tally(vote).approved, true, '2 de 3 é maioria');
  // Maioria atingida é monotônica: dá para encerrar antes do prazo.
  assert.equal(isConclusive(vote), true);
});

test('pular: encerra cedo também quando a aprovação já é impossível', () => {
  let vote = open('skip', ['a', 'b', 'c']);
  vote = castVote(vote, 'a', 'no');
  vote = castVote(vote, 'b', 'no');
  assert.equal(isConclusive(vote), true);
  assert.equal(tally(vote).approved, false);
});

test('habilitar não encerra cedo: um "não" atrasado ainda derruba a maioria', () => {
  let vote = open('enable', ['a', 'b', 'c', 'd']);
  vote = castVote(vote, 'a', 'yes');
  vote = castVote(vote, 'b', 'yes');
  assert.equal(tally(vote).approved, true);
  assert.equal(isConclusive(vote), false, 'ainda faltam votos que podem mudar o resultado');
  vote = castVote(vote, 'c', 'no');
  vote = castVote(vote, 'd', 'no');
  assert.equal(tally(vote).approved, false);
  assert.equal(isConclusive(vote), true);
});

test('voto de quem não é eleitor, ou opção inválida, não tem efeito', () => {
  const base = open('enable', ['a', 'b']);
  assert.deepEqual(castVote(base, 'intruso', 'yes').votes, {});
  assert.deepEqual(castVote(base, 'a', 'talvez').votes, {});
  assert.deepEqual(castVote(base, 'a', 'yes').votes, { a: 'yes' });
});

test('quem entra durante a votação não vira eleitor: o eleitorado é fixado na abertura', () => {
  let vote = open('enable', ['a', 'b']);
  vote = castVote(vote, 'c', 'yes'); // entrou depois
  assert.equal(tally(vote).electorateSize, 2);
  assert.equal(tally(vote).yes, 0);
});

test('duas propostas simultâneas convergem para a mesma votação em todos os clients', () => {
  const first = createVote({ voteId: 'v-a', lamport: 4, proposerId: 'a', electorate: ['a', 'b'] });
  const second = createVote({ voteId: 'v-b', lamport: 5, proposerId: 'b', electorate: ['a', 'b'] });
  assert.equal(chooseVote(first, second).voteId, 'v-a');
  assert.equal(chooseVote(second, first).voteId, 'v-a', 'a ordem de chegada não pode importar');

  // Mesmo lamport: desempata pelo id do proponente, depois pelo id da votação.
  const tieA = createVote({ voteId: 'v-2', lamport: 7, proposerId: 'a', electorate: ['a'] });
  const tieB = createVote({ voteId: 'v-1', lamport: 7, proposerId: 'b', electorate: ['a'] });
  assert.equal(chooseVote(tieA, tieB).voteId, 'v-2');
  assert.equal(chooseVote(tieB, tieA).voteId, 'v-2');
  assert.equal(chooseVote(null, tieB).voteId, 'v-1');
  assert.equal(chooseVote(tieA, null).voteId, 'v-2');
});

test('anti-spam: reprovado, o mesmo proponente espera 2 minutos', () => {
  assert.equal(REPROPOSE_COOLDOWN_MS, 120_000);
  assert.equal(canPropose(undefined, 0), true);
  assert.equal(canPropose(1_000, 5_000), false);
  assert.equal(cooldownRemainingMs(1_000, 5_000), 116_000);
  assert.equal(canPropose(1_000, 1_000 + REPROPOSE_COOLDOWN_MS), true);
  assert.equal(cooldownRemainingMs(1_000, 1_000 + REPROPOSE_COOLDOWN_MS), 0);
});

test('finalizeVote publica o resultado que o árbitro anuncia', () => {
  let vote = open('skip', ['a', 'b']);
  vote.target = { entryId: 'e2', title: 'Próxima', direction: 'next' };
  vote = castVote(vote, 'a', 'yes');
  vote = castVote(vote, 'b', 'yes');
  assert.deepEqual(finalizeVote(vote), {
    voteId: 'v1',
    kind: 'skip',
    approved: true,
    yes: 2,
    no: 0,
    target: { entryId: 'e2', title: 'Próxima', direction: 'next' },
  });
});
