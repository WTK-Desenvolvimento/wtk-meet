/**
 * Votação da sala — habilitar o player e pular faixa.
 *
 * Módulo **puro**: nenhum relógio de parede, nenhum timer, nenhum DOM. Todo
 * instante entra por parâmetro (`now`), sempre em milissegundos de um relógio
 * **local monótono** (`performance.now()` de quem chama). Isso não é preciosismo:
 * sem servidor não existe relógio comum, e comparar `Date.now()` de máquinas
 * diferentes é o caminho mais curto para dois clients apurarem resultados
 * diferentes.
 *
 * Duas regras de aprovação, porque as duas perguntas são diferentes:
 *
 * - `enable` — **maioria dos votos válidos, com quórum**. Abstenção não conta
 *   como sim: quem não vota não é somado a lado nenhum, mas a votação só é
 *   válida se pelo menos metade do eleitorado se manifestar. Ligar música para a
 *   sala inteira com o voto de uma pessoa distraída não é consentimento.
 * - `skip` — **maioria dos presentes**. Pular é interromper o que a sala está
 *   ouvindo; aqui abstenção é, na prática, um "não", e a regra fica monotônica
 *   (uma vez atingida a maioria, nunca desfeita), o que permite fechar a votação
 *   assim que o resultado é inevitável, sem esperar os 30s.
 *
 * O proponente é o **árbitro** da própria votação: ele apura e anuncia. Os demais
 * apuram em paralelo só para a UI. Isso troca um problema de consenso (cada
 * máquina expirando o prazo num instante diferente) por um anúncio.
 */

/** Prazo da votação. Curto de propósito: é uma decisão de playlist. */
export const VOTE_DURATION_MS = 30_000;

/** Após uma reprovação, o mesmo proponente fica em silêncio por 2 minutos. */
export const REPROPOSE_COOLDOWN_MS = 120_000;

export const VOTE_KINDS = new Set(['enable', 'skip']);

/** Maioria simples de um conjunto: metade + 1. */
export function majorityOf(size) {
  return Math.floor(Math.max(0, size) / 2) + 1;
}

/** Quórum mínimo de participação: metade do eleitorado, arredondada para cima. */
export function quorumFor(size) {
  return Math.max(1, Math.ceil(Math.max(0, size) / 2));
}

function normalizeElectorate(list) {
  const seen = new Set();
  for (const id of Array.isArray(list) ? list : []) {
    if (typeof id === 'string' && id) seen.add(id);
  }
  // Ordem estável: o eleitorado é comparado entre clients na UI.
  return [...seen].sort();
}

/**
 * Abre uma votação. `openedAt` é o relógio local de quem cria (ou de quem
 * recebe a abertura — cada client carimba na recepção, e é justamente por isso
 * que o prazo é aproximado e o resultado, anunciado).
 */
export function createVote({
  voteId,
  kind = 'enable',
  lamport = 0,
  proposerId,
  proposerName = '',
  electorate = [],
  durationMs = VOTE_DURATION_MS,
  openedAt = 0,
  target = null,
}) {
  return {
    voteId: String(voteId),
    kind: VOTE_KINDS.has(kind) ? kind : 'enable',
    lamport: Number.isFinite(lamport) ? lamport : 0,
    proposerId: String(proposerId || ''),
    proposerName: String(proposerName || '').slice(0, 40),
    electorate: normalizeElectorate(electorate),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : VOTE_DURATION_MS,
    openedAt,
    target: target || null,
    votes: {},
  };
}

/**
 * Registra um voto. O `voterId` é **sempre** o peer da conexão em que a mensagem
 * chegou — nunca um id declarado no payload (ver `musicProtocol.js`). Voto de
 * quem não é eleitor, ou opção fora de `yes`/`no`, é descartado sem efeito.
 */
