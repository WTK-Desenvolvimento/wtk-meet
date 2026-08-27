/**
 * Os instrumentos, o no-op e a rota — as três coisas que decidem se a
 * telemetria é útil, invisível ou perigosa.
 *
 * Duas metades, por dois motivos diferentes:
 *
 * 1. **Instrumentos, in-process, com o `InMemoryMetricExporter` do próprio
 *    SDK.** A asserção é feita sobre a estrutura `ResourceMetrics` de verdade —
 *    a mesma que iria pro fio — sem abrir socket nenhum. É aqui que se prova o
 *    catálogo fechado, as unidades, as fronteiras de bucket e a allow-list de
 *    atributos.
 * 2. **A rota, com o `index.ts` de verdade num processo filho.** 204/400/413/429
 *    e a receita de `curl` do DoD dependem de Express, de body-parser e da
 *    ordem exata dos middlewares — simular isso provaria só que a simulação
 *    concorda consigo mesma.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';

import {
  DURATION_BUCKETS_SECONDS,
  OCCUPANCY_BUCKETS,
  initTelemetry,
  metricsUrl,
  withThrottledWarning,
} from '../src/telemetry.js';
import { startFakeCollector, startServer } from './fixtures/telemetryHarness.js';

import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { Telemetry } from '../src/telemetry.js';
import type { RunningServer } from './fixtures/telemetryHarness.js';

/** O catálogo do DoD, verbatim. Nove nomes, nem um a mais. */
const CATALOGO = [
  'wtk_rooms_active',
  'wtk_participants_active',
  'wtk_room_occupancy',
  'wtk_session_duration_seconds',
  'wtk_room_lifetime_seconds',
  'wtk_joins_total',
  'wtk_page_views_total',
  'wtk_client_session_duration_seconds',
  'wtk_telemetry_beacons_total',
];

interface Colhido {
  name: string;
  unit: string;
  attributes: Record<string, unknown>;
  value: unknown;
}

/**
 * Força uma coleta e devolve as séries achatadas.
 *
 * `shutdown()` é o gatilho porque ele faz o reader coletar e exportar uma
 * última vez — é o jeito determinístico de fechar a janela sem depender de
 * temporizador.
 */
async function colher(telemetry: Telemetry, exporter: InMemoryMetricExporter): Promise<Colhido[]> {
  await telemetry.shutdown();
  const out: Colhido[] = [];
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        for (const point of metric.dataPoints) {
          out.push({
            name: metric.descriptor.name,
            unit: metric.descriptor.unit,
            attributes: point.attributes,
            value: point.value,
          });
        }
      }
    }
  }
  return out;
}

function novaTelemetria(snapshot = () => ({ rooms: 0, participants: 0 })) {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = initTelemetry({ exporter, snapshot, intervalMs: 60_000 });
  return { exporter, telemetry };
}

// ───────────────────────────────────────── 1. o catálogo, fechado

test('exporta exatamente os nove instrumentos do DoD, com as unidades declaradas', async () => {
  const { exporter, telemetry } = novaTelemetria(() => ({ rooms: 2, participants: 5 }));
  telemetry.recordJoin('admitted');
  telemetry.recordSessionEnd(65_000);
  telemetry.recordRoomClosed(1_200_000, 4);
  telemetry.recordPageView('home');
  telemetry.recordClientSession(30_000);
  telemetry.recordBeacon('accepted');

  const colhidas = await colher(telemetry, exporter);
  const nomes = [...new Set(colhidas.map((m) => m.name))].sort();
  assert.deepEqual(nomes, [...CATALOGO].sort(), 'nem um instrumento a mais, nem um a menos');

  const unidade = (name: string) => colhidas.find((m) => m.name === name)?.unit;
  assert.equal(unidade('wtk_rooms_active'), '{room}');
  assert.equal(unidade('wtk_participants_active'), '{participant}');
  assert.equal(unidade('wtk_room_occupancy'), '{participant}');
  assert.equal(unidade('wtk_session_duration_seconds'), 's');
  assert.equal(unidade('wtk_room_lifetime_seconds'), 's');
  assert.equal(unidade('wtk_client_session_duration_seconds'), 's');
  assert.equal(unidade('wtk_joins_total'), '{join}');
  assert.equal(unidade('wtk_page_views_total'), '{page_view}');
  assert.equal(unidade('wtk_telemetry_beacons_total'), '{beacon}');
});

