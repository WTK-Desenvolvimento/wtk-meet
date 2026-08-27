/**
 * O teste que sustenta a promessa — e é a única coisa que a sustenta.
 *
 * O wtk-meet vende privacidade como recurso, não como conformidade:
 * `ARCHITECTURE.md` §5 mantém uma tabela literal do que o servidor sabe e do
 * que ele **nunca** sabe. Uma camada de telemetria é, por definição, um cano
 * novo saindo do processo, e a diferença entre "métrica agregada" e "vigilância
 * discreta" está em detalhes que não aparecem em code review distraído: um
 * label `room` aqui, um `sessionId` ali, um `X-Forwarded-For` gravado em log
 * acolá.
 *
 * Por isso a asserção é feita sobre os **bytes que saem para o collector**, e
 * não sobre uma estrutura montada pelo teste: o fluxo inteiro do produto é
 * exercitado com valores reconhecíveis — um endereço de sala secreto, um nome
 * próprio, uma passphrase — e depois se procura cada uma dessas strings no
 * corpo cru do `POST /v1/metrics`. Se um `roomId` vazasse por um caminho que
 * ninguém imaginou (atributo de resource, descrição de instrumento, nome de
 * escopo), ele estaria lá.
 *
 * O segundo teste é o irmão operacional do primeiro: 50 salas distintas
 * produzem **as mesmas séries** que uma sala. Cardinalidade constante significa
 * que o custo de armazenamento do Prometheus não depende do uso do produto — e
 * é a mesma propriedade, vista pelo outro lado.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { io } from 'socket.io-client';

import { startFakeCollector, startServer } from './fixtures/telemetryHarness.js';

import type { Socket } from 'socket.io-client';
import type { FlatSeries, RunningServer } from './fixtures/telemetryHarness.js';

/** Os valores que **não** podem aparecer em lugar nenhum do que sai do processo. */
const SALA = 'sala-secreta-do-nicolas';
const NOME = 'Nicolas Woitchik';
const PASSPHRASE = 'entrada-guitarra-vermelha';

const abertos: Socket[] = [];

function conectar(server: RunningServer): Socket {
  const socket = io(server.base, { transports: ['websocket'], forceNew: true });
  abertos.push(socket);
  return socket;
}

