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
import { chromium, type Browser, type ConsoleMessage, type Locator, type Page, type Route } from 'playwright';

/** Acumulado de `getStats` num instante. Duas amostras dão o RMS da janela. */
export interface AudioSnapshot {
  energy: number;
  duration: number;
  bytes: number;
}

/** Como o `/turn-credentials` responde **para um participante**. */
export interface TurnScenario {
  status?: number;
  ttl?: number;
  /** A primeira resposta traz senha que o TURN recusa; a renovação traz a boa. */
  expiredFirstCredential?: boolean;
}

export interface OpenParticipantOptions {
  roomUrl: string;
  name: string;
  preferences?: Record<string, unknown>;
  audioPreferences?: Record<string, unknown>;
  cameraOn?: boolean;
  forceWorkletNoiseSuppression?: boolean;
  turn?: TurnScenario;
}

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

const MIME: Record<string, string | undefined> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.wav': 'audio/wav',
};

/**
 * Escreve um WAV sintético dentro do `dist` já buildado e devolve a URL dele.
 *
 * É a fonte de áudio do roteiro de música: um tom contínuo, servido pelo mesmo
 * host da aplicação. Same-origin de propósito — assim a sonda de CORS do
 * `musicEngine` passa e a faixa entra em modo `stream` (retransmitida por quem
 * adicionou), que é justamente o caminho que o teste precisa exercitar.
 */
export function writeAudioFixture(
  name: string,
  { seconds = 30, freq = 440, rate = 8000 }: { seconds?: number; freq?: number; rate?: number } = {},
): string {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2);
  }
  fs.writeFileSync(path.join(DIST, name), buffer);
  return `${CLIENT_ORIGIN}/${name}`;
}

/**
 * Escreve um WAV de **ruído branco** no caminho dado e o devolve.
 *
 * É a fonte do microfone falso na medição de supressão: o tom contínuo padrão do
 * Chromium não serve, porque um tom em nível de fala é exatamente o que uma
 * porta espectral deve **deixar passar** — medir supressão com ele daria zero dB
 * mesmo com o motor funcionando perfeitamente.
 *
 * Ruído determinístico (gerador com semente): duas execuções comparam o mesmo
 * sinal, e um resultado que oscila passa a significar problema de verdade.
 */
export function writeNoiseFixture(
  filePath: string,
  { seconds = 20, rate = 48000, amplitude = 0.15 }: { seconds?: number; rate?: number; amplitude?: number } = {},
): string {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  let seed = 987654321;
  for (let i = 0; i < samples; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const value = ((seed / 0x7fffffff) * 2 - 1) * amplitude;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Energia e bytes do áudio **recebido** deste participante, somados sobre todas
 * as conexões.
 *
 * `totalAudioEnergy` / `totalSamplesDuration` vêm do `getStats` e são medidos
 * sobre as amostras já decodificadas — é a definição operacional de "RMS no peer
 * receptor", e não depende de nenhum `AudioContext` extra (o Chromium headless
 * não entrega o áudio de uma track a um segundo contexto, ver o fim do
 * `claude-progress.md`).
 */
export async function inboundAudio(page: Page): Promise<AudioSnapshot> {
  return page.evaluate(async () => {
    let energy = 0;
    let duration = 0;
    let bytes = 0;
    for (const pc of window.__wtkPeers || []) {
      if (pc.connectionState === 'closed') continue;
      const report = await pc.getStats();
      report.forEach((stat: Record<string, number | string>) => {
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') return;
        energy += Number(stat.totalAudioEnergy) || 0;
        duration += Number(stat.totalSamplesDuration) || 0;
        bytes += Number(stat.bytesReceived) || 0;
      });
    }
    return { energy, duration, bytes };
  });
}

/**
 * RMS do áudio recebido entre dois instantâneos de `inboundAudio`. A janela é
 * explícita de propósito: comparar acumulados de janelas diferentes mediria
 * duração, não nível.
 */
export function rmsBetween(before: AudioSnapshot, after: AudioSnapshot): number | null {
  const energy = after.energy - before.energy;
  const duration = after.duration - before.duration;
  if (!(duration > 0) || !(energy >= 0)) return null;
  return Math.sqrt(energy / duration);
}

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
export function buildClient(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: path.join(ROOT, 'client'),
      env: { ...process.env, VITE_SIGNALING_URL: `http://localhost:${SIGNALING_PORT}` },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build falhou (${code})`))));
  });
}

/**
 * Compila o server. Espelha o `buildClient`, e existe porque o server passou a
 * ter passo de compilação: o E2E sobe `dist/index.js`, que é exatamente o
 * artefato que o container roda.
 */
export function buildServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: path.join(ROOT, 'server'),
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`build do server falhou (${code})`)),
    );
  });
}

export function startSignaling() {
  const child = spawn(process.execPath, ['dist/index.js'], {
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
    // SIGKILL pelo mesmo motivo do teardown de `client/test/joinRequestSignaling`:
    // onde o SIGTERM não é entregue ao filho, o processo de sinalização sobrevive
    // à suíte e a próxima execução esbarra nele.
    stop: () => child.kill('SIGKILL'),
    ready: waitForHttp(`http://localhost:${SIGNALING_PORT}/health`),
  };
}

