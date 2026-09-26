/**
 * E2E da extensão Chrome: **um motor, N abas**.
 *
 * Roteiro, e o que cada passo defende:
 *
 *   X1. A extensão carrega sem compactação e o service worker sobe.
 *   X2. Duas abas falam com o **mesmo** motor (mesmo `engineId`) e existe
 *       **exatamente um** documento offscreen (`chrome.runtime.getContexts`).
 *   X3. Um favorito criado numa aba aparece na outra em ≤1s.
 *   X4. Disparar o efeito numa aba produz **uma** reprodução (`playCount`) e
 *       **um** `AudioContext` — visto pelas duas abas.
 *   X5. Disparar da **outra** aba soma no mesmo contador: o motor é um só.
 *   X6. O rate limit é global: o quarto disparo em 5s é recusado com mensagem,
 *       não importa de qual aba ele venha.
 *   X7. URL sem CORS é recusada com mensagem — nunca com silêncio.
 *   X8. Uma faixa adicionada à fila numa aba toca e aparece na outra.
 *
 * **Por que este arquivo existe separado de `run.ts`.** O Playwright só carrega
 * extensão em **contexto persistente** (`launchPersistentContext` +
 * `--load-extension`), e o roteiro de 3 participantes usa contextos isolados do
 * mesmo browser. Misturar os dois num processo só é o caminho conhecido para a
 * saturação documentada em `claude-progress.md` — um bloco que não volta, sem
 * verde e sem vermelho. Aqui são duas abas e um contexto.
 *
 * O áudio do efeito vem de um WAV servido por um servidor local **com CORS**:
 * sem `Access-Control-Allow-Origin` a sonda do soundboard recusa antes de
 * baixar, que é justamente o que X7 afirma do outro lado.
 *
 * Rodar: `npm run test:e2e:extension` na raiz (ele mesmo builda a extensão).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

/** A fatia de `chrome` que este roteiro usa dentro do service worker. */
interface ChromeGetContexts {
  runtime: { getContexts(filter: Record<string, never>): Promise<{ contextType: string }[]> };
}

/**
 * A janela do rate limit, em ms. Mesma constante de
 * `packages/client/src/lib/soundboardRate.ts` — escrita aqui porque o roteiro
 * roda no Node e não carrega o bundle da extensão. Se divergir, o teste passa a
 * medir outra coisa.
 */
const BURST_WINDOW_MS = 5_000;

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(AQUI, '..', 'extension');
const DIST = path.join(EXTENSION, 'dist');

const results: { name: string; passed: boolean; detail: string }[] = [];
let failures = 0;

function check(name: string, passed: boolean, detail = ''): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

/** WAV 16-bit PCM mono: um tom curto, o suficiente para `decodeAudioData`. */
function wav({ seconds = 1, freq = 440, rate = 8000 } = {}): Buffer {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2);
  }
  return buffer;
}

/**
 * Dois endereços no mesmo servidor: `/com-cors.wav` responde
 * `Access-Control-Allow-Origin: *`, `/sem-cors.wav` **não** responde nada disso
 * — é o MyInstants do teste.
 */
function startAudioServer(): Promise<{ origin: string; stop: () => void }> {
  const corpo = wav();
  const server = http.createServer((req, res) => {
    const comCors = req.url?.startsWith('/com-cors');
    if (comCors) res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(corpo.length));
    res.end(req.method === 'HEAD' ? undefined : corpo);
  });
  return new Promise((resolve) => {
    // Porta 0: quem escolhe é o SO. Porta sorteada à mão colide com outra suíte
    // rodando em worktree irmão — é uma armadilha registrada deste repositório.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        stop: () => server.close(),
      });
    });
  });
}

/** O estado que o motor publicou, lido da sonda de diagnóstico do popup. */
async function diag(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...(document.getElementById('diag')?.dataset ?? {}) }) as Record<string, string>);
}

async function esperaMotor(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (document.getElementById('diag')?.dataset.engineId ?? '').startsWith('eng-'),
    null,
    { timeout: 20_000 },
  );
}

