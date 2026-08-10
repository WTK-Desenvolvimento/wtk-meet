/**
 * Infra compartilhada pelos testes E2E: TURN local, servidor de sinalização,
 * servidor estático do client buildado e abertura de participantes.
 *
 * Por que TURN local: o client usa `iceTransportPolicy: 'relay'`, então sem um
 * TURN acessível nenhum candidato é gerado e nenhuma conexão fecha — nem em
 * loopback. O teste sobe um TURN em 127.0.0.1 e injeta esse ICE server na
 * página via interceptação de rede (`page.route`), sem tocar no código de
 * produção.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const Turn = require('node-turn');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'client', 'dist');

// Portas sorteadas por execução: uma rodada anterior que não limpou não
// derruba a próxima com EADDRINUSE.
const portBase = 20000 + Math.floor(Math.random() * 20000);
export const TURN_PORT = portBase;
export const SIGNALING_PORT = portBase + 1;
export const CLIENT_PORT = portBase + 2;
export const CLIENT_ORIGIN = `http://localhost:${CLIENT_PORT}`;

const TURN_USER = 'e2e';
const TURN_PASS = 'e2e-secret';

export const ICE_SERVERS = [
  {
    urls: [`turn:127.0.0.1:${TURN_PORT}?transport=udp`],
    username: TURN_USER,
    credential: TURN_PASS,
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export function startTurn() {
  const server = new Turn({
    listeningIps: ['127.0.0.1'],
    listeningPort: TURN_PORT,
    authMech: 'long-term',
    credentials: { [TURN_USER]: TURN_PASS },
    debugLevel: 'ERROR',
  });
  server.start();
  return { stop: () => server.stop() };
}

/**
 * Builda o client apontando para a porta sorteada desta execução. O
 * `SIGNALING_URL` é resolvido em tempo de build (`import.meta.env`), então não
 * dá para trocá-lo em runtime.
 */
export function buildClient() {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: path.join(ROOT, 'client'),
      env: { ...process.env, VITE_SIGNALING_URL: `http://localhost:${SIGNALING_PORT}` },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build falhou (${code})`))));
  });
}

export function startSignaling() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(SIGNALING_PORT),
      CLIENT_ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[signaling] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[signaling:err] ${d}`));
  return {
    stop: () => child.kill('SIGTERM'),
    ready: waitForHttp(`http://localhost:${SIGNALING_PORT}/health`),
  };
}

