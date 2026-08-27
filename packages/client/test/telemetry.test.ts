/**
 * O beacon do client: para onde vai, o que leva, e quando **não** sai.
 *
 * `lib/telemetry.ts` é puro no mesmo sentido de `lib/iceServers.ts` — sem
 * `import.meta.env`, sem DOM implícito, com transporte e relógio injetáveis —
 * e é por isso que estes testes rodam em `node --test` sem jsdom e sem Vite.
 *
 * Dois testes usam o transporte **default** contra um `http.Server` local. Eles
 * existem porque o `Content-Type` do beacon não é detalhe: `text/plain` é
 * CORS-safelisted e não gera preflight, e um `application/json` faria o
 * navegador tentar um `OPTIONS` que, no `pagehide` de uma aba morrendo,
 * frequentemente não completa — o beacon sumiria em silêncio, e o sintoma seria
 * "o page view aparece, o fim de sessão nunca".
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  configureTelemetry,
  isTelemetryEnabled,
  resetTelemetry,
  startSession,
  trackPageView,
} from '../src/lib/telemetry.js';

import type { AddressInfo } from 'node:net';

/** Um transporte de teste: guarda o que sairia, sem sair. */
function capturar() {
  const enviados: { endpoint: string; body: string }[] = [];
  return {
    enviados,
    send: (endpoint: string, body: string) => {
      enviados.push({ endpoint, body });
    },
  };
}

test.afterEach(() => resetTelemetry());

test('page view viaja para o endpoint configurado, com event e route e nada mais', () => {
  const t = capturar();
  configureTelemetry({ endpoint: 'http://localhost:4000/telemetry', send: t.send });

  trackPageView('home');
  trackPageView('room');
  trackPageView('legacy');

  assert.equal(t.enviados.length, 3);
  assert.equal(t.enviados[0].endpoint, 'http://localhost:4000/telemetry');
  assert.deepEqual(
    t.enviados.map((e) => JSON.parse(e.body)),
    [
      { event: 'page_view', route: 'home' },
      { event: 'page_view', route: 'room' },
      { event: 'page_view', route: 'legacy' },
    ],
  );
});

test('o destino é o servidor de sinalização, e nunca o collector', () => {
  // O navegador não conhece o endereço da stack de monitoramento — se
  // conhecesse, ele estaria no bundle, legível no DevTools, e um collector OTLP
  // aberto na internet é vetor de flood contra o Prometheus.
  const t = capturar();
  configureTelemetry({ endpoint: 'http://localhost:4000/telemetry', send: t.send });
  trackPageView('home');
  assert.match(t.enviados[0].endpoint, /\/telemetry$/);
  assert.doesNotMatch(t.enviados[0].endpoint, /4317|4318|v1\/metrics|otlp|collector|alloy/i);
});

test('a sessão mede a duração com o relógio injetado, em milissegundos', () => {
  const t = capturar();
  let agora = 1_000;
  configureTelemetry({
    endpoint: '/telemetry',
    send: t.send,
    now: () => agora,
  });

  const sessao = startSession();
  agora = 1_000 + 95_000;
  sessao.end();

  assert.deepEqual(JSON.parse(t.enviados[0].body), {
    event: 'client_session_end',
    durationMs: 95_000,
  });
});

test('end é idempotente: pagehide e unmount não contam a mesma sessão duas vezes', () => {
  // Os dois gatilhos se sobrepõem por construção — fechar a aba de dentro de
  // uma sala dispara os dois. Sem idempotência, a mesma sessão apareceria duas
  // vezes no histograma, e com durações diferentes.
  const t = capturar();
  let agora = 0;
  configureTelemetry({ endpoint: '/telemetry', send: t.send, now: () => agora });

  const sessao = startSession();
  agora = 10_000;
  sessao.end();
  agora = 60_000;
  sessao.end();
  sessao.end();

  assert.equal(t.enviados.length, 1, 'um beacon, não três');
  assert.equal(JSON.parse(t.enviados[0].body).durationMs, 10_000, 'vale a primeira chamada');
});

