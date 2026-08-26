/**
 * O provedor de ICE servers, isolado: prazo, coalescência e o motivo da falha.
 *
 * O defeito que este módulo corrige era invisível por construção — a credencial
 * ficava cacheada pela sessão inteira da aba e vencia calada, e como o client
 * roda `iceTransportPolicy: 'relay'`, credencial vencida não degrada nada: ela
 * simplesmente impede o navegador de gerar qualquer candidato. A conexão nova
 * não fecha, a antiga continua de pé, e o resultado é "às vezes, contra um
 * participante".
 *
 * Relógio e `fetch` são dublês. Testar prazo com relógio de verdade obrigaria a
 * suíte a esperar o prazo passar, e o caso que interessa (24h) não cabe numa
 * execução de teste.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FALLBACK_TTL_SECONDS,
  createIceServerProvider,
  hasTurnServer,
  renewMarginMs,
} from '../src/lib/iceServers.js';

/**
 * Uma resposta programada do `fetch` dublê: ou uma função (que decide na hora),
 * ou a descrição do que o provedor vai encontrar.
 */
type RespostaProgramada =
  | (() => unknown)
  | {
      ok?: boolean;
      status?: number;
      throws?: string;
      badJson?: boolean;
      body?: { iceServers?: unknown; ttl?: unknown; expiresAt?: unknown };
    };

const ENDPOINT = 'http://signaling.test/turn-credentials';
const TURN = [{ urls: ['turn:relay.test:3478?transport=udp'], username: 'u', credential: 'c' }];
const SO_STUN = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

/** Relógio manual: `clock.advance(ms)` é a única forma de o tempo passar. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/**
 * `fetch` dublê. Cada chamada consome a próxima resposta programada; o padrão é
 * 200 com TURN e ttl de 3600.
 */
function fakeFetch(responses: RespostaProgramada[] = []) {
  const calls: string[] = [];
  let pending = [...responses];
  const impl = async (url: string) => {
    calls.push(url);
    const next = pending.shift() ?? { ok: true, body: { iceServers: TURN, ttl: 3600 } };
    if (typeof next === 'function') return next();
    if (next.throws) throw new Error(next.throws);
    return {
      ok: next.ok !== false,
      status: next.status ?? (next.ok === false ? 500 : 200),
      json: async () => {
        if (next.badJson) throw new Error('Unexpected token < in JSON');
        return next.body;
      },
    };
  };
  // As duas propriedades penduradas na função: é assim que o caso programa a
  // próxima resposta e lê o que foi pedido.
  return Object.assign(impl, {
    calls,
    program: (list: RespostaProgramada[]) => {
      pending = [...list];
    },
  });
}

function makeProvider({
  fetchImpl,
  clock = fakeClock(),
  minRetryMs = 5_000,
}: {
  fetchImpl?: ReturnType<typeof fakeFetch>;
  clock?: ReturnType<typeof fakeClock>;
  minRetryMs?: number;
} = {}) {
  const warnings: string[] = [];
  const provider = createIceServerProvider({
    endpoint: ENDPOINT,
    // O cast: o dublê devolve só `ok`/`status`/`json()`, que é o que o provedor lê.
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: clock.now,
    minRetryMs,
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
  });
  return { provider, clock, warnings };
}

// ------------------------------------------------------------------ utilitário

test('hasTurnServer aceita turn:/turns: e recusa uma lista só de STUN', () => {
  assert.equal(hasTurnServer(TURN), true);
  assert.equal(hasTurnServer([{ urls: 'turns:relay.test:5349' }]), true);
  assert.equal(hasTurnServer([{ urls: ['stun:stun.cloudflare.com:3478'] }]), false);
  assert.equal(hasTurnServer([]), false);
  assert.equal(hasTurnServer(null), false);
  // Uma lista mista conecta: basta um TURN.
  assert.equal(hasTurnServer([{ urls: 'stun:a:3478' }, { urls: 'turn:b:3478' }]), true);
});

test('a margem de renovação é sempre menor que o próprio TTL (R11)', () => {
  for (const ttl of [1, 10, 60, 300, 600, 3600, 86400]) {
    assert.ok(renewMarginMs(ttl) < ttl * 1000, `ttl=${ttl} renovaria em laço`);
  }
  assert.equal(renewMarginMs(3600), 60_000, 'com TTL grande a margem satura em 60s');
  assert.equal(renewMarginMs(300), 30_000, 'com TTL pequeno ela é 10% dele');
});

