/**
 * E2E da extensão **na sala**: um participante do app web ouve a música e o
 * efeito que saem do motor da extensão.
 *
 * Roteiro:
 *
 *   R1. Alice entra numa sala pelo app (primeira na sala, admitida sozinha).
 *   R2. A extensão conecta na **mesma** sala, pelo **mesmo** servidor de
 *       sinalização, e o pedido de entrada aparece para a Alice.
 *   R3. Alice aprova; o motor entra e o tile dele aparece no app.
 *   R4. Uma faixa tocando na extensão é **ouvida** pela Alice — medido por
 *       `totalAudioEnergy` do `inbound-rtp` de áudio, e sem nenhuma votação de
 *       player nem painel de música aberto.
 *   R5. Um efeito do soundboard disparado na extensão também chega.
 *
 * **Duas coisas do ambiente que este roteiro tem de resolver, e que não são
 * artifício de teste — são o mesmo problema de um deploy real:**
 *
 * 1. **CORS/origem.** A extensão fala de `chrome-extension://<id>`, que não está
 *    no `CLIENT_ORIGIN` de nenhum servidor. Aqui se usa o caminho documentado no
 *    README: subir o servidor com `chrome-extension://<id>` na lista (o
 *    `CLIENT_ORIGIN` aceita valores separados por vírgula). Por isso o servidor
 *    de sinalização só sobe **depois** do navegador: o id da extensão nasce com
 *    a instalação.
 * 2. **TURN.** O mesh roda com `iceTransportPolicy: 'relay'`: sem TURN não há
 *    conexão nenhuma. O app resolve isso com `context.route`, que **não alcança
 *    o documento offscreen** (medido: zero interceptações). Daí o proxy local:
 *    ele responde `/turn-credentials` com o TURN desta execução e encaminha todo
 *    o resto — inclusive o upgrade WebSocket do Socket.IO — para o servidor de
 *    verdade.
 *
 * Rodar: `npm run test:e2e:extension:room` na raiz.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

import {
  CLIENT_ORIGIN,
  ICE_SERVERS,
  INSTRUMENTATION,
  SIGNALING_PORT,
  approveAll,
  buildClient,
  buildServer,
  rmsBetween,
  setInputValue,
  sleep,
  startClientServer,
  startTurn,
  writeAudioFixture,
} from './harness.ts';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(AQUI, '..', 'extension');
const DIST = path.join(EXTENSION, 'dist');
const SALA = 'sala-da-extensao';

const results: { name: string; passed: boolean; detail: string }[] = [];
let failures = 0;

function check(name: string, passed: boolean, detail = ''): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

/**
 * O servidor de sinalização, subido **com o id da extensão na allowlist**.
 *
 * É a cópia local do `startSignaling` do harness, e não uma mudança nele: o
 * roteiro de 3 participantes não conhece extensão nenhuma, e acrescentar um
 * parâmetro lá para um consumidor só espalharia esta entrega por um arquivo que
 * ela não precisa tocar.
 */
function startSignalingCom(origens: string[]) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: path.join(AQUI, '..', 'server'),
    env: { ...process.env, PORT: String(SIGNALING_PORT), CLIENT_ORIGIN: origens.join(',') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[signaling] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[signaling:err] ${d}`));
  // SIGKILL: onde o SIGTERM não é entregue ao filho, o processo sobrevive à
  // suíte e a execução seguinte esbarra nele.
  return { stop: () => child.kill('SIGKILL') };
}

/**
 * O proxy que a extensão usa como "servidor de sinalização".
 *
 * `/turn-credentials` é respondido aqui (o servidor real devolveria 503 sem
 * `CF_TURN_*`, e o `context.route` do Playwright não alcança o offscreen).
 * Todo o resto — incluindo o upgrade WebSocket — é encaminhado.
 */
function startProxy(): Promise<{ origin: string; stop: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/turn-credentials')) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          iceServers: ICE_SERVERS,
          ttl: 3600,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      );
      return;
    }
    const upstream = http.request(
      { host: '127.0.0.1', port: SIGNALING_PORT, path: req.url, method: req.method, headers: req.headers },
      (resposta) => {
        res.writeHead(resposta.statusCode ?? 502, resposta.headers);
        resposta.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  // O upgrade do Socket.IO: dois sockets crus ligados um no outro.
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(SIGNALING_PORT, '127.0.0.1', () => {
      const linhas = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`);
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${linhas.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, stop: () => server.close() });
    });
  });
}