test('as fronteiras de bucket são as do documento, e a ocupação para em 6', async () => {
  const { exporter, telemetry } = novaTelemetria();
  telemetry.recordSessionEnd(65_000);
  telemetry.recordRoomClosed(120_000, 3);
  telemetry.recordClientSession(10_000);

  const colhidas = await colher(telemetry, exporter);
  const fronteiras = (name: string) =>
    (colhidas.find((m) => m.name === name)?.value as { buckets: { boundaries: number[] } }).buckets
      .boundaries;

  assert.deepEqual(fronteiras('wtk_session_duration_seconds'), DURATION_BUCKETS_SECONDS);
  assert.deepEqual(fronteiras('wtk_room_lifetime_seconds'), DURATION_BUCKETS_SECONDS);
  assert.deepEqual(fronteiras('wtk_client_session_duration_seconds'), DURATION_BUCKETS_SECONDS);
  assert.deepEqual(fronteiras('wtk_room_occupancy'), OCCUPANCY_BUCKETS);
  // `MAX_PARTICIPANTS` é 6: o bucket `+Inf` da ocupação deve ficar vazio para
  // sempre. Se ele encher, há defeito na contagem — e isso é sinal por si só.
  const ocupacao = colhidas.find((m) => m.name === 'wtk_room_occupancy')?.value as {
    buckets: { counts: number[] };
  };
  assert.equal(ocupacao.buckets.counts.at(-1), 0, 'o +Inf da ocupação nasce e fica vazio');
});

test('durações são gravadas em segundos, e não em milissegundos', async () => {
  // O nome do instrumento diz `_seconds` e a unidade diz `s`; gravar
  // milissegundos aqui faria o painel mostrar reuniões de mil horas sem que
  // nenhum teste de tipo reclamasse.
  const { exporter, telemetry } = novaTelemetria();
  telemetry.recordSessionEnd(90_000);
  const colhidas = await colher(telemetry, exporter);
  const hist = colhidas.find((m) => m.name === 'wtk_session_duration_seconds')?.value as {
    sum: number;
    count: number;
  };
  assert.equal(hist.sum, 90);
  assert.equal(hist.count, 1);
});

test('os únicos atributos do sistema são outcome e route, nos valores fechados', async () => {
  const { exporter, telemetry } = novaTelemetria(() => ({ rooms: 1, participants: 2 }));
  for (const outcome of ['admitted', 'approved', 'denied', 'room_full', 'invalid_room'] as const) {
    telemetry.recordJoin(outcome);
  }
  for (const route of ['home', 'room', 'legacy'] as const) telemetry.recordPageView(route);
  telemetry.recordBeacon('accepted');
  telemetry.recordBeacon('rejected');
  telemetry.recordSessionEnd(1000);
  telemetry.recordRoomClosed(1000, 2);
  telemetry.recordClientSession(1000);

  const colhidas = await colher(telemetry, exporter);
  const chaves = new Set<string>();
  for (const m of colhidas) for (const k of Object.keys(m.attributes)) chaves.add(k);
  assert.deepEqual([...chaves].sort(), ['outcome', 'route']);

  const valores = (name: string, key: string) =>
    colhidas
      .filter((m) => m.name === name)
      .map((m) => String(m.attributes[key]))
      .sort();
  assert.deepEqual(valores('wtk_joins_total', 'outcome'), [
    'admitted',
    'approved',
    'denied',
    'invalid_room',
    'room_full',
  ]);
  assert.deepEqual(valores('wtk_page_views_total', 'route'), ['home', 'legacy', 'room']);
  assert.deepEqual(valores('wtk_telemetry_beacons_total', 'outcome'), ['accepted', 'rejected']);

  // Os histogramas não têm atributo nenhum: uma dimensão a mais neles seria
  // exatamente o lugar por onde um label de sala entraria sem chamar atenção.
  for (const name of ['wtk_session_duration_seconds', 'wtk_room_occupancy']) {
    for (const m of colhidas.filter((x) => x.name === name)) {
      assert.deepEqual(m.attributes, {}, `${name} sem atributos`);
    }
  }
});