// ------------------------------------------------------------ cache e renovação

test('duas chamadas concorrentes com cache frio fazem UMA requisição (A8)', async () => {
  const fetchImpl = fakeFetch();
  const { provider } = makeProvider({ fetchImpl });

  const [a, b, c] = await Promise.all([provider.get(), provider.get(), provider.get()]);

  assert.equal(fetchImpl.calls.length, 1, 'cinco addPeer numa entrada não são cinco requisições');
  assert.deepEqual(a, TURN);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('dentro da validade reaproveita o cache; passada a margem, renova (A9)', async () => {
  const fetchImpl = fakeFetch();
  const { provider, clock } = makeProvider({ fetchImpl });

  await provider.get();
  assert.equal(fetchImpl.calls.length, 1);

  // ttl 3600s, margem 60s => renova a partir de 3540s.
  clock.advance(3_539_000);
  await provider.get();
  assert.equal(fetchImpl.calls.length, 1, 'antes da margem não refaz a requisição');

  clock.advance(2_000);
  await provider.get();
  assert.equal(fetchImpl.calls.length, 2, 'passada a margem, renova');
});

test('force renova mesmo com cache quente — é o que a recuperação usa', async () => {
  const fetchImpl = fakeFetch();
  const { provider } = makeProvider({ fetchImpl });

  await provider.get();
  await provider.get({ force: true });

  assert.equal(fetchImpl.calls.length, 2);
});

test('ttl patológico ou ausente vira o fallback curto, com aviso (R11)', async () => {
  for (const ttl of [undefined, 0, -1, 'abc', NaN, null]) {
    const fetchImpl = fakeFetch([{ ok: true, body: { iceServers: TURN, ttl } }]);
    const { provider, clock, warnings } = makeProvider({ fetchImpl });

    await provider.get();
    assert.equal(provider.describe().ttl, FALLBACK_TTL_SECONDS, `ttl=${String(ttl)}`);
    assert.ok(warnings.some((w) => w.includes('ttl')), `ttl=${String(ttl)} precisa avisar`);

    // E o principal: não renova em laço. Uma segunda chamada imediata não
    // dispara requisição nenhuma.
    await provider.get();
    assert.equal(fetchImpl.calls.length, 1, `ttl=${String(ttl)} renovou em laço`);

    clock.advance(FALLBACK_TTL_SECONDS * 1000);
    await provider.get();
    assert.equal(fetchImpl.calls.length, 2, `ttl=${String(ttl)} não renovou no prazo`);
  }
});

test('ttl de 1s não renova em laço: a margem é 10% dele (R11)', async () => {
  const fetchImpl = fakeFetch([
    { ok: true, body: { iceServers: TURN, ttl: 1 } },
    { ok: true, body: { iceServers: TURN, ttl: 1 } },
  ]);
  const { provider, clock } = makeProvider({ fetchImpl });

  await provider.get();
  await provider.get();
  assert.equal(fetchImpl.calls.length, 1, 'não renova no mesmo instante em que recebeu');

  clock.advance(950);
  await provider.get();
  assert.equal(fetchImpl.calls.length, 2);
});

test('expiresAt do servidor é ignorado — o prazo sai do relógio local (D1)', async () => {
  // Servidor "adiantado 10 anos": um provedor que confiasse no instante absoluto
  // usaria esta credencial para sempre.
  const fetchImpl = fakeFetch([
    {
      ok: true,
      body: { iceServers: TURN, ttl: 600, expiresAt: new Date(Date.now() + 3.2e11).toISOString() },
    },
  ]);
  const { provider, clock } = makeProvider({ fetchImpl });

  await provider.get();
  clock.advance(600_000);
  await provider.get();

  assert.equal(fetchImpl.calls.length, 2, 'o ttl mandou, não o expiresAt');
});

// ---------------------------------------------------------------------- falhas

test('cada falha tem seu status, e NENHUMA devolve STUN (A10, D3)', async () => {
  const casos: [RespostaProgramada, string][] = [
    [{ ok: false, status: 503 }, 'unconfigured'],
    [{ ok: false, status: 502 }, 'upstream'],
    [{ ok: false, status: 500 }, 'unreachable'],
    [{ throws: 'Failed to fetch' }, 'unreachable'],
    [{ ok: true, badJson: true }, 'unreachable'],
    [{ ok: true, body: { iceServers: [] } }, 'unreachable'],
    // O formato mais enganoso: 200, lista não vazia, tipos todos certos — e
    // zero candidatos utilizáveis sob `relay`. Era o que o fallback antigo
    // produzia, e aceitá-lo aqui reintroduziria o silêncio pela porta dos
    // fundos, cacheado por um TTL inteiro.
    [{ ok: true, body: { iceServers: SO_STUN, ttl: 3600 } }, 'unreachable'],
  ];

  for (const [resposta, esperado] of casos) {
    const fetchImpl = fakeFetch([resposta]);
    const { provider } = makeProvider({ fetchImpl });

    const servers = await provider.get();

    assert.deepEqual(servers, [], `${esperado}: lista vazia`);
    assert.equal(provider.status(), esperado);
    assert.equal(hasTurnServer(servers), false);
    assert.equal(
      JSON.stringify(servers).includes('stun:'),
      false,
      'STUN puro sob relay é falha com cara de sucesso — não pode aparecer',
    );
  }
});

test('o provedor resolve em vez de rejeitar, sempre (A10, D4)', async () => {
  const fetchImpl = fakeFetch([{ throws: 'rede caiu' }]);
  const { provider } = makeProvider({ fetchImpl });

  // Uma rejeição aqui viraria tela de "acesso negado" sem motivo no Room.jsx.
  await assert.doesNotReject(() => provider.get());
});

test('renovação falha mas a credencial anterior ainda vale: serve stale (A11)', async () => {
  const fetchImpl = fakeFetch([
    { ok: true, body: { iceServers: TURN, ttl: 600 } },
    { ok: false, status: 502 },
  ]);
  const { provider, clock } = makeProvider({ fetchImpl });

  await provider.get();
  clock.advance(571_000); // passou a margem (30s), ainda dentro do ttl

  const servers = await provider.get();
  assert.deepEqual(servers, TURN, 'não derruba a sala por um soluço de rede');
  assert.equal(provider.status(), 'stale');
});

test('renovação falha e a anterior já venceu: lista vazia (A11)', async () => {
  const fetchImpl = fakeFetch([
    { ok: true, body: { iceServers: TURN, ttl: 600 } },
    { ok: false, status: 502 },
  ]);
  const { provider, clock } = makeProvider({ fetchImpl });

  await provider.get();
  clock.advance(600_001); // venceu

  const servers = await provider.get();
  assert.deepEqual(servers, [], 'credencial vencida é tão inútil quanto lista vazia sob relay');
  assert.equal(provider.status(), 'upstream');
});

test('depois de falhar, nova tentativa dentro do intervalo mínimo não vai à rede (A12)', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 502 }]);
  const { provider, clock } = makeProvider({ fetchImpl, minRetryMs: 5_000 });

  await provider.get();
  assert.equal(fetchImpl.calls.length, 1);

  clock.advance(4_000);
  assert.deepEqual(await provider.get(), []);
  assert.deepEqual(await provider.get({ force: true }), [], 'nem force fura o intervalo mínimo');
  assert.equal(fetchImpl.calls.length, 1, 'o backoff da recuperação não vira enxurrada');
  assert.equal(provider.status(), 'upstream', 'o motivo da falha sobrevive à espera');

  clock.advance(1_100);
  await provider.get();
  assert.equal(fetchImpl.calls.length, 2);
});

test('uma renovação bem-sucedida apaga o histórico de falha', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 503 }, { ok: true, body: { iceServers: TURN, ttl: 600 } }]);
  const { provider, clock } = makeProvider({ fetchImpl });

  await provider.get();
  assert.equal(provider.status(), 'unconfigured');

  clock.advance(6_000);
  assert.deepEqual(await provider.get(), TURN);
  assert.equal(provider.status(), 'ok');
  assert.deepEqual(provider.describe().lastFailureKind, null);
});

test('sem endpoint configurado avisa e devolve vazio, sem lançar', async () => {
  const warnings: string[] = [];
  const provider = createIceServerProvider({
    warn: (...a: unknown[]) => warnings.push(a.join(' ')),
  });

  assert.deepEqual(await provider.get(), []);
  assert.equal(provider.status(), 'unreachable');
  assert.ok(warnings.some((w) => w.includes('endpoint')));
});

test('configure com endpoint novo esquece o cache do anterior', async () => {
  const fetchImpl = fakeFetch();
  const { provider } = makeProvider({ fetchImpl });

  await provider.get();
  provider.configure({ endpoint: 'http://outro.test/turn-credentials' });
  await provider.get();

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1], 'http://outro.test/turn-credentials');
});
