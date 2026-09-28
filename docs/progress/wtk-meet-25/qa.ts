/**
 * QA de navegador da WTK-MEET-25 — os cenários do DoD, no Chromium.
 *
 * O QA 4 (token vencido) mora em `qa-janela.ts`, em processo próprio: depois do
 * bloco de sala cheia, que abre sete contextos, o `newContext()` seguinte não
 * voltava mais. Ver o cabeçalho daquele arquivo.
 *
 * O que os testes de `node:test` provam é o protocolo: o que cada socket
 * recebe e o que ele deliberadamente não recebe. O que **só** o navegador prova
 * é o outro lado da promessa — que o `sessionStorage` sobrevive ao F5, morre
 * com a aba, é copiado na aba duplicada, e que depois do retorno as duas
 * pessoas voltam a se ver e a se ouvir. Daí este roteiro existir separado da
 * suíte: ele é caro (sobe TURN, servidor, build do client e Chromium) e roda
 * sob demanda, não a cada commit.
 *
 * Rodar, a partir da raiz do repositório, com a receita de libs do
 * `claude-progress.md` exportada:
 *
 *   node --import ./tools/registerTs.mjs docs/progress/wtk-meet-25/qa.ts > /tmp/qa25.log 2>&1
 *
 * A saída vai para arquivo de propósito: um `| tail` segura tudo até o EOF e
 * faz o processo parecer travado. O log também **é** a evidência do QA 9 — o
 * `[signaling] ...` do servidor cai nele, e o roteiro o varre no fim atrás de
 * qualquer coisa com a forma de um token.
 */
import type { Browser, BrowserContext, Page } from 'playwright';

import {
  CLIENT_ORIGIN,
  approveAll,
  buildClient,
  buildServer,
  launchBrowser,
  openParticipant,
  peerStats,
  setInputValue,
  sleep,
  startClientServer,
  startSignaling,
  startTurn,
} from '../../../packages/e2e/harness.ts';

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];
/** Tudo que o servidor imprimiu, para a varredura de vazamento do QA 9. */
const saidaDoServidor: string[] = [];

function check(name: string, passed: boolean, detail = ''): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A forma exata do token: é o que se procura em log e em console. */
const FORMA_DE_TOKEN = /[0-9a-f]{64}/;

const sala = (sufixo: string) => `qa25-${sufixo}-${Math.random().toString(36).slice(2, 8)}`;
const PASSPHRASE = 'correta-cavalo-bateria-grampo';
const urlDaSala = (roomId: string) => `${CLIENT_ORIGIN}/${roomId}#${PASSPHRASE}`;

/** Espera a sala entrar em chamada — o mesmo sinal que o `run.ts` usa. */
async function esperarNaChamada(page: Page, timeout = 30000): Promise<void> {
  await page.locator('.room.in-call').waitFor({ timeout });
}

/** O modal de aprovação está na tela **agora**? */
async function temModal(page: Page): Promise<boolean> {
  return (await page.locator('.join-request-modal').count()) > 0;
}

/** Quantos tiles de participante a grade mostra. */
async function tiles(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.video-tile').length);
}

/** O modal de aprovação apareceu para quem aprova, dentro do prazo? */
function esperouPedido(page: Page, timeout = 20000): Promise<boolean> {
  return page
    .locator('.join-request-modal')
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);
}

/**
 * Abre o link da sala pela tela que estiver na frente.
 *
 * O lobby só aparece quando aquela origem ainda não lembra o nome — ele fica em
 * `localStorage` sob `wtk-meet:display-name`, e é gravado no primeiro ingresso.
 * Depois disso, o F5 e a navegação na mesma aba vão **direto** para a sala. As
 * duas formas são "abrir o link", e o roteiro não pode presumir uma delas: foi
 * exatamente isso que fez a primeira versão deste arquivo travar esperando um
 * campo de nome que nunca ia reaparecer.
 */
async function abrirSala(page: Page, roomUrl: string, nome: string): Promise<void> {
  await page.goto(roomUrl);
  const campoNome = page.getByPlaceholder('Como te chamam');
  const temLobby = await campoNome
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!temLobby) return;
  await setInputValue(campoNome, nome);
  await page.getByRole('button', { name: 'Entrar na sala' }).click();
}

/** O token guardado por aquela aba para aquela sala. */
async function tokenDaAba(page: Page, roomId: string): Promise<string | null> {
  return page.evaluate((id: string) => sessionStorage.getItem(`wtk-meet:resume:${id}`), roomId);
}

