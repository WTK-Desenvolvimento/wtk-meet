/**
 * QA 4 da WTK-MEET-25, em processo próprio: o token que vence.
 *
 * Mora fora do `qa.ts` por um motivo medido, não por gosto. Rodando no fim
 * daquele roteiro — logo depois do bloco de sala cheia, que abre sete contextos
 * Chromium — o `browser.newContext()` seguinte simplesmente não voltava: o
 * navegador ficava saturado e o cenário travava por quinze minutos sem
 * produzir nem verde nem vermelho. Com navegador limpo, o mesmo cenário fecha
 * em pouco mais de um minuto.
 *
 * É também o único cenário desta entrega que precisa de **relógio de parede**:
 * a janela de graça é contada pelo servidor com `Date.now()`, e o processo
 * filho não tem como ser adiantado de fora. A borda exata da janela
 * (`now === expiresAt` ⇒ vencido) é provada com relógio injetado em
 * `packages/server/test/rooms.test.ts`; o que se prova **aqui** é o que só o
 * navegador mostra: passados os 60 segundos, quem volta pede aprovação — e é
 * admitido normalmente, sem ficar preso do lado de fora.
 *
 *   node --import ./tools/registerTs.mjs docs/progress/wtk-meet-25/qa-janela.ts > /tmp/qa25-janela.log 2>&1
 */
import { setTimeout as delay } from 'node:timers/promises';

import type { Browser, Page } from 'playwright';

import {
  CLIENT_ORIGIN,
  approveAll,
  buildClient,
  buildServer,
  launchBrowser,
  openParticipant,
  setInputValue,
  sleep,
  startClientServer,
  startSignaling,
  startTurn,
} from '../../../packages/e2e/harness.ts';

const results: { name: string; passed: boolean; detail: string }[] = [];

function check(name: string, passed: boolean, detail = ''): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const roomId = `qa25-janela-${Math.random().toString(36).slice(2, 8)}`;
const roomUrl = `${CLIENT_ORIGIN}/${roomId}#correta-cavalo-bateria-grampo`;

const esperarNaChamada = (page: Page, timeout = 30000) =>
  page.locator('.room.in-call').waitFor({ timeout });

const esperouPedido = (page: Page, timeout = 20000) =>
  page
    .locator('.join-request-modal')
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

const turn = startTurn();
await buildClient();
await buildServer();
const signaling = startSignaling();
await signaling.ready;
const client = startClientServer();

let browser: Browser | undefined;
let falhas = 0;

try {
  browser = await launchBrowser();

  const alice = await openParticipant(browser, { roomUrl, name: 'Alice' });
  await esperarNaChamada(alice.page);

  const bob = await openParticipant(browser, { roomUrl, name: 'Bob' });
  await alice.page.locator('.join-request-modal').waitFor({ timeout: 40000 });
  await approveAll(alice.page);
  await esperarNaChamada(bob.page);
  await sleep(1500);

  const token = await bob.page.evaluate(
    (id: string) => sessionStorage.getItem(`wtk-meet:resume:${id}`),
    roomId,
  );
  check(
    'QA 4 (preparo). O Bob tinha um token válido antes de sumir',
    typeof token === 'string' && /^[0-9a-f]{64}$/.test(token),
  );

  // A queda, e a demora. O contexto fecha (a aba morre); o token é semeado de
  // volta numa aba nova para encenar exatamente "o mesmo token, tarde demais".
  await bob.context.close();
  console.log('[qa25] esperando a janela de graça de 60s vencer…');
  await delay(63_000);

  const tardio = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await tardio.addInitScript({
    content: `sessionStorage.setItem('wtk-meet:resume:${roomId}', ${JSON.stringify(token)});`,
  });
  const tardioPage = await tardio.newPage();
  await tardioPage.goto(roomUrl);
  const campoNome = tardioPage.getByPlaceholder('Como te chamam');
  if (await campoNome.waitFor({ timeout: 5000 }).then(() => true).catch(() => false)) {
    await setInputValue(campoNome, 'Bob');
    await tardioPage.getByRole('button', { name: 'Entrar na sala' }).click();
  }

  check('QA 4a. Passados 60s o token não retoma: volta a pedir aprovação', await esperouPedido(alice.page));

  // E o principal: ninguém fica preso fora da sala por causa disso.
  await approveAll(alice.page);
  const entrou = await esperarNaChamada(tardioPage, 30000)
    .then(() => true)
    .catch(() => false);
  check('QA 4. Ninguém fica preso fora da sala por causa de um token vencido', entrou);

  await tardio.close();
  await alice.context.close();
} catch (err) {
  console.error('\n💥 Falha na execução do QA da janela:', err);
  falhas += 1;
} finally {
  await browser?.close();
  signaling.stop();
  client.stop();
  turn.stop();
}

const passaram = results.filter((r) => r.passed).length;
console.log(`\n${passaram}/${results.length} checagens de QA passaram`);
for (const r of results.filter((r) => !r.passed)) console.log(`  ✖ ${r.name} — ${r.detail}`);

// Explícito: sem isto a sonda fica pendurada segurando o `node-turn`.
process.exit(falhas === 0 && passaram === results.length ? 0 : 1);