/** Serve o WAV da faixa **com CORS** — sem isso o motor recusa antes de tocar. */
function startAudioServer(arquivo: string): Promise<{ origin: string; stop: () => void }> {
  const corpo = fs.readFileSync(arquivo);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': String(corpo.length),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(corpo);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, stop: () => server.close() });
    });
  });
}

/**
 * A energia que chegou **pelo canal de música**, e não a soma de todo o áudio.
 * Mesma classificação por ordem de m-line do resto da suíte (mic, câmera, tela,
 * música): somar tudo mediria também o transceiver de microfone, que no motor
 * está vazio de propósito.
 */
async function musicChannelAudio(page: Page) {
  return page.evaluate(async () => {
    let energy = 0;
    let duration = 0;
    let bytes = 0;
    for (const pc of window.__wtkPeers || []) {
      if (pc.connectionState !== 'connected') continue;
      const music = pc.getTransceivers().filter((t) => t.currentDirection === 'recvonly')[3];
      if (!music?.receiver.track) continue;
      const stats = await pc.getStats(music.receiver.track);
      stats.forEach((report: Record<string, number | string>) => {
        if (report.type !== 'inbound-rtp' || report.kind !== 'audio') return;
        energy += Number(report.totalAudioEnergy) || 0;
        duration += Number(report.totalSamplesDuration) || 0;
        bytes += Number(report.bytesReceived) || 0;
      });
    }
    return { energy, duration, bytes };
  });
}

async function esperaMotor(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (document.getElementById('diag')?.dataset.engineId ?? '').startsWith('eng-'),
    null,
    { timeout: 20_000 },
  );
}

const turn = startTurn();
const client = startClientServer();
let signaling: { stop: () => void } | undefined;
let proxy: { origin: string; stop: () => void } | undefined;
let audio: { origin: string; stop: () => void } | undefined;
let context: BrowserContext | undefined;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtk-ext-room-'));