export function castVote(vote, voterId, choice) {
  if (!vote) return vote;
  if (choice !== 'yes' && choice !== 'no') return vote;
  if (!vote.electorate.includes(voterId)) return vote;
  if (vote.votes[voterId] === choice) return vote;
  return { ...vote, votes: { ...vote.votes, [voterId]: choice } };
}

/** Apuração determinística. Mesmo conjunto de votos ⇒ mesmo resultado. */
export function tally(vote) {
  const electorateSize = vote?.electorate?.length || 0;
  let yes = 0;
  let no = 0;
  for (const id of vote?.electorate || []) {
    const choice = vote.votes[id];
    if (choice === 'yes') yes += 1;
    else if (choice === 'no') no += 1;
  }
  const valid = yes + no;
  const quorum = quorumFor(electorateSize);
  const majority = majorityOf(electorateSize);
  const quorumMet = valid >= quorum;
  const approved =
    vote?.kind === 'skip'
      ? yes >= majority
      : quorumMet && yes * 2 > valid;

  return {
    yes,
    no,
    valid,
    abstained: electorateSize - valid,
    electorateSize,
    quorum,
    quorumMet,
    majority,
    approved,
  };
}

export function remainingMs(vote, now) {
  if (!vote) return 0;
  return Math.max(0, vote.openedAt + vote.durationMs - now);
}

export function isExpired(vote, now) {
  return remainingMs(vote, now) <= 0;
}

/**
 * A votação pode ser encerrada antes do prazo?
 *
 * Todo mundo votou: sim, em qualquer modalidade. Em `skip`, também quando o
 * resultado já é inevitável nos dois sentidos (maioria atingida, ou impossível
 * de atingir com os votos que faltam) — é o que faz um pulo numa sala de duas
 * pessoas ser instantâneo em vez de uma cerimônia de 30 segundos.
 *
 * Em `enable`, aprovação **não** é monotônica (um "não" que chega depois pode
 * derrubar a maioria dos válidos), então só o prazo ou a votação completa fecham.
 */
export function isConclusive(vote) {
  if (!vote) return false;
  const result = tally(vote);
  if (result.valid >= result.electorateSize) return true;
  if (vote.kind !== 'skip') return false;
  const pending = result.electorateSize - result.valid;
  return result.approved || result.yes + pending < result.majority;
}

/** Forma final publicada pelo árbitro (`music-vote-result`). */
export function finalizeVote(vote) {
  const result = tally(vote);
  return {
    voteId: vote.voteId,
    kind: vote.kind,
    approved: result.approved,
    yes: result.yes,
    no: result.no,
    target: vote.target || null,
  };
}

/**
 * Duas propostas no mesmo instante têm que virar **uma** votação, igual em todos
 * os clients. Vence a de menor `(lamport, proposerId, voteId)` — comparação
 * total sobre valores que todos veem, então todos escolhem a mesma sem trocar
 * mensagem nenhuma.
 */
export function chooseVote(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a.voteId === b.voteId) return a;
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? a : b;
  if (a.proposerId !== b.proposerId) return a.proposerId < b.proposerId ? a : b;
  return a.voteId <= b.voteId ? a : b;
}

/**
 * Anti-spam: depois de uma proposta reprovada, o mesmo autor fica bloqueado por
 * `REPROPOSE_COOLDOWN_MS`. Verificado por **quem recebe**, não só por quem
 * propõe — a trava não pode depender da boa vontade do client do outro lado.
 */
export function canPropose(lastRejectedAt, now, cooldownMs = REPROPOSE_COOLDOWN_MS) {
  if (!Number.isFinite(lastRejectedAt)) return true;
  return now - lastRejectedAt >= cooldownMs;
}

export function cooldownRemainingMs(lastRejectedAt, now, cooldownMs = REPROPOSE_COOLDOWN_MS) {
  if (!Number.isFinite(lastRejectedAt)) return 0;
  return Math.max(0, lastRejectedAt + cooldownMs - now);
}