/** SPA estático: qualquer rota desconhecida cai no index.html. */
export function startClientServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, CLIENT_ORIGIN);
    let filePath = path.join(DIST, url.pathname);
    if (!filePath.startsWith(DIST) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  server.listen(CLIENT_PORT);
  return { stop: () => server.close() };
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ainda subindo
    }
    await sleep(200);
  }
  throw new Error(`timeout esperando ${url}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    // O binário completo (headless "novo"), não o chrome-headless-shell: o
    // shell não implementa getDisplayMedia.
    channel: 'chromium',
    args: [
      // Câmera e microfone falsos: o vídeo é um padrão animado e o áudio é um
      // tom contínuo — que é justamente o que aciona o indicador de fala.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      // getDisplayMedia sem diálogo: captura a primeira aba automaticamente.
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
      '--allow-running-insecure-content',
      '--disable-web-security',
    ],
  });
}

/**
 * Abre um participante: contexto isolado (storage próprio, como uma janela
 * anônima separada), ICE apontando para o TURN local, e nome já preenchido.
 */
export async function openParticipant(browser, { roomUrl, name }) {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: true,
  });

  await context.route('**/turn-credentials', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ iceServers: ICE_SERVERS }),
    }),
  );

  await context.addInitScript({ content: INSTRUMENTATION });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(roomUrl);
  const nameField = page.getByPlaceholder('Como te chamam');
  await nameField.waitFor();
  await setInputValue(nameField, name);
  await page.getByRole('button', { name: 'Entrar na sala' }).click();

  return { context, page, name, consoleErrors };
}

/**
 * Preenche um input controlado do React.
 *
 * Não usamos `fill()`/`pressSequentially()` porque neste ambiente headless a
 * injeção de eventos de teclado via CDP não chega ao renderer. O caminho abaixo
 * é o padrão para inputs controlados: escreve pelo setter nativo (para o value
 * tracker do React perceber a mudança) e dispara um evento `input` que borbulha
 * até o listener de raiz do React.
 */
export async function setInputValue(locator, value) {
  await locator.evaluate((input, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** Aprova todos os pedidos de entrada pendentes na página. */
export async function approveAll(page) {
  const buttons = page.getByRole('button', { name: 'Aprovar' });
  for (let i = await buttons.count(); i > 0; i = await buttons.count()) {
    await buttons.first().click();
    await sleep(150);
  }
}

/** Estado interno das RTCPeerConnections, lido do próprio processo da página. */
export async function peerStats(page) {
  return page.evaluate(async () => {
    const pcs = window.__wtkPeers || [];
    const out = [];
    for (const pc of pcs) {
      // Conexões já fechadas (peer que saiu / recarregou) continuam no array
      // de instrumentação, mas não fazem parte do mesh atual.
      if (pc.connectionState === 'closed') continue;
      out.push({
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        senders: pc.getSenders().map((s) => ({ kind: s.track?.kind ?? null, id: s.track?.id ?? null })),
        transceivers: pc.getTransceivers().map((t) => ({
          mid: t.mid,
          kind: t.receiver.track?.kind,
          direction: t.direction,
          currentDirection: t.currentDirection,
        })),
      });
    }
    return out;
  });
}

/**
 * Instrumenta a página para expor as RTCPeerConnections e contar chamadas de
 * getUserMedia / negociações de SDP. Precisa rodar antes de qualquer script da
 * app, por isso é `addInitScript`.
 */
export const INSTRUMENTATION = `
  window.__wtkPeers = [];
  window.__wtkCounters = {
    getUserMedia: 0, getDisplayMedia: 0, setLocalDescription: 0, setRemoteDescription: 0,
    raf: 0, oscillators: 0,
  };
  window.__wtkLiveTracks = new Set();

  // AudioContext: quantos foram criados (deve ser exatamente 1 por sala),
  // quantos osciladores tocaram (um por bipe) e em que estado terminaram.
  window.__wtkAudioContexts = [];
  const OrigAC = window.AudioContext;
  // Exposto para o teste medir o áudio com um analisador próprio sem poluir a
  // contagem de AudioContexts da aplicação.
  window.__wtkOrigAudioContext = OrigAC;
  window.AudioContext = function (...args) {
    const ctx = new OrigAC(...args);
    window.__wtkAudioContexts.push(ctx);
    const createOscillator = ctx.createOscillator.bind(ctx);
    ctx.createOscillator = () => { window.__wtkCounters.oscillators++; return createOscillator(); };
    return ctx;
  };
  window.AudioContext.prototype = OrigAC.prototype;

  // requestAnimationFrame: a contagem por segundo diz se há UM loop para todos
  // os tiles (~60/s) ou um por tile (~60 × N).
  const origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__wtkCounters.raf++; return origRAF(cb); };

  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new OrigPC(...args);
    window.__wtkPeers.push(pc);
    const sld = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = (...a) => { window.__wtkCounters.setLocalDescription++; return sld(...a); };
    const srd = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = (...a) => { window.__wtkCounters.setRemoteDescription++; return srd(...a); };
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;

  function trackStream(stream) {
    for (const t of stream.getTracks()) {
      window.__wtkLiveTracks.add(t);
    }
    return stream;
  }

  const md = navigator.mediaDevices;
  const origGUM = md.getUserMedia.bind(md);
  md.getUserMedia = async (...a) => { window.__wtkCounters.getUserMedia++; return trackStream(await origGUM(...a)); };
  const origGDM = md.getDisplayMedia?.bind(md);
  if (origGDM) {
    md.getDisplayMedia = async (...a) => { window.__wtkCounters.getDisplayMedia++; return trackStream(await origGDM(...a)); };
  }

  window.__wtkTrackStates = () => [...window.__wtkLiveTracks].map((t) => ({
    kind: t.kind, label: t.label, readyState: t.readyState, enabled: t.enabled,
  }));

  // Captura TUDO que sai e entra pelo transporte do Socket.IO (WebSocket e o
  // polling que precede o upgrade). É a evidência direta de que o conteúdo do
  // chat nunca chega ao servidor de sinalização.
  window.__wtkWire = [];
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    const send = ws.send.bind(ws);
    ws.send = (data) => { window.__wtkWire.push({ dir: 'out', url: String(url), data: String(data) }); return send(data); };
    ws.addEventListener('message', (e) => {
      window.__wtkWire.push({ dir: 'in', url: String(url), data: String(e.data) });
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = OrigWS[k];

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    let reqUrl = '';
    const open = xhr.open.bind(xhr);
    xhr.open = (method, url, ...rest) => { reqUrl = String(url); return open(method, url, ...rest); };
    const send = xhr.send.bind(xhr);
    xhr.send = (body) => {
      if (body != null) window.__wtkWire.push({ dir: 'out', url: reqUrl, data: String(body) });
      xhr.addEventListener('load', () => {
        try { window.__wtkWire.push({ dir: 'in', url: reqUrl, data: String(xhr.responseText) }); } catch {}
      });
      return send(body);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;
`;