test('a allow-list descarta, antes da agregação, um atributo que um call site futuro acrescentasse', async () => {
  // Reforço **estrutural**, e não disciplina: o teste chama o instrumento por
  // baixo do tipo, como faria um `recordJoin` reescrito por engano com um
  // segundo campo, e a série resultante continua tendo só `outcome`.
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = initTelemetry({ exporter, snapshot: () => ({ rooms: 0, participants: 0 }) });
  const contrabando = telemetry.recordJoin as unknown as (o: unknown) => void;
  contrabando({ toString: () => 'admitted' });
  telemetry.recordJoin('admitted');

  const colhidas = await colher(telemetry, exporter);
  const joins = colhidas.filter((m) => m.name === 'wtk_joins_total');
  for (const m of joins) {
    assert.deepEqual(Object.keys(m.attributes), ['outcome']);
  }
});

// ───────────────────────────────────────── 2. gauges, derivados do store

test('os gauges são leitura do snapshot, e não contagem própria', async () => {
  let estado = { rooms: 7, participants: 19 };
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = initTelemetry({ exporter, snapshot: () => estado });
  estado = { rooms: 0, participants: 0 };

  const colhidas = await colher(telemetry, exporter);
  // Zero, e não 7: o valor vem do instante da coleta, não de um contador que
  // alguém teria que lembrar de decrementar em cada um dos quatro caminhos de
  // saída deste servidor.
  assert.equal(colhidas.find((m) => m.name === 'wtk_rooms_active')?.value, 0);
  assert.equal(colhidas.find((m) => m.name === 'wtk_participants_active')?.value, 0);
});

test('snapshot que lança não derruba a coleta: fica o último valor conhecido', async () => {
  let quebrado = false;
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = initTelemetry({
    exporter,
    // Intervalo curto para haver uma coleta boa **antes** de o snapshot
    // quebrar: é ela que estabelece o "último valor conhecido".
    intervalMs: 150,
    snapshot: () => {
      if (quebrado) throw new Error('mutação concorrente');
      return { rooms: 3, participants: 8 };
    },
  });
  const limite = Date.now() + 5000;
  while (exporter.getMetrics().length === 0) {
    if (Date.now() > limite) throw new Error('nenhuma exportação em 5s');
    await new Promise((r) => setTimeout(r, 25));
  }
  quebrado = true;

  const colhidas = await colher(telemetry, exporter);
  const salas = colhidas.filter((m) => m.name === 'wtk_rooms_active').at(-1);
  assert.equal(salas?.value, 3, 'o callback é total: nada explode e nada some');
});

// ───────────────────────────────────────── 3. o no-op

test('sem endpoint e sem exporter, initTelemetry é no-op com um aviso só', () => {
  const avisos: string[] = [];
  const telemetry = initTelemetry({
    endpoint: '',
    logger: { warn: (...args: unknown[]) => avisos.push(args.join(' ')) },
  });

  assert.equal(telemetry.enabled, false);
  assert.equal(avisos.length, 1, 'um aviso, não zero e não uma enxurrada');
  assert.match(avisos[0], /OTEL_EXPORTER_OTLP_ENDPOINT/);

  // Mesma superfície, todos os métodos vazios — o call site não precisa saber.
  telemetry.recordJoin('admitted');
  telemetry.recordSessionEnd(1);
  telemetry.recordRoomClosed(1, 1);
  telemetry.recordPageView('home');
  telemetry.recordClientSession(1);
  telemetry.recordBeacon('rejected');
  assert.equal(avisos.length, 1, 'nenhum método do no-op fala');
});