function esperar(socket: Socket, evento: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${evento} não chegou em ${timeoutMs}ms`)), timeoutMs);
    socket.once(evento, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Entra numa sala vazia: sem fila de aprovação, a primeira pessoa **é** a sala. */
async function entrarPrimeiro(server: RunningServer, roomId: string, displayName: string) {
  const socket = conectar(server);
  const aprovado = esperar(socket, 'join-approved');
  socket.emit('join-request', { roomId, displayName });
  await aprovado;
  return socket;
}

function fechar(socket: Socket) {
  socket.removeAllListeners();
  socket.disconnect();
}

test.after(() => {
  for (const socket of abertos) fechar(socket);
});

/** Uma chave estável de série: nome + atributos, que é o que o Prometheus indexa. */
function chaveDeSerie(s: FlatSeries): string {
  const attrs = Object.entries(s.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return attrs ? `${s.name}{${attrs}}` : s.name;
}

test('o fluxo completo não vaza sala, nome nem passphrase para o collector', async (t) => {
  const collector = await startFakeCollector();
  t.after(() => collector.close());
  const server = await startServer({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      OTEL_METRIC_EXPORT_INTERVAL_MS: '250',
      OTEL_SERVICE_NAME: 'wtk-meet-server',
    },
  });
  t.after(() => server.stop());

  // 1. Primeira pessoa entra: desfecho `admitted`.
  const dono = await entrarPrimeiro(server, SALA, NOME);

  // 2. Alguém pede entrada e é **aprovado**.
  const convidado = conectar(server);
  const pedidoVisto = esperar(dono, 'join-request');
  convidado.emit('join-request', { roomId: SALA, displayName: 'Convidada' });
  const pedido = (await pedidoVisto) as { requesterId: string };
  const aprovado = esperar(convidado, 'join-approved');
  dono.emit('approve-join', { requesterId: pedido.requesterId });
  await aprovado;

  // 3. Alguém pede entrada e é **recusado**.
  const recusado = conectar(server);
  const pedidoRecusa = esperar(dono, 'join-request');
  recusado.emit('join-request', { roomId: SALA, displayName: 'Indesejada' });
  const pedido2 = (await pedidoRecusa) as { requesterId: string };
  const negado = esperar(recusado, 'join-denied');
  dono.emit('deny-join', { requesterId: pedido2.requesterId });
  await negado;

  // 4. Sala inválida.
  const invalido = conectar(server);
  const negadoInvalido = esperar(invalido, 'join-denied');
  invalido.emit('join-request', { roomId: '', displayName: NOME });
  await negadoInvalido;

  // 5. Sala cheia: MAX_PARTICIPANTS é 6, e já há 2 dentro.
  const cheia = 'sala-cheia-do-nicolas';
  const lotacao: Socket[] = [await entrarPrimeiro(server, cheia, NOME)];
  for (let i = 1; i < 6; i += 1) {
    const s = conectar(server);
    const visto = esperar(lotacao[0], 'join-request');
    s.emit('join-request', { roomId: cheia, displayName: `P${i}` });
    const p = (await visto) as { requesterId: string };
    const ok = esperar(s, 'join-approved');
    lotacao[0].emit('approve-join', { requesterId: p.requesterId });
    await ok;
    lotacao.push(s);
  }
  const sobrando = conectar(server);
  const negadoCheio = esperar(sobrando, 'join-denied');
  sobrando.emit('join-request', { roomId: cheia, displayName: NOME });
  assert.deepEqual(await negadoCheio, { reason: 'room-full' }, 'sala cheia continua recusando');

  // 6. Beacons do client, incluindo um com campos que **não** deveriam existir.
  await fetch(`${server.base}/telemetry`, {
    method: 'POST',
    body: JSON.stringify({ event: 'page_view', route: 'room' }),
  });
  const contrabando = await fetch(`${server.base}/telemetry`, {
    method: 'POST',
    body: JSON.stringify({
      event: 'page_view',
      route: 'home',
      roomId: SALA,
      displayName: NOME,
      passphrase: PASSPHRASE,
      ip: '203.0.113.7',
    }),
  });
  assert.equal(contrabando.status, 204, 'campos extras não invalidam o beacon; eles somem');
  await fetch(`${server.base}/telemetry`, {
    method: 'POST',
    body: JSON.stringify({ event: 'client_session_end', durationMs: 42_000 }),
  });

  // 7. Todo mundo sai — inclusive por desconexão abrupta, que é o caminho real.
  for (const s of [dono, convidado, ...lotacao]) fechar(s);

  await collector.waitForExports(2);
  const bruto = collector.bodies().join('\n');

  // A asserção central: nenhuma das strings reconhecíveis existe nos bytes que
  // saíram para a stack de monitoramento.
  for (const segredo of [SALA, NOME, PASSPHRASE, 'sala-cheia-do-nicolas', '203.0.113.7', 'Convidada', 'Indesejada']) {
    assert.ok(!bruto.includes(segredo), `"${segredo}" vazou para o collector`);
  }
  // Nem em pedaços: `nicolas` minúsculo pegaria um hash hex por acidente? Não —
  // mas pega qualquer tentativa futura de derivar um label a partir do nome.
  assert.doesNotMatch(bruto, /nicolas|secreta|guitarra/i);
  // E nada de identificador de socket, que é o que o servidor tem em mãos.
  for (const s of [dono, convidado]) {
    if (s.id) assert.ok(!bruto.includes(s.id), 'o socketId não vira atributo');
  }

  // O resource é explícito e mínimo: sem `detectResources`, não há `host.name`
  // nem `process.command_args` levando hostname e caminho do filesystem do
  // operador para dentro da stack.
  assert.doesNotMatch(bruto, /host\.name|process\.pid|process\.command|process\.executable/);

  const series = collector.series();
  assert.ok(series.length > 0, 'houve exportação de verdade');
  const chaves = new Set(series.map(chaveDeSerie));
  // O conjunto inteiro de séries do sistema, escrito à mão: qualquer coisa nova
  // que apareça aqui é uma dimensão que ninguém aprovou.
  const permitidas = new Set([
    'wtk_rooms_active',
    'wtk_participants_active',
    'wtk_room_occupancy',
    'wtk_session_duration_seconds',
    'wtk_room_lifetime_seconds',
    'wtk_client_session_duration_seconds',
    'wtk_joins_total{outcome=admitted}',
    'wtk_joins_total{outcome=approved}',
    'wtk_joins_total{outcome=denied}',
    'wtk_joins_total{outcome=room_full}',
    'wtk_joins_total{outcome=invalid_room}',
    'wtk_page_views_total{route=home}',
    'wtk_page_views_total{route=room}',
    'wtk_page_views_total{route=legacy}',
    'wtk_telemetry_beacons_total{outcome=accepted}',
    'wtk_telemetry_beacons_total{outcome=rejected}',
  ]);
  for (const chave of chaves) {
    assert.ok(permitidas.has(chave), `série não prevista: ${chave}`);
  }

  // Os cinco desfechos de entrada foram exercitados de verdade.
  for (const outcome of ['admitted', 'approved', 'denied', 'room_full', 'invalid_room']) {
    assert.ok(chaves.has(`wtk_joins_total{outcome=${outcome}}`), `faltou outcome=${outcome}`);
  }

  // E o log do processo não carrega nada disso: o handler de erro da rota
  // existe justamente porque a mensagem do body-parser inclui trecho do corpo.
  const saida = server.saida();
  for (const segredo of [SALA, NOME, PASSPHRASE, '203.0.113.7']) {
    assert.ok(!saida.includes(segredo), `"${segredo}" apareceu no log do servidor`);
  }
});

test('50 salas distintas produzem exatamente as mesmas séries que uma', async (t) => {
  const collector = await startFakeCollector();
  t.after(() => collector.close());
  const server = await startServer({
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      OTEL_METRIC_EXPORT_INTERVAL_MS: '250',
    },
  });
  t.after(() => server.stop());

  const sockets: Socket[] = [];
  for (let i = 0; i < 50; i += 1) {
    sockets.push(await entrarPrimeiro(server, `sala-numero-${i}`, `Pessoa ${i}`));
  }
  await collector.waitForExports(1);
  const primeiraColeta = new Set(collector.series().map(chaveDeSerie));

  for (const s of sockets) fechar(s);
  const jaVistas = collector.bodies().length;
  await collector.waitForExports(jaVistas + 2);
  const segundaColeta = new Set(collector.series().map(chaveDeSerie));

  // O conjunto não cresceu com o uso: 50 salas, as mesmas séries.
  assert.deepEqual(
    [...segundaColeta].sort(),
    [...new Set([...primeiraColeta, ...segundaColeta])].sort(),
    'a segunda coleta não introduziu série nova além das já previstas',
  );
  assert.ok(segundaColeta.size <= 16, `cardinalidade total ${segundaColeta.size}, teto do catálogo é 16`);

  const bruto = collector.bodies().join('\n');
  assert.doesNotMatch(bruto, /sala-numero-\d+/, 'nenhum nome de sala atravessa');
  assert.doesNotMatch(bruto, /Pessoa \d+/, 'nenhum displayName atravessa');

  // A prova positiva de que houve movimento de verdade: 50 salas nasceram e
  // morreram, e o histograma de tempo de vida tem 50 amostras.
  const lifetime = collector
    .series()
    .filter((s) => s.name === 'wtk_room_lifetime_seconds')
    .at(-1);
  assert.equal(Number(lifetime?.point.count), 50, '50 salas fecharam');

  const ocupacao = collector
    .series()
    .filter((s) => s.name === 'wtk_room_occupancy')
    .at(-1);
  assert.equal(Number(ocupacao?.point.count), 50, '50 amostras de pico de ocupação');
  // Todas com pico 1: o bucket `le=1` leva as 50, e o `+Inf` fica vazio.
  assert.equal(Number(ocupacao?.point.bucketCounts?.at(-1)), 0, 'o +Inf continua vazio');
});