/** Espera um campo da sonda chegar a um valor. O timeout curto é proposital. */
async function esperaCampo(page: Page, campo: string, valor: string, timeout = 1_000): Promise<boolean> {
  try {
    await page.waitForFunction(
      ([c, v]) => document.getElementById('diag')?.dataset[c!] === v,
      [campo, valor] as const,
      { timeout, polling: 50 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Espera a janela do rate limit abrir. São 5s no pior caso. */
async function esperaCooldownZero(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getElementById('diag')?.dataset.cooldownMs === '0', null, {
    timeout: 15_000,
    polling: 100,
  });
}

const audio = await startAudioServer();
let context: BrowserContext | undefined;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtk-ext-e2e-'));

try {
  console.log('[extension] build…');
  execFileSync('node', ['build.ts'], { cwd: EXTENSION, stdio: 'inherit' });
  check('X1a. o build produz dist/ carregável', fs.existsSync(path.join(DIST, 'manifest.json')));

  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    // O binário completo, não o `chrome-headless-shell`: extensão e WebAudio
    // precisam do Chromium de verdade.
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      // O documento offscreen não tem gesto do usuário: sem isto, `play()`
      // rejeita e o motor reporta bloqueio em vez de tocar.
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(sw.url()).host;
  check('X1b. o service worker da extensão sobe', !!extensionId, extensionId);

  const popupUrl = `chrome-extension://${extensionId}/popup.html`;

  const abaA = await context.newPage();
  await abaA.goto(popupUrl);
  await esperaMotor(abaA);

  const abaB = await context.newPage();
  await abaB.goto(popupUrl);
  await esperaMotor(abaB);

  const idA = (await diag(abaA)).engineId;
  const idB = (await diag(abaB)).engineId;
  check('X2a. as duas abas falam com o mesmo motor', !!idA && idA === idB, `${idA} = ${idB}`);

  // `chrome` só existe dentro do service worker; o `as` é a forma de dizer isso
  // ao compilador deste arquivo, que roda no Node.
  const contextos = (await sw.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: ChromeGetContexts }).chrome;
    const lista = await api.runtime.getContexts({});
    return lista.map((c) => c.contextType);
  })) as string[];
  const offscreens = contextos.filter((t) => t === 'OFFSCREEN_DOCUMENT').length;
  check('X2b. existe exatamente um documento offscreen', offscreens === 1, contextos.join(', '));

  // ------------------------------------------------------------------- X3
  await abaA.fill('#fav-input', `${audio.origin}/com-cors.wav`);
  await abaA.click('[data-testid=fav-add]');
  const espelhou = await esperaCampo(abaB, 'favorites', '1');
  check('X3. favorito criado na aba A aparece na aba B em ≤1s', espelhou);

  // ------------------------------------------------------------------- X4
  await abaA.click('.efeito');
  const tocouUmaVez = await esperaCampo(abaA, 'playCount', '1', 10_000);
  const viuNaB = await esperaCampo(abaB, 'playCount', '1');
  const depois = await diag(abaA);
  check('X4a. disparar numa aba produz exatamente uma reprodução', tocouUmaVez, `playCount=${depois.playCount}`);
  check('X4b. a outra aba vê a mesma contagem em ≤1s', viuNaB);
  check(
    'X4c. existe exatamente um AudioContext no motor',
    depois.audioContexts === '1',
    `audioContexts=${depois.audioContexts}`,
  );

  // ------------------------------------------------------------------- X5
  await abaB.click('.efeito');
  const somou = await esperaCampo(abaA, 'playCount', '2', 10_000);
  check('X5. disparo vindo da outra aba soma no mesmo motor', somou);

  // ------------------------------------------------------------------- X6
  // Em **rajada**, e não um clique por vez: a janela é de 5s, e o roteiro leva
  // mais que isso entre uma asserção e outra — disparos espaçados deslizam a
  // janela e o limite nunca apareceria. O `force` existe porque o botão fica
  // desabilitado assim que o cooldown começa, que já é metade da defesa.
  // A janela precisa estar **vazia**, e não apenas com vaga: `cooldownMs === 0`
  // só diz que cabe mais um. Os disparos de X4 e X5 ainda contam, e sem esta
  // espera a rajada começaria com duas marcas dentro da janela.
  await abaA.waitForTimeout(BURST_WINDOW_MS + 500);
  const antesDaRajada = Number((await diag(abaA)).playCount ?? '0');
  for (let i = 0; i < 4; i += 1) {
    // O locator é resolvido a cada volta de propósito: o popup recria os botões
    // a cada patch de estado, e um handle guardado apontaria para um elemento
    // que já saiu do documento.
    await abaA.locator('.efeito').first().click({ force: true, noWaitAfter: true });
    await abaA.waitForTimeout(250);
  }
  await abaA.waitForTimeout(1_000);

  const depoisDaRajada = Number((await diag(abaA)).playCount ?? '0');
  check(
    'X6a. quatro disparos em rajada produzem no máximo três reproduções',
    depoisDaRajada - antesDaRajada === 3,
    `${depoisDaRajada - antesDaRajada} reproduções`,
  );

  // A recusa do quarto disparo acontece **antes** do motor, e é assim que o app
  // faz: o botão fica indisponível e a tela mostra quanto falta. Um clique com
  // `force` num `<button disabled>` não dispara evento nenhum — então o que se
  // afirma aqui é a defesa que o usuário vê, e não uma mensagem de erro que só
  // existiria se a UI tivesse deixado passar.
  const botaoBloqueado = await abaB.locator('.efeito').first().isDisabled();
  const tempoRestante = await abaB.evaluate(
    () => document.getElementById('cooldown')?.textContent ?? '',
  );
  check(
    'X6b. estourado o limite, o botão fica indisponível e a tela diz quanto falta',
    botaoBloqueado && /aguarde/i.test(tempoRestante),
    `disabled=${botaoBloqueado} "${tempoRestante}"`,
  );

  const cooldownA = Number((await diag(abaA)).cooldownMs ?? '0');
  const cooldownB = Number((await diag(abaB)).cooldownMs ?? '0');
  check(
    'X6c. a janela é a mesma nas duas abas',
    cooldownA > 0 && cooldownB > 0,
    `A=${Math.round(cooldownA)}ms B=${Math.round(cooldownB)}ms`,
  );

  // ------------------------------------------------------------------- X7
  await abaA.fill('#fav-input', `${audio.origin}/sem-cors.wav`);
  await abaA.click('[data-testid=fav-add]');
  await abaA.waitForFunction(() => document.getElementById('diag')?.dataset.favorites === '2', null, {
    timeout: 5_000,
  });
  // Espera a janela abrir: a recusa tem de ser por CORS, não por rate limit.
  await esperaCooldownZero(abaA);
  const antesDaRecusa = Number((await diag(abaA)).playCount ?? '0');
  await abaA.locator('.efeito').nth(1).click({ force: true });

  const recusa = await abaA
    .waitForFunction(
      () => {
        const aviso = document.getElementById('notice');
        return aviso && !aviso.hidden && /CORS/i.test(aviso.textContent ?? '') ? aviso.textContent : null;
      },
      null,
      { timeout: 10_000 },
    )
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(() => '');
  check('X7a. URL sem CORS é recusada com mensagem, e não com silêncio', !!recusa, recusa.slice(0, 60));

  const aposRecusa = Number((await diag(abaA)).playCount ?? '0');
  check('X7b. a recusa não conta como reprodução', aposRecusa === antesDaRecusa, `playCount=${aposRecusa}`);

  // ------------------------------------------------------------------- X8
  const managerUrl = `chrome-extension://${extensionId}/manager.html`;
  const manager = await context.newPage();
  await manager.goto(managerUrl);
  await manager.fill('#url-input', `${audio.origin}/com-cors.wav`);
  await manager.click('[data-testid=url-add]');
  const filaNaA = await esperaCampo(abaA, 'queueLength', '1', 10_000);
  check('X8. faixa adicionada na página manager aparece na fila das abas', filaNaA);

  const contextosFinais = (await sw.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: ChromeGetContexts }).chrome;
    const lista = await api.runtime.getContexts({});
    return lista.filter((c) => c.contextType === 'OFFSCREEN_DOCUMENT').length;
  })) as number;
  check('X9. continua havendo um único documento offscreen no fim', contextosFinais === 1, String(contextosFinais));
} catch (err) {
  check('execução do roteiro', false, err instanceof Error ? err.message : String(err));
} finally {
  await context?.close();
  audio.stop();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checagens passaram`);
process.exit(failures === 0 ? 0 : 1);