/** SPA estático: qualquer rota desconhecida cai no index.html. */
export function startClientServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', CLIENT_ORIGIN);
    let filePath = path.join(DIST, url.pathname);
    if (!filePath.startsWith(DIST) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  server.listen(CLIENT_PORT);
  return { stop: () => server.close() };
}

async function waitForHttp(url: string, timeoutMs = 15000): Promise<boolean> {
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

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function launchBrowser({ audioFile = null }: { audioFile?: string | null } = {}) {
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
      // Troca o tom contínuo por um arquivo (WAV 16-bit PCM, em laço). É o que
      // permite medir supressão de ruído com um sinal conhecido: o tom padrão é
      // justamente o que uma porta espectral **não** deve atenuar.
      ...(audioFile ? [`--use-file-for-fake-audio-capture=${audioFile}`] : []),
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
export async function openParticipant(
  browser: Browser,
  {
    roomUrl,
    name,
    preferences,
    audioPreferences,
    // Como esta aba passa pela **tela de pré-entrada**.
    //
    // O default é `false` de propósito: entrar com a câmera desligada é o
    // padrão de fábrica do produto e o caminho que 100% de quem abre um link
    // percorre. Fazer o harness entrar sempre ligado para "não mexer no
    // roteiro" deixaria justamente esse caminho sem cobertura nenhuma.
    //
    // Quando um cenário precisa de vídeo, ligar aqui é pela UI do lobby, e não
    // por `preferences` semeada: é a única forma de o roteiro exercitar o
    // toggle — que grava a preferência no clique, não no submit.
    cameraOn = false,
    forceWorkletNoiseSuppression = false,
    // Como o servidor de TURN responde **para este participante**. O default
    // reproduz o comportamento de sempre (200 com o TURN local e validade
    // folgada), então nenhuma chamada existente muda de comportamento.
    //
    // `status: 503` encena o deploy sem `CF_TURN_*`; `ttl` curto encena a
    // credencial que vence com a aba aberta, que é o mecanismo que esta suíte
    // nunca conseguiu exercitar antes.
    //
    // `expiredFirstCredential` é o que fecha a reprodução. O TURN local tem
    // credencial estática e não expira nada, então "vencer" precisa ser
    // encenado ao contrário: a **primeira** resposta traz uma senha que o TURN
    // recusa, e a renovação traz a boa. Uma aba que não renova fica presa na
    // senha recusada — que é, ponto a ponto, o defeito investigado.
    turn = {},
  }: OpenParticipantOptions,
) {
  const { status: turnStatus = 200, ttl: turnTtl = 3600, expiredFirstCredential = false } = turn;
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: true,
  });

  // Semeia a preferência de dispositivos **antes** de qualquer script da app: é
  // o que permite exercitar "a preferência salva aponta para hardware que não
  // existe mais" sem depender de uma sessão anterior.
  if (preferences) {
    await context.addInitScript({
      content: `localStorage.setItem('wtk-meet:devices', ${JSON.stringify(
        JSON.stringify(preferences),
      )});`,
    });
  }

  // Chave separada da de dispositivos (`lib/noiseSuppression.js`).
  if (audioPreferences) {
    await context.addInitScript({
      content: `localStorage.setItem('wtk-meet:audio', ${JSON.stringify(
        JSON.stringify(audioPreferences),
      )});`,
    });
  }

  // Precede a INSTRUMENTATION só por clareza — o wrapper lê a flag na hora da
  // chamada, então a ordem não importa; o que importa é estar posta antes de
  // qualquer script da app.
  if (forceWorkletNoiseSuppression) {
    await context.addInitScript({ content: 'window.__wtkForceWorkletNs = true;' });
  }

  // Um item por requisição a /turn-credentials, com o instante. É o que permite
  // afirmar que a credencial foi renovada **antes** de uma conexão nova nascer,
  // e não só que ela foi renovada em algum momento.
  const turnRequests: number[] = [];
  await context.route('**/turn-credentials', (route: Route) => {
    turnRequests.push(Date.now());
    if (turnStatus !== 200) {
      return route.fulfill({
        status: turnStatus,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'turn-unconfigured', message: 'sem TURN neste deploy' }),
      });
    }
    const vencida = expiredFirstCredential && turnRequests.length === 1;
    const iceServers = vencida
      ? ICE_SERVERS.map((server) => ({ ...server, credential: 'senha-que-o-turn-recusa' }))
      : ICE_SERVERS;

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        iceServers,
        ttl: turnTtl,
        expiresAt: new Date(Date.now() + turnTtl * 1000).toISOString(),
      }),
    });
  });

  await context.addInitScript({ content: INSTRUMENTATION });

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err: Error) => consoleErrors.push(String(err)));

  await page.goto(roomUrl);
  const nameField = page.getByPlaceholder('Como te chamam');
  await nameField.waitFor();
  await setInputValue(nameField, name);

  // O toggle do lobby. Um clique de verdade, e não `check()`: é o caminho que
  // comprovadamente chega ao React neste headless (a injeção via CDP não chega
  // ao renderer — ver `setInputValue`).
  const cameraToggle = page.getByRole('checkbox', { name: 'Entrar com a câmera ligada' });
  await cameraToggle.waitFor();
  if ((await cameraToggle.isChecked()) !== cameraOn) {
    await cameraToggle.click();
    await page.waitForFunction(
      (want: boolean) =>
        document.querySelector<HTMLInputElement>('.prejoin-toggle input')?.checked === want,
      cameraOn,
      { timeout: 5000 },
    );
  }

  await page.getByRole('button', { name: 'Entrar na sala' }).click();

  return { context, page, name, consoleErrors, turnRequests };
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
export async function setInputValue(locator: Locator, value: string) {
  await locator.evaluate((input: HTMLInputElement, text: string) => {
    // O `!` duplo: o descritor de `value` existe em todo navegador que roda esta
    // suíte, e sem o setter nativo não há como o React enxergar a mudança.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/**
 * Escolhe uma opção de um `<select>` controlado pelo React.
 *
 * Mesmo motivo de `setInputValue`: a injeção de eventos via CDP não chega ao
 * renderer neste headless. `selectOption()` do Playwright dispara o evento pelo
 * caminho que não funciona aqui; escrever pelo setter nativo e despachar
 * `change` é o caminho que o React escuta.
 */
export async function setSelectValue(locator: Locator, value: string) {
  await locator.evaluate((select: HTMLSelectElement, wanted: string) => {
    // Mesma observação de `setInputValue`.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, wanted);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/**
 * Abre o modal de configurações e espera ele estabilizar: o preview precisa ter
 * concedido a permissão e a enumeração precisa ter populado os seletores, senão
 * a escolha cai numa `<option>` que ainda não existe.
 */
export async function openSettings(page: Page, { source = '.controls' }: { source?: string } = {}) {
  await page.locator(source).getByRole('button', { name: 'Configurações' }).click();
  const modal = page.locator('.settings-modal');
  await modal.waitFor({ timeout: 10000 });
  await page.waitForFunction(
    () => {
      const selects = document.querySelectorAll<HTMLSelectElement>('.settings-modal select');
      return selects.length === 3 && [...selects].every((s) => s.options.length > 1);
    },
    { timeout: 10000 },
  );
  return modal;
}

/** Snapshot dos tracks de cada sender, por peer — identidade e estado. */
export async function senderTracks(page: Page) {
  return page.evaluate(() =>
    (window.__wtkPeers || [])
      .filter((pc) => pc.connectionState !== 'closed')
      .map((pc) =>
        pc.getSenders()
          // O predicado do `filter` estreita o tipo: quem sobra tem `track`.
          .filter((s): s is RTCRtpSender & { track: MediaStreamTrack } => !!s.track)
          .map((s) => ({ kind: s.track.kind, id: s.track.id, enabled: s.track.enabled })),
      ),
  );
}

/**
 * Aprova todos os pedidos de entrada pendentes na página.
 *
 * Os botões vivem no modal (`.join-request-modal`), que é o único lugar onde
 * "Aprovar" aparece — o seletor é escopado nele de propósito: se o modal deixar
 * de ser renderizado, isto falha por timeout de entrada em vez de silenciosamente
 * clicar em outro botão de mesmo nome que venha a existir.
 */
export async function approveAll(page: Page) {
  const buttons = page.locator('.join-request-modal').getByRole('button', { name: 'Aprovar' });
  for (let i = await buttons.count(); i > 0; i = await buttons.count()) {
    await buttons.first().click();
    await sleep(150);
  }
}

/**
 * Estado de layout da sala, medido no próprio browser: é o que prova que a
 * página não rola e que os controles continuam alcançáveis.
 */
export async function roomLayout(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const grid = document.querySelector('.video-grid');
    const controls = document.querySelector('.controls')?.getBoundingClientRect() || null;
    const tile = document.querySelector('.video-tile')?.getBoundingClientRect() || null;
    const stage = document.querySelector('.video-stage')?.getBoundingClientRect() || null;
    return {
      // O tile não pode exceder a área da grade: era exatamente isso que fazia
      // o participante único empurrar os controles para fora da tela.
      tileFitsStage:
        tile && stage
          ? tile.top >= stage.top - 1 &&
            tile.bottom <= stage.bottom + 1 &&
            tile.left >= stage.left - 1 &&
            tile.right <= stage.right + 1
          : null,
      chatOpen: !!document.querySelector('.chat-panel'),
      stageWidth: stage ? stage.width : null,
      stageHeight: stage ? stage.height : null,
      scrollHeight: doc.scrollHeight,
      innerHeight: window.innerHeight,
      scrollTop: document.scrollingElement?.scrollTop ?? 0,
      controlsBottom: controls ? controls.bottom : null,
      controlsTop: controls ? controls.top : null,
      tiles: document.querySelectorAll('.video-tile').length,
      tileWidth: tile ? tile.width : null,
      tileRatio: tile && tile.height ? tile.width / tile.height : null,
      cols: grid ? Number(getComputedStyle(grid).getPropertyValue('--grid-cols')) : null,
      overflowing: grid ? grid.classList.contains('overflowing') : null,
      videoFit: (() => {
        const video = document.querySelector('.video-tile video');
        return video ? getComputedStyle(video).objectFit : null;
      })(),
    };
  });
}

/** True quando a página inteira cabe no viewport e não há como rolá-la. */
export const noPageScroll = (layout: { scrollHeight: number; innerHeight: number; scrollTop: number }) =>
  layout.scrollHeight <= layout.innerHeight && layout.scrollTop === 0;

/**
 * Geometria do palco em modo destaque, do ponto de vista do DOM.
 *
 * O que interessa aqui não é o número exato de pixels — isso está fixado nos
 * testes unitários de `lib/spotlightLayout.js` — mas a **hierarquia**: existe
 * exatamente uma tela grande, as outras miniaturas são visivelmente menores, e
 * quem rola é a coluna. É a tradução no navegador do que o módulo puro promete.
 */
export async function spotlightLayout(page: Page) {
  return page.evaluate(() => {
    const layout = document.querySelector('.spotlight-layout');
    const main = document.querySelector('.spotlight-main .video-tile');
    const rail = document.querySelector('.thumb-rail');
    const thumbs = [...document.querySelectorAll('.thumb-item')];
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    const mainRect = rect(main);
    const railRect = rect(rail);

    return {
      active: !!layout,
      gridActive: !!document.querySelector('.video-grid'),
      narrow: layout ? layout.classList.contains('spotlight-narrow') : null,
      spotlightWidth: mainRect ? mainRect.width : null,
      spotlightHeight: mainRect ? mainRect.height : null,
      // Rótulo do tile em destaque: é como o teste sabe **de quem** é a tela em
      // destaque sem depender de ids internos.
      spotlightLabel:
        document.querySelector('.spotlight-main .video-label')?.textContent?.trim() || null,
      railWidth: railRect ? railRect.width : null,
      railScrolls: rail ? rail.scrollHeight > rail.clientHeight + 1 : null,
      thumbCount: thumbs.length,
      thumbWidth: thumbs[0] ? thumbs[0].getBoundingClientRect().width : null,
      selectableCount: document.querySelectorAll('.thumb-select').length,
      // Exatamente uma miniatura pressionada enquanto a coluna é um grupo de
      // escolha: é o estado que o teclado e o leitor de tela leem.
      pressedCount: document.querySelectorAll('.thumb-select[aria-pressed="true"]').length,
      panelOpen: !!document.querySelector('.participants-panel'),
      toggleCount: document.querySelectorAll('.participants-toggle').length,
    };
  });
}

/** Estado interno das RTCPeerConnections, lido do próprio processo da página. */
export async function peerStats(page: Page) {
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
    // Disparos de \`negotiationneeded\`, somados sobre todas as conexões. Os
    // contadores de SDP acima provam que nenhuma renegociação **terminou**;
    // este prova que nenhuma foi sequer **pedida**. A diferença importa: um
    // replaceTrack com kind diferente do negociado agenda a renegociação para o
    // fim da microtask, e uma checagem feita cedo demais veria os contadores de
    // SDP ainda parados.
    negotiationNeeded: 0,
    // Um item por getUserMedia, com os deviceId PEDIDOS: prova o que foi pedido,
    // não só quantas vezes.
    gumRequests: [],
  };

  // ------------------------------------------------ simulação de dispositivos
  // A flag --use-fake-device-for-media-stream expõe exatamente UMA câmera e UM
  // microfone falsos, e não existe flag para uma segunda. Sem esta camada não há
  // como exercitar "trocar de câmera" no navegador — o teste ficaria restrito ao
  // que o unitário já cobre.
  window.__wtkFakeDevices = [
    { deviceId: 'cam-a', kind: 'videoinput',  label: 'Câmera Falsa A', groupId: 'grp-a' },
    { deviceId: 'cam-b', kind: 'videoinput',  label: 'Câmera Falsa B', groupId: 'grp-b' },
    { deviceId: 'mic-a', kind: 'audioinput',  label: 'Microfone Falso A', groupId: 'grp-a' },
    { deviceId: 'mic-b', kind: 'audioinput',  label: 'Microfone Falso B', groupId: 'grp-b' },
    { deviceId: 'spk-a', kind: 'audiooutput', label: 'Saída Falsa A', groupId: 'grp-a' },
    { deviceId: 'spk-b', kind: 'audiooutput', label: 'Saída Falsa B', groupId: 'grp-b' },
  ];
  window.__wtkSinkIds = [];

  window.__wtkLiveTracks = new Set();
  // Só as tracks vindas de getDisplayMedia. O teste precisa distinguí-las das
  // da câmera para simular "Parar compartilhamento" da barra do navegador.
  window.__wtkDisplayTracks = new Set();

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

  // Instante de criação de cada conexão, na mesma base de \`Date.now()\` do
  // processo de teste. É o que permite afirmar que a credencial foi renovada
  // **antes** de a conexão nascer, e não apenas em algum momento.
  window.__wtkPeerCreatedAt = [];

  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new OrigPC(...args);
    window.__wtkPeers.push(pc);
    window.__wtkPeerCreatedAt.push(Date.now());
    const sld = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = (...a) => { window.__wtkCounters.setLocalDescription++; return sld(...a); };
    const srd = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = (...a) => { window.__wtkCounters.setRemoteDescription++; return srd(...a); };
    // Passivo: \`addEventListener\` não colide com o \`onnegotiationneeded\` que a
    // app atribui, e não muda o comportamento de nenhum dos dois.
    pc.addEventListener('negotiationneeded', () => { window.__wtkCounters.negotiationNeeded++; });
    // Força uma transição de \`connectionState\` de forma determinística. Não há
    // outro jeito de exercitar \`failed\` sem derrubar o TURN (que levaria a
    // conexão inteira junto, e o que está sob teste é a **leitura** do estado,
    // não a queda). \`configurable\` porque a propriedade nativa é um getter e o
    // teste pode forçar mais de uma vez.
    pc.__wtkForceState = (state) => {
      Object.defineProperty(pc, 'connectionState', { value: state, configurable: true });
      // A app usa \`pc.onconnectionstatechange =\`, então despachar o evento roda
      // o handler de verdade — nada aqui reimplementa o mesh.
      pc.dispatchEvent(new Event('connectionstatechange'));
    };
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

  // enumerateDevices devolve o registro simulado, com toJSON() (a app e o teste
  // podem serializar as entradas).
  md.enumerateDevices = async () =>
    window.__wtkFakeDevices.map((d) => ({ ...d, toJSON() { return { ...d }; } }));

  const requestedId = (constraint) => {
    if (!constraint || typeof constraint !== 'object') return null;
    const wanted = constraint.deviceId;
    if (!wanted) return null;
    return typeof wanted === 'string' ? wanted : (wanted.ideal || wanted.exact || null);
  };

  // O device falso real é um só: manter a constraint de deviceId tornaria o
  // resultado dependente de como o Chromium trata um id que ele não conhece.
  const stripDeviceId = (constraints) => {
    if (!constraints || typeof constraints !== 'object') return constraints;
    const out = { ...constraints };
    for (const key of ['video', 'audio']) {
      if (out[key] && typeof out[key] === 'object') {
        const { deviceId, ...rest } = out[key];
        void deviceId;
        out[key] = Object.keys(rest).length ? rest : true;
      }
    }
    return out;
  };

  // O que foi PEDIDO em processamento de áudio, por chamada. Sem isto não há
  // como provar que o toggle desligado emite \`noiseSuppression: false\` — e
  // omitir a constraint no estado desligado é um bug invisível, já que os
  // navegadores ligam a supressão por padrão.
  const requestedProcessing = (constraint) => {
    if (!constraint || typeof constraint !== 'object') return null;
    const wanted = constraint.noiseSuppression;
    if (wanted === undefined) return null;
    return {
      noiseSuppression: typeof wanted === 'object' && wanted !== null ? wanted.ideal : wanted,
    };
  };

  /**
   * Único jeito de exercitar o caminho de fallback num Chromium que suporta a
   * constraint nativa. Sob a flag:
   *
   * 1. \`getSupportedConstraints()\` esconde \`noiseSuppression\`, então a app
   *    decide pelo modo 'worklet';
   * 2. a constraint é **forçada a false** antes de chegar ao getUserMedia real.
   *    Só remover não bastaria: sem a constraint, o Chromium liga o próprio
   *    processamento por padrão, suprimiria o ruído antes de o worklet ver
   *    qualquer coisa, e a medição de dB compararia duas amostras já limpas.
   */
  const origSupported = md.getSupportedConstraints.bind(md);
  md.getSupportedConstraints = () => {
    const supported = origSupported();
    if (!window.__wtkForceWorkletNs) return supported;
    const { noiseSuppression, ...rest } = supported;
    void noiseSuppression;
    return rest;
  };

  const forceRawAudio = (constraints) => {
    if (!window.__wtkForceWorkletNs) return constraints;
    if (!constraints || typeof constraints !== 'object') return constraints;
    if (!constraints.audio) return constraints;
    const audio = typeof constraints.audio === 'object' ? { ...constraints.audio } : {};
    audio.noiseSuppression = false;
    audio.echoCancellation = false;
    audio.autoGainControl = false;
    return { ...constraints, audio };
  };

  const origGUM = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints, ...rest) => {
    window.__wtkCounters.getUserMedia++;
    const asked = {
      // requestedId devolve null tanto para "video: false" quanto para
      // "video: true" sem deviceId — ele responde "qual device", não "pediu?".
      // videoRequested é a pergunta que o LED da webcam responde, e é o que
      // torna "nenhum getUserMedia com vídeo" verificável.
      videoRequested: !!constraints?.video,
      video: requestedId(constraints?.video),
      audio: requestedId(constraints?.audio),
      audioProcessing: requestedProcessing(constraints?.audio),
    };
    window.__wtkCounters.gumRequests.push(asked);
    const stream = await origGUM(forceRawAudio(stripDeviceId(constraints)), ...rest);
    // getSettings() passa a reportar o device pedido — mas só quando ele existe
    // no registro. Um id desconhecido continua reportando o device real, que é
    // exatamente o que um navegador faz com \`ideal\` e o que faz a reconciliação
    // de preferência obsoleta ter o que consertar.
    for (const track of stream.getTracks()) {
      const wanted = track.kind === 'video' ? asked.video : asked.audio;
      const known = wanted && window.__wtkFakeDevices.some((d) => d.deviceId === wanted);
      const origSettings = track.getSettings.bind(track);
      track.getSettings = () => ({
        ...origSettings(),
        deviceId: known ? wanted : (origSettings().deviceId || 'fake-device-real'),
      });
    }
    return trackStream(stream);
  };

  // setSinkId: o headless pode não implementar, e a asserção é sobre TER
  // chamado — não sobre o áudio sair de fato por outro alto-falante.
  if (window.HTMLMediaElement) {
    HTMLMediaElement.prototype.setSinkId = function (sinkId) {
      window.__wtkSinkIds.push({ tag: this.tagName, sinkId });
      return Promise.resolve();
    };

    // Autoplay bloqueado sob demanda. O Chromium do teste roda com a permissão
    // de microfone concedida, o que **dispensa** a política de autoplay — então
    // o caso que morde no Safari, no Firefox e no iOS não aconteceria nunca
    // aqui. Ligar a flag reproduz a rejeição que o usuário real recebe.
    window.__wtkBlockAutoplay = false;
    window.__wtkPlayCalls = 0;
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      window.__wtkPlayCalls++;
      if (window.__wtkBlockAutoplay) {
        const err = new Error('play() bloqueado pelo teste');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      return origPlay.apply(this, args);
    };
  }

  // Único jeito de cobrir conexão/desconexão de hardware sem hardware.
  window.__wtkAddDevice = (info) => {
    window.__wtkFakeDevices.push(info);
    md.dispatchEvent(new Event('devicechange'));
  };
  window.__wtkRemoveDevice = (deviceId) => {
    window.__wtkFakeDevices = window.__wtkFakeDevices.filter((d) => d.deviceId !== deviceId);
    // O navegador encerra o track de um device arrancado; o helper faz o mesmo,
    // senão a recuperação da aplicação nunca seria exercitada.
    for (const track of window.__wtkLiveTracks) {
      if (track.readyState !== 'live') continue;
      let settings = {};
      try { settings = track.getSettings(); } catch {}
      if (settings.deviceId === deviceId) track.dispatchEvent(new Event('ended'));
    }
    md.dispatchEvent(new Event('devicechange'));
  };
  const origGDM = md.getDisplayMedia?.bind(md);
  if (origGDM) {
    md.getDisplayMedia = async (...a) => {
      window.__wtkCounters.getDisplayMedia++;
      const stream = await origGDM(...a);
      for (const t of stream.getTracks()) window.__wtkDisplayTracks.add(t);
      return trackStream(stream);
    };
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