test('o no-op tem a mesma superfície do objeto ligado', () => {
  const desligada = initTelemetry({ endpoint: '', logger: { warn: () => {} } });
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const ligada = initTelemetry({ exporter });
  assert.deepEqual(Object.keys(desligada).sort(), Object.keys(ligada).sort());
  return ligada.shutdown();
});

test('shutdown do no-op resolve, e resolve de novo', async () => {
  const telemetry = initTelemetry({ endpoint: '', logger: { warn: () => {} } });
  await telemetry.shutdown();
  await telemetry.shutdown();
});

// ───────────────────────────────────────── 4. degradação

test('record* engole exceção do instrumento: telemetria não derruba handler', async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = initTelemetry({ exporter });
  // Valores que o SDK recusaria; nenhum pode escapar para o chamador.
  const absurdos = [NaN, Infinity, -1, -0, Number.MAX_VALUE];
  for (const v of absurdos) {
    telemetry.recordSessionEnd(v);
    telemetry.recordClientSession(v);
    telemetry.recordRoomClosed(v, v);
  }
  telemetry.recordJoin('admitted' as never);
  await telemetry.shutdown();
});

test('nenhum record* é async nem devolve promise — a ordem dos emit é contrato', async () => {
  // §7.12: um `await telemetry.recordX(...)` dentro de um handler de Socket.IO
  // mudaria a ordem observável de `join-approved` e `peer-joined`, que é
  // exatamente o que `signaling.test.ts` caracteriza. A garantia não pode
  // depender de quem escreve o call site lembrar disso.
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = initTelemetry({ exporter, snapshot: () => ({ rooms: 0, participants: 0 }) });
  const chamadas: unknown[] = [
    telemetry.recordJoin('admitted'),
    telemetry.recordSessionEnd(1000),
    telemetry.recordRoomClosed(1000, 2),
    telemetry.recordPageView('home'),
    telemetry.recordClientSession(1000),
    telemetry.recordBeacon('accepted'),
  ];
  for (const retorno of chamadas) {
    assert.equal(retorno, undefined, 'devolve void, e não promise');
  }
  await telemetry.shutdown();
});

test('shutdown resolve mesmo com exporter que rejeita, e não pendura o processo', async () => {
  const quebrado: PushMetricExporter = {
    export: (_metrics: ResourceMetrics, cb) => cb({ code: 1, error: new Error('collector fora') }),
    forceFlush: () => Promise.reject(new Error('flush falhou')),
    shutdown: () => Promise.reject(new Error('shutdown falhou')),
  };
  const telemetry = initTelemetry({ exporter: quebrado, intervalMs: 60_000 });
  telemetry.recordJoin('admitted');
  const inicio = Date.now();
  await telemetry.shutdown();
  assert.ok(Date.now() - inicio < 5000, 'não espera indefinidamente por um collector morto');
});

