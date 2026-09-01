/**
 * O envelope do beacon — a fronteira mais barata de defender e a mais fácil de
 * furar por engano.
 *
 * `parseBeacon` é a única coisa entre um `POST /telemetry` público, sem
 * autenticação e chamável por qualquer página da internet, e os instrumentos de
 * métrica. O que estes testes caracterizam não é só "recusa lixo": é que ele
 * **constrói um objeto novo**, campo a campo, e que por isso não existe caminho
 * por onde uma chave desconhecida — `roomId`, `displayName`, `ip` — atravesse.
 *
 * Puro: nenhum servidor sobe aqui, nenhuma porta é aberta.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_SESSION_DURATION_MS, PAGE_VIEW_ROUTES, parseBeacon } from '../src/telemetryEvents.js';

test('page_view das três rotas passa, e devolve só event e route', () => {
  for (const route of PAGE_VIEW_ROUTES) {
    assert.deepEqual(parseBeacon({ event: 'page_view', route }), { event: 'page_view', route });
  }
});

test('client_session_end aceita as durações plausíveis, inclusive as bordas', () => {
  for (const durationMs of [0, 1, 4_999, 3_600_000, MAX_SESSION_DURATION_MS]) {
    assert.deepEqual(parseBeacon({ event: 'client_session_end', durationMs }), {
      event: 'client_session_end',
      durationMs,
    });
  }
});

test('chaves desconhecidas não sobrevivem ao parse — nem as que dariam nome à sala', () => {
  // Este é o teste que sustenta o compromisso inteiro. O beacon chega com tudo
  // o que um call site distraído poderia ter anexado; o que sai tem dois campos.
  const parsed = parseBeacon({
    event: 'page_view',
    route: 'room',
    roomId: 'sala-secreta-do-nicolas',
    displayName: 'Nicolas Woitchik',
    ip: '203.0.113.7',
    sessionId: 'abc-123',
    passphrase: 'entrada-guitarra-vermelha',
  });

  assert.deepEqual(parsed, { event: 'page_view', route: 'room' });
  assert.deepEqual(Object.keys(parsed ?? {}), ['event', 'route'], 'exatamente duas chaves');
  assert.doesNotMatch(JSON.stringify(parsed), /sala-secreta|Nicolas|203\.0\.113|abc-123|guitarra/);
});

test('rota fora do conjunto fechado é recusada', () => {
  for (const route of ['settings', 'HOME', '', 'room ', null, 42, undefined, ['home']]) {
    assert.equal(parseBeacon({ event: 'page_view', route }), null, `route=${JSON.stringify(route)}`);
  }
});

test('page_view sem route é recusado — não existe rota default', () => {
  // Uma rota default transformaria beacon malformado em contagem inventada, e
  // o painel mostraria tráfego que não houve.
  assert.equal(parseBeacon({ event: 'page_view' }), null);
});

test('durationMs não-numérico, infinito, negativo ou absurdo é recusado', () => {
  const recusados: unknown[] = [
    '5000',
    NaN,
    Infinity,
    -Infinity,
    -1,
    -0.0001,
    MAX_SESSION_DURATION_MS + 1,
    1e12,
    null,
    undefined,
    {},
    [],
    true,
  ];
  for (const durationMs of recusados) {
    assert.equal(
      parseBeacon({ event: 'client_session_end', durationMs }),
      null,
      `durationMs=${String(durationMs)}`,
    );
  }
});

test('o teto de duração existe para proteger a soma cumulativa do histograma', () => {
  // Com temporalidade cumulativa, um único `1e18` contamina o `sum` da série
  // para sempre: o único conserto seria reiniciar o processo.
  assert.equal(parseBeacon({ event: 'client_session_end', durationMs: 1e18 }), null);
  assert.equal(MAX_SESSION_DURATION_MS, 86_400_000, '24h em milissegundos');
});

test('event fora do enum, ausente ou não-string é recusado', () => {
  for (const event of ['pageview', 'page_view ', 'session_end', '', null, 7, {}]) {
    assert.equal(parseBeacon({ event }), null, `event=${JSON.stringify(event)}`);
  }
  assert.equal(parseBeacon({}), null);
});

test('corpo que não é objeto — array, null, número, string, boolean — é recusado', () => {
  for (const body of [[], null, undefined, 0, 42, 'page_view', '', true, false]) {
    assert.equal(parseBeacon(body), null, `body=${JSON.stringify(body)}`);
  }
  // O array merece linha própria: `typeof [] === 'object'` e `[].event` é
  // `undefined`, então ele seria barrado por acidente, e não por decisão.
  assert.equal(parseBeacon([{ event: 'page_view', route: 'home' }]), null);
});

test('não existe campo de identificador em envelope nenhum', () => {
  // A prova por construção: o que o parse devolve, para os dois eventos
  // válidos, tem exatamente as chaves declaradas. Acrescentar um `sessionId`
  // "só para deduplicar" quebra este teste — que é o ponto.
  assert.deepEqual(Object.keys(parseBeacon({ event: 'page_view', route: 'home' }) ?? {}).sort(), [
    'event',
    'route',
  ]);
  assert.deepEqual(
    Object.keys(parseBeacon({ event: 'client_session_end', durationMs: 10 }) ?? {}).sort(),
    ['durationMs', 'event'],
  );
});

test('o corpo recebido não é mutado nem reaproveitado como retorno', () => {
  const body = { event: 'page_view', route: 'home', extra: 'x' };
  const parsed = parseBeacon(body);
  assert.notEqual(parsed, body, 'objeto novo, não o mesmo por referência');
  assert.deepEqual(body, { event: 'page_view', route: 'home', extra: 'x' }, 'entrada intacta');
});