test('relógio que anda para trás não gera beacon negativo', () => {
  // Ajuste de horário ou suspensão da máquina produziriam duração negativa, que
  // o servidor recusa com 400. Barrar aqui evita um beacon que só vira
  // `rejected` e polui a razão de rejeição do painel.
  const t = capturar();
  let agora = 100_000;
  configureTelemetry({ endpoint: '/telemetry', send: t.send, now: () => agora });
  const sessao = startSession();
  agora = 50_000;
  sessao.end();
  assert.equal(t.enviados.length, 0);
});

test('enabled:false não chama o transporte em nenhum dos três call sites', () => {
  const t = capturar();
  configureTelemetry({ endpoint: '/telemetry', enabled: false, send: t.send });

  assert.equal(isTelemetryEnabled(), false);
  trackPageView('home');
  trackPageView('room');
  trackPageView('legacy');
  startSession().end();

  assert.equal(t.enviados.length, 0, 'nenhuma requisição sai do browser');
});

test('startSession devolve um objeto utilizável mesmo com a telemetria desligada', () => {
  // O call site não deve precisar de um `if`, e um `null` aqui viraria um `?.`
  // esquecido em algum lugar — que só apareceria em produção.
  configureTelemetry({ endpoint: '/telemetry', enabled: false, send: () => {} });
  const sessao = startSession();
  assert.equal(typeof sessao.end, 'function');
  sessao.end();
});

test('sem endpoint, nada sai — e o módulo não reclama', () => {
  const t = capturar();
  configureTelemetry({ endpoint: null, send: t.send });
  assert.equal(isTelemetryEnabled(), false);
  trackPageView('home');
  assert.equal(t.enviados.length, 0);

  configureTelemetry({ endpoint: '', send: t.send });
  trackPageView('home');
  assert.equal(t.enviados.length, 0);
});

test('sem configurar nada, o módulo é inerte', () => {
  resetTelemetry();
  assert.equal(isTelemetryEnabled(), false);
  // Não lança: um import fora de ordem não pode derrubar a aplicação.
  trackPageView('home');
  startSession().end();
});

test('transporte que lança não derruba a página', () => {
  configureTelemetry({
    endpoint: '/telemetry',
    send: () => {
      throw new Error('rede caiu no meio do render');
    },
  });
  // O chamador é um `useEffect` de página: uma exceção aqui virava tela branca.
  trackPageView('home');
  startSession().end();
});

test('nenhum caminho devolve promise que alguém precise tratar', () => {
  // Uma promise rejeitada num `pagehide` vira `unhandledrejection` numa aba que
  // já está morrendo — barulho sem nada que se possa fazer a respeito.
  configureTelemetry({ endpoint: '/telemetry', send: () => {} });
  assert.equal(trackPageView('home'), undefined);
  assert.equal(startSession().end(), undefined);
});

// ─────────────────────── o transporte default, contra um servidor de verdade

test('o transporte default manda text/plain — o Content-Type que não gera preflight', async (t) => {
  const recebidas: { contentType: string; body: string; method: string }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      recebidas.push({
        contentType: String(req.headers['content-type'] ?? ''),
        body: raw,
        method: req.method ?? '',
      });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;

  // Sem `send` injetado: exercita o caminho real. Em `node --test` não há
  // `navigator.sendBeacon`, então cai no `fetch` com `keepalive` — que é
  // exatamente o fallback que roda no navegador quando o beacon é recusado.
  configureTelemetry({ endpoint: `http://127.0.0.1:${port}/telemetry` });
  trackPageView('room');

  const limite = Date.now() + 5000;
  while (recebidas.length === 0) {
    if (Date.now() > limite) throw new Error('o beacon não chegou em 5s');
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(recebidas[0].method, 'POST');
  assert.match(recebidas[0].contentType, /^text\/plain/, 'CORS-safelisted, sem preflight');
  assert.deepEqual(JSON.parse(recebidas[0].body), { event: 'page_view', route: 'room' });
});

test('servidor fora do ar não vira erro no console de quem só queria entrar numa sala', async () => {
  // Porta fechada de propósito. O `fetch` rejeita, e a rejeição é engolida
  // dentro do módulo: nenhuma `unhandledRejection` sobe daqui.
  configureTelemetry({ endpoint: 'http://127.0.0.1:1/telemetry' });
  trackPageView('home');
  startSession().end();
  await new Promise((r) => setTimeout(r, 300));
});