try {
  console.log('[extension-room] build…');
  await buildServer();
  await buildClient();
  execFileSync('node', ['build.ts'], { cwd: EXTENSION, stdio: 'inherit' });
  // O WAV precisa existir no `dist/` do client (é de lá que o harness serve),
  // mas quem o entrega à extensão é o servidor com CORS aberto abaixo.
  const wavUrl = writeAudioFixture('faixa-extensao.wav', { seconds: 20, freq: 440 });
  audio = await startAudioServer(path.join(AQUI, '..', 'client', 'dist', 'faixa-extensao.wav'));
  void wavUrl;

  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    permissions: ['camera', 'microphone'],
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(sw.url()).host;

  // O servidor só sobe agora: o id da extensão nasce com a instalação, e é ele
  // que entra na allowlist de origens (o caminho que o README documenta).
  signaling = startSignalingCom([CLIENT_ORIGIN, `chrome-extension://${extensionId}`]);
  proxy = await startProxy();
  await sleep(2_000);

  // ------------------------------------------------------------------- R1
  await context.addInitScript({ content: INSTRUMENTATION });
  await context.route('**/turn-credentials', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        iceServers: ICE_SERVERS,
        ttl: 3600,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }),
  );

  const alice = await context.newPage();
  await alice.goto(`${CLIENT_ORIGIN}/${SALA}`);
  const campoNome = alice.getByPlaceholder('Como te chamam');
  await campoNome.waitFor({ timeout: 20_000 });
  await setInputValue(campoNome, 'Alice');
  await alice.getByRole('button', { name: 'Entrar na sala' }).click();
  const entrou = await alice
    .waitForSelector('.controls', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check('R1. Alice entra na sala pelo app', entrou);

  // ------------------------------------------------------------------- R2
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/manager.html`);
  await manager.fill('#signaling', proxy.origin);
  await manager.fill('#display-name', 'Música (extensão)');
  await manager.click('[data-testid=save]');
  await sleep(500);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await esperaMotor(popup);
  await popup.fill('#room', SALA);
  await popup.fill('#name', 'Música (extensão)');
  await popup.click('[data-testid=connect]');

  const pedido = await alice
    .waitForSelector('text=Música (extensão)', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check('R2. o pedido de entrada do motor aparece para a Alice', pedido);

  // ------------------------------------------------------------------- R3
  await approveAll(alice);
  const conectou = await popup
    .waitForFunction(() => document.getElementById('status')?.dataset.status === 'connected', null, {
      timeout: 30_000,
    })
    .then(() => true)
    .catch(() => false);
  check('R3. o motor entra na sala depois da aprovação humana', conectou);

  // ------------------------------------------------------------------- R4
  await manager.fill('#url-input', `${audio.origin}/faixa.wav`);
  await manager.click('[data-testid=url-add]');
  const tocando = await popup
    .waitForFunction(() => document.getElementById('diag')?.dataset.queueLength === '1', null, {
      timeout: 30_000,
    })
    .then(() => true)
    .catch(() => false);
  check('R4a. a faixa entra na fila do motor', tocando);

  // Duas medidas espaçadas: o que importa é a energia **desta janela**, não o
  // acumulado desde o começo da chamada.
  await sleep(4_000);
  const antes = await musicChannelAudio(alice);
  await sleep(6_000);
  const depois = await musicChannelAudio(alice);
  const rms = rmsBetween(antes, depois);
  const bytes = depois.bytes - antes.bytes;
  const estadoMotor = await popup.evaluate(() => ({ ...(document.getElementById('diag')?.dataset ?? {}) }));
  console.log('[extension-room] estado do motor:', JSON.stringify(estadoMotor));
  check(
    'R4b. Alice ouve a faixa da extensão (sem votação e sem painel aberto)',
    (rms ?? 0) > 0.001 && bytes > 0,
    `rms=${rms?.toFixed(4) ?? 'null'} bytes=${bytes}`,
  );

  // ------------------------------------------------------------------- R5
  await popup.click('[data-testid=pause]');
  await sleep(1_500);
  await popup.fill('#fav-input', `${audio.origin}/efeito.wav`);
  await popup.click('[data-testid=fav-add]');
  await popup.waitForFunction(() => document.getElementById('diag')?.dataset.favorites === '1', null, {
    timeout: 10_000,
  });
  const antesDoEfeito = await musicChannelAudio(alice);
  await popup.locator('.efeito').first().click();
  const disparou = await popup
    .waitForFunction(() => document.getElementById('diag')?.dataset.playCount === '1', null, {
      timeout: 20_000,
    })
    .then(() => true)
    .catch(() => false);
  await sleep(4_000);
  const depoisDoEfeito = await musicChannelAudio(alice);
  const rmsEfeito = rmsBetween(antesDoEfeito, depoisDoEfeito);
  check('R5a. o efeito dispara no motor', disparou);
  check(
    'R5b. Alice ouve o efeito do soundboard da extensão',
    (rmsEfeito ?? 0) > 0.001,
    `rms=${rmsEfeito?.toFixed(4) ?? 'null'}`,
  );
} catch (err) {
  check('execução do roteiro', false, err instanceof Error ? err.message : String(err));
} finally {
  await context?.close();
  audio?.stop();
  proxy?.stop();
  signaling?.stop();
  client.stop();
  turn.stop();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checagens passaram`);
process.exit(failures === 0 ? 0 : 1);