test('a falha de exportação avisa uma vez por janela, não uma vez por tentativa', () => {
  const avisos: string[] = [];
  let agora = 0;
  const falho: PushMetricExporter = {
    export: (_m: ResourceMetrics, cb) => cb({ code: 1, error: new Error('ECONNREFUSED') }),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  const envolvido = withThrottledWarning(falho, {
    warn: (m) => avisos.push(m),
    intervalMs: 1000,
    now: () => agora,
  });

  const vazio = { resource: {}, scopeMetrics: [] } as unknown as ResourceMetrics;
  for (let i = 0; i < 10; i += 1) envolvido.export(vazio, () => {});
  assert.equal(avisos.length, 1, 'dez falhas, um aviso');

  agora = 1500;
  envolvido.export(vazio, () => {});
  assert.equal(avisos.length, 2, 'virou a janela, avisa de novo');
  assert.match(avisos[1], /9 falha\(s\) omitida\(s\)/, 'diz quantas foram suprimidas');

  // O aviso não pode carregar credencial nem endereço do collector: log é o
  // lugar mais fácil de vazar `OTEL_EXPORTER_OTLP_HEADERS`.
  for (const aviso of avisos) {
    assert.doesNotMatch(aviso, /http:\/\/|https:\/\/|Bearer|Authorization/i);
  }
});

test('metricsUrl acrescenta o caminho do sinal uma vez só', () => {
  assert.equal(metricsUrl('http://alloy:4318'), 'http://alloy:4318/v1/metrics');
  assert.equal(metricsUrl('http://alloy:4318/'), 'http://alloy:4318/v1/metrics');
  assert.equal(metricsUrl('http://alloy:4318///'), 'http://alloy:4318/v1/metrics');
});

// ───────────────────────────────────────── 5. a rota, no servidor de verdade
//
// Um servidor **compartilhado** para os casos que não dependem de configuração,
// e um servidor próprio só para os três que dependem. A economia não é
// estética: os arquivos de teste rodam em paralelo, cada `startServer` custa
// ~2s de boot, e uma dezena deles no mesmo arquivo satura a máquina a ponto de
// os testes de temporização dos **outros** arquivos ficarem vermelhos.

let padrao: RunningServer;

before(async () => {
  padrao = await startServer();
});

after(() => padrao?.stop());

test('POST /telemetry: 204 no caminho feliz, com o Content-Type do sendBeacon', async () => {
  const res = await fetch(`${padrao.base}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ event: 'page_view', route: 'home' }),
  });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '', 'sem corpo');
});

test('a receita do DoD — curl -d sem header de Content-Type — responde 204', async () => {
  // Item 10 do DoD, verbatim. `curl -d` sem `-H` manda
  // `application/x-www-form-urlencoded`: com o parser default do Express o
  // corpo chegaria vazio e a receita do README nasceria respondendo 400.
  const res = await fetch(`${padrao.base}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '{"event":"page_view","route":"home"}',
  });
  assert.equal(res.status, 204);
});

test('POST /telemetry: 400 para corpo inválido, sem eco do que foi enviado', async () => {
  const invalidos = [
    '{"event":"page_view","route":"settings"}',
    '{"event":"desconhecido"}',
    '{"event":"client_session_end","durationMs":"5000"}',
    '{"event":"client_session_end","durationMs":-1}',
    '{"event":"client_session_end","durationMs":1e12}',
    '[]',
    'null',
    'texto solto que não é json',
    '',
  ];
  for (const body of invalidos) {
    const res = await fetch(`${padrao.base}/telemetry`, { method: 'POST', body });
    assert.equal(res.status, 400, `corpo: ${body}`);
    const texto = await res.text();
    assert.equal(texto, '{"error":"invalid-beacon"}');
    assert.doesNotMatch(texto, /settings|desconhecido|texto solto/, 'a resposta não ecoa o corpo');
  }
});

test('POST /telemetry: corpo acima de 1 kB responde 413', async () => {
  const res = await fetch(`${padrao.base}/telemetry`, {
    method: 'POST',
    body: JSON.stringify({ event: 'page_view', route: 'home', lixo: 'x'.repeat(2000) }),
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'payload-too-large' });
});

test('sem endpoint o servidor sobe, avisa uma vez e continua servindo tudo', async () => {
  const avisos = padrao
    .saida()
    .split('\n')
    .filter((l) => l.includes('OTEL_EXPORTER_OTLP_ENDPOINT'));
  assert.equal(avisos.length, 1, 'um aviso de boot, e só um');

  // O caminho desligado continua servindo: é o que prova que a telemetria é
  // aditiva, e não um requisito novo de deploy.
  assert.equal((await fetch(`${padrao.base}/health`)).status, 200);
  assert.deepEqual(await (await fetch(`${padrao.base}/health`)).json(), {
    ok: true,
    turn: { configured: false },
    telemetry: { enabled: false },
  });
  assert.equal((await fetch(`${padrao.base}/turn-credentials`)).status, 503);
  assert.deepEqual(await (await fetch(`${padrao.base}/rooms/x/occupancy`)).json(), {
    occupied: false,
  });
  assert.equal(
    (
      await fetch(`${padrao.base}/telemetry`, {
        method: 'POST',
        body: '{"event":"page_view","route":"home"}',
      })
    ).status,
    204,
    'o beacon continua respondendo 204 mesmo sem para onde exportar',
  );
});