const turn = startTurn();
await buildClient();
await buildServer();
const signaling = startSignaling();
await signaling.ready;
const client = startClientServer();

// O que o servidor imprime passa pelo stdout deste processo (ver `harness.ts`);
// duplicamos num buffer para poder varrer no fim sem depender do arquivo.
const escreverOriginal = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...resto: unknown[]) => {
  const texto = String(chunk);
  if (texto.startsWith('[signaling')) saidaDoServidor.push(texto);
  return escreverOriginal(chunk as string, ...(resto as []));
}) as typeof process.stdout.write;

let browser: Browser | undefined;
let falhas = 0;

try {
  browser = await launchBrowser();

  // ------------------------------------------------ QA 1, 8 e 9: o F5 do Bob

  {
    const roomId = sala('f5');
    const roomUrl = urlDaSala(roomId);
    const alice = await openParticipant(browser, { roomUrl, name: 'Alice', cameraOn: true });
    await esperarNaChamada(alice.page);

    const bob = await openParticipant(browser, { roomUrl, name: 'Bob', cameraOn: true });
    await alice.page.locator('.join-request-modal').waitFor({ timeout: 40000 });
    await approveAll(alice.page);
    await esperarNaChamada(bob.page);
    await sleep(3000); // deixa a malha fechar antes de derrubar

    const tokenAntes = await tokenDaAba(bob.page, roomId);
    check(
      'QA 1a. A aba do Bob guardou o token em wtk-meet:resume:<roomId>',
      typeof tokenAntes === 'string' && FORMA_DE_TOKEN.test(tokenAntes),
      `chave ${tokenAntes ? 'presente, 64 hex' : 'AUSENTE'}`,
    );

    // O F5. A partir daqui a Alice não pode ver modal nenhum.
    let modalNaAlice = false;
    const vigia = setInterval(() => {
      void temModal(alice.page).then((tem) => {
        if (tem) modalNaAlice = true;
      });
    }, 150);

    // O F5 de verdade: o nome já está no `localStorage`, então a aba volta
    // direto para a sala — sem lobby e, se o token valer, sem aprovação.
    await bob.page.reload();
    await esperarNaChamada(bob.page, 30000);
    await sleep(2500);
    clearInterval(vigia);

    check(
      'QA 1. B volta sozinho depois do F5, e NENHUM modal aparece na tela de A',
      !modalNaAlice && !(await temModal(alice.page)),
      modalNaAlice ? 'um modal apareceu para a Alice' : 'a Alice não foi incomodada',
    );

    const tokenDepois = await tokenDaAba(bob.page, roomId);
    check(
      'QA 1b. A retomada rotacionou o token (o antigo não serve mais)',
      typeof tokenDepois === 'string' && tokenDepois !== tokenAntes,
      tokenDepois === tokenAntes ? 'o token NÃO mudou' : 'token novo gravado',
    );

    // QA 8: mídia bidirecional de volta, e contagem certa dos dois lados.
    await sleep(4000);
    const statsAlice = await peerStats(alice.page);
    const statsBob = await peerStats(bob.page);
    const conectados = (s: Awaited<ReturnType<typeof peerStats>>) =>
      s.filter((c) => c.connectionState === 'connected').length;
    check(
      'QA 8a. Depois do F5 a malha refez a conexão nos dois sentidos',
      conectados(statsAlice) >= 1 && conectados(statsBob) >= 1,
      `alice=${conectados(statsAlice)}/${statsAlice.length} bob=${conectados(statsBob)}/${statsBob.length}`,
    );

    const midia = await alice.page.evaluate(() => {
      const videos = [...document.querySelectorAll('video')];
      return videos.map((v) => ({
        temStream: !!(v.srcObject as MediaStream | null),
        trilhas: ((v.srcObject as MediaStream | null)?.getTracks() ?? []).map((t) => t.kind),
      }));
    });
    const remotasComAudioEVideo = midia.filter(
      (m) => m.temStream && m.trilhas.includes('audio') && m.trilhas.includes('video'),
    ).length;
    check(
      'QA 8b. A Alice tem áudio e vídeo do Bob de volta',
      remotasComAudioEVideo >= 1,
      `${remotasComAudioEVideo} elemento(s) de vídeo com áudio+vídeo`,
    );

    const tilesAlice = await tiles(alice.page);
    check(
      'QA 8c. A contagem na tela da Alice está certa: sem duplicata e sem fantasma',
      tilesAlice === 2,
      `${tilesAlice} tiles (esperado 2)`,
    );

    // QA 9, parte do console: nada com forma de token no console de ninguém.
    const consoleSujo = [...alice.consoleErrors, ...bob.consoleErrors].filter((linha) =>
      FORMA_DE_TOKEN.test(linha),
    );
    check(
      'QA 9a. Nada com a forma de um token apareceu no console do browser',
      consoleSujo.length === 0,
      consoleSujo.length ? `${consoleSujo.length} linha(s) suspeita(s)` : 'console limpo',
    );

    await alice.context.close();
    await bob.context.close();
  }

  // ----------------------------------------------- QA 2: saída intencional

  {
    const roomId = sala('saida');
    const roomUrl = urlDaSala(roomId);
    const alice = await openParticipant(browser, { roomUrl, name: 'Alice' });
    await esperarNaChamada(alice.page);
    const bob = await openParticipant(browser, { roomUrl, name: 'Bob' });
    await alice.page.locator('.join-request-modal').waitFor({ timeout: 40000 });
    await approveAll(alice.page);
    await esperarNaChamada(bob.page);
    await sleep(1500);

    // O botão de sair é o `.leave` da barra de controles (title "Sair da sala").
    await bob.page.locator('button.leave').click();
    await sleep(1500);
    check(
      'QA 2a. Sair pela UI apagou a chave do sessionStorage',
      (await tokenDaAba(bob.page, roomId)) === null,
      'chave ausente depois do clique em "Sair da sala"',
    );

    // Reabre o link na **mesma** aba.
    await abrirSala(bob.page, roomUrl, 'Bob');
    check('QA 2. Depois de sair e reabrir na mesma aba, volta a pedir aprovação', await esperouPedido(alice.page));

    await alice.context.close();
    await bob.context.close();
  }

  // -------------------------------------------------- QA 3: aba fechada

  {
    const roomId = sala('aba-fechada');
    const roomUrl = urlDaSala(roomId);
    const alice = await openParticipant(browser, { roomUrl, name: 'Alice' });
    await esperarNaChamada(alice.page);
    const bob = await openParticipant(browser, { roomUrl, name: 'Bob' });
    await alice.page.locator('.join-request-modal').waitFor({ timeout: 40000 });
    await approveAll(alice.page);
    await esperarNaChamada(bob.page);
    await sleep(1500);

    // Fecha a aba (e o contexto com ela): o `sessionStorage` morre junto.
    await bob.context.close();
    await sleep(1000);

    const novaAba = await openParticipant(browser, { roomUrl, name: 'Bob' });
    check(
      'QA 3. Aba fechada e reaberta numa aba nova volta a pedir aprovação',
      await esperouPedido(alice.page),
      'o sessionStorage morreu com a aba, como esperado',
    );

    await alice.context.close();
    await novaAba.context.close();
  }

  // ------------------------------------------------- QA 5: aba duplicada

  {
    const roomId = sala('duplicada');
    const roomUrl = urlDaSala(roomId);
    const alice = await openParticipant(browser, { roomUrl, name: 'Alice' });
    await esperarNaChamada(alice.page);
    const bob = await openParticipant(browser, { roomUrl, name: 'Bob' });
    await alice.page.locator('.join-request-modal').waitFor({ timeout: 40000 });
    await approveAll(alice.page);
    await esperarNaChamada(bob.page);
    await sleep(2000);

    const token = await tokenDaAba(bob.page, roomId);
    // "Duplicar aba" no Chrome copia o `sessionStorage` — aqui isso é encenado
    // semeando a mesma chave numa aba nova antes de qualquer script da app.
    const clone: BrowserContext = await browser.newContext({
      permissions: ['camera', 'microphone'],
    });
    await clone.addInitScript({
      content: `sessionStorage.setItem('wtk-meet:resume:${roomId}', ${JSON.stringify(token)});`,
    });
    const clonePage = await clone.newPage();
    await abrirSala(clonePage, roomUrl, 'Bob');
    check('QA 5a. A aba duplicada pede aprovação normal', await esperouPedido(alice.page));

    const bobContinua = await esperarNaChamada(bob.page, 5000)
      .then(() => true)
      .catch(() => false);
    check('QA 5b. A aba original continua na sala, sem ser expulsa', bobContinua);

    const tilesAlice = await tiles(alice.page);
    check(
      'QA 5c. Não surgiu um Bob fantasma na grade da Alice',
      tilesAlice === 2,
      `${tilesAlice} tiles (esperado 2: Alice e Bob)`,
    );

    await clone.close();
    await alice.context.close();
    await bob.context.close();
  }

  // --------------------------------------------- QA 7: token de outra sala

  {
    const salaX = sala('x');
    const salaY = sala('y');
    const alice = await openParticipant(browser, { roomUrl: urlDaSala(salaX), name: 'Alice' });
    await esperarNaChamada(alice.page);
    const bob = await openParticipant(browser, { roomUrl: urlDaSala(salaX), name: 'Bob' });
    await alice.page.locator('.join-request-modal').waitFor({ timeout: 40000 });
    await approveAll(alice.page);
    await esperarNaChamada(bob.page);
    await sleep(1500);

    const tokenX = await tokenDaAba(bob.page, salaX);

    // Alguém abre a sala Y primeiro, para que ela não esteja vazia.
    const carol = await openParticipant(browser, { roomUrl: urlDaSala(salaY), name: 'Carol' });
    await esperarNaChamada(carol.page);

    // O Bob navega para a sala Y na **mesma aba**: o token de X continua lá.
    await abrirSala(bob.page, urlDaSala(salaY), 'Bob');
    check(
      'QA 7. A sala Y pede aprovação normal — o token de X não admite nela',
      await esperouPedido(carol.page),
      `token de X ${tokenX ? 'presente na aba' : 'ausente'}, e inútil em Y`,
    );

    await alice.context.close();
    await bob.context.close();
    await carol.context.close();
  }

  // ------------------------------------------------------ QA 6: sala cheia

  {
    const roomId = sala('cheia');
    const roomUrl = urlDaSala(roomId);
    const alice = await openParticipant(browser, { roomUrl, name: 'Alice' });
    await esperarNaChamada(alice.page);

    const demais = [];
    for (let i = 2; i <= 6; i += 1) {
      const p = await openParticipant(browser, { roomUrl, name: `P${i}` });
      await alice.page.locator('.join-request-modal').waitFor({ timeout: 40000 });
      await approveAll(alice.page);
      await esperarNaChamada(p.page);
      demais.push(p);
      await sleep(600);
    }

    const ultimo = demais[demais.length - 1]!;
    const tokenDoUltimo = await tokenDaAba(ultimo.page, roomId);

    // Ele cai (F5), e enquanto está fora a vaga continua reservada.
    await ultimo.page.reload();

    // Um sétimo estranho, sem token, ainda leva room-full.
    const estranho = await openParticipant(browser, { roomUrl, name: 'Setimo' });
    const levouRoomFull = await estranho.page
      .locator('.room.denied')
      .getByText('A sala já está com 6 participantes.')
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check(
      'QA 6a. Com alguém na graça, um sétimo estranho continua levando room-full',
      levouRoomFull,
      'a vaga reservada segue contando para o limite de 6',
    );

    const voltou = await esperarNaChamada(ultimo.page, 30000)
      .then(() => true)
      .catch(() => false);
    check(
      'QA 6. Quem deu F5 numa sala de 6 volta sem room-full',
      voltou,
      `token ${tokenDoUltimo ? 'estava guardado' : 'AUSENTE'}`,
    );

    await estranho.context.close();
    await alice.context.close();
    for (const p of demais) await p.context.close();
  }

  // ------------------------------------------- QA 9: varredura final do log

  {
    const log = saidaDoServidor.join('');
    const linhasSujas = log.split('\n').filter((linha) => FORMA_DE_TOKEN.test(linha));
    check(
      'QA 9. Nenhuma linha do log do servidor contém algo com a forma de um token',
      linhasSujas.length === 0,
      linhasSujas.length
        ? `${linhasSujas.length} linha(s): ${linhasSujas[0]?.slice(0, 80)}`
        : `${log.split('\n').length} linhas varridas, todas limpas`,
    );
  }
} catch (err) {
  console.error('\n💥 Falha na execução do QA:', err);
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

// Explícito: uma sonda que só chega ao fim do script fica pendurada segurando o
// `node-turn`, e sondas órfãs já derrubaram execuções inteiras do E2E aqui.
process.exit(falhas === 0 && passaram === results.length ? 0 : 1);