test('nada do que foi enviado a /telemetry aparece no log do processo', async () => {
  // O handler de erro do body-parser é montado **na rota** justamente por isto:
  // a mensagem do `SyntaxError` inclui um trecho do corpo recebido, e sem
  // handler próprio ela iria para o stderr. É o caminho de erro — o que
  // ninguém olha.
  const marcador = 'CANARIO-DE-LOG-XYZ';
  await fetch(`${padrao.base}/telemetry`, { method: 'POST', body: `{lixo: ${marcador}}` });
  await fetch(`${padrao.base}/telemetry`, {
    method: 'POST',
    headers: { 'User-Agent': `Mozilla/5.0 ${marcador}` },
    body: JSON.stringify({ event: 'page_view', route: 'home', extra: marcador }),
  });
  await fetch(`${padrao.base}/telemetry`, {
    method: 'POST',
    body: JSON.stringify({ event: 'page_view', route: 'home', lixo: `${marcador}`.repeat(200) }),
  });

  // Um tique para o stderr do filho chegar até aqui.
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotMatch(padrao.saida(), /CANARIO-DE-LOG-XYZ/, 'nem corpo, nem User-Agent');
  assert.doesNotMatch(padrao.saida(), /127\.0\.0\.1|::1|::ffff:/, 'e nenhum IP');
});

test('POST /telemetry: acima do limite da janela responde 429 sem corpo', async (t) => {
  const server = await startServer({ env: { TELEMETRY_RATE_LIMIT_PER_MINUTE: '3' } });
  t.after(() => server.stop());

  const enviar = () =>
    fetch(`${server.base}/telemetry`, {
      method: 'POST',
      body: '{"event":"page_view","route":"home"}',
    });

  for (let i = 0; i < 3; i += 1) assert.equal((await enviar()).status, 204, `beacon ${i + 1}`);
  const barrado = await enviar();
  assert.equal(barrado.status, 429);
  assert.equal(await barrado.text(), '', '429 sem corpo');
});

test('/health com telemetria ligada reporta o booleano, nunca o endpoint nem os headers', async (t) => {
  const collector = await startFakeCollector();
  t.after(() => collector.close());
  const server = await startServer({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer SEGREDO-XYZ',
    },
  });
  t.after(() => server.stop());

  const corpo = await (await fetch(`${server.base}/health`)).text();
  assert.deepEqual(JSON.parse(corpo), {
    ok: true,
    turn: { configured: false },
    telemetry: { enabled: true },
  });
  assert.doesNotMatch(corpo, /SEGREDO-XYZ|127\.0\.0\.1|Bearer/, 'booleano puro, e só');
  assert.doesNotMatch(server.saida(), /SEGREDO-XYZ/, 'a credencial do collector não vai para log');
});

test('collector fora do ar não contamina o produto', async (t) => {
  // Porta fechada de propósito: o exporter vai falhar em toda janela.
  const server = await startServer({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      OTEL_METRIC_EXPORT_INTERVAL_MS: '200',
    },
  });
  t.after(() => server.stop());

  // Tempo para várias janelas de exportação falharem.
  await new Promise((r) => setTimeout(r, 1500));

  const inicio = Date.now();
  assert.equal((await fetch(`${server.base}/health`)).status, 200);
  assert.equal((await fetch(`${server.base}/turn-credentials`)).status, 503);
  assert.equal((await fetch(`${server.base}/rooms/x/occupancy`)).status, 200);
  assert.ok(Date.now() - inicio < 3000, 'as respostas continuam no mesmo tempo');

  const falhas = server
    .saida()
    .split('\n')
    .filter((l) => l.includes('falha ao exportar'));
  assert.ok(falhas.length <= 1, `no máximo um aviso por janela de backoff, houve ${falhas.length}`);
});
