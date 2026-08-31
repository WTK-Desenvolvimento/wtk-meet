/**
 * Sonda de captura e verificação visual da WTK-MEET-22.
 *
 * **Não faz parte da suíte E2E** e não é rodada por `npm run test:e2e`: é a
 * ferramenta que produz as evidências do DoD (screenshots antes/depois de cada
 * tela, nos dois temas e nos dois viewports) e as medições de layout, foco e
 * camadas que a suíte não faz. Vive em `docs/progress/` de propósito — fora de
 * `packages/`, portanto fora do `typecheck` e do `lint` dos pacotes.
 *
 * Uso (a partir da raiz do repositório, com as libs do Chromium exportadas —
 * ver "Notas para rodar o E2E neste ambiente" em `claude-progress.md`):
 *
 *     node --import ./tools/registerTs.mjs docs/progress/wtk-meet-22/shots.ts antes
 *     node --import ./tools/registerTs.mjs docs/progress/wtk-meet-22/shots.ts depois
 *
 * O argumento vira prefixo dos arquivos. Na passada `antes` o tema claro ainda
 * não existe, então só o escuro é capturado; o script detecta isso sozinho pela
 * presença do atributo `data-theme` no `<html>`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'playwright';

import {
  CLIENT_ORIGIN,
  approveAll,
  buildClient,
  buildServer,
  launchBrowser,
  openParticipant,
  sleep,
  startClientServer,
  startSignaling,
  startTurn,
} from '../../../packages/e2e/harness.js';

const TAG = process.argv[2] || 'antes';
const OUT = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = { width: 1280, height: 720 };
const MOBILE = { width: 390, height: 844 };

mkdirSync(OUT, { recursive: true });

const relatorio: string[] = [];
const medicoes: Record<string, unknown> = {};
let falhou: unknown = null;

function log(linha: string) {
  console.log(linha);
  relatorio.push(linha);
}

/** Aguarda uma condição, sem depender do relógio do sandbox. */
async function waitFor(fn: () => Promise<boolean>, { timeout = 20000, label = '' } = {}) {
  const fim = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > fim) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

/** Escreve o tema resolvido direto no `<html>` — o mesmo que `applyTheme` faz. */
async function setTheme(page: Page, tema: 'dark' | 'light') {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, tema);
  await sleep(150);
}

/** True quando o produto já entende `data-theme` (passada `depois`). */
async function temaSuportado(page: Page) {
  return page.evaluate(() => !!document.documentElement.dataset.theme);
}

async function shot(page: Page, nome: string, tema: string, viewport: string) {
  const arquivo = path.join(OUT, `${TAG}-${nome}-${tema}-${viewport}.png`);
  await page.screenshot({ path: arquivo });
  log(`📸 ${path.basename(arquivo)}`);
}

/**
 * Percorre a página por Tab e devolve, para cada parada, o seletor do elemento
 * e o indicador de foco que ele efetivamente mostra.
 */
async function varrerFoco(page: Page, limite = 30) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const paradas: { alvo: string; outline: string; boxShadow: string; visivel: boolean }[] = [];
  for (let i = 0; i < limite; i += 1) {
    await page.keyboard.press('Tab');
    const parada = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const outline =
        cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
          ? `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`
          : '';
      const boxShadow = cs.boxShadow === 'none' ? '' : cs.boxShadow;
      const alvo = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
      return {
        alvo: `${alvo}${el.textContent ? ` «${el.textContent.trim().slice(0, 24)}»` : ''}`,
        outline,
        boxShadow,
        visivel: !!outline || !!boxShadow,
      };
    });
    if (!parada) break;
    if (paradas.some((p) => p.alvo === parada.alvo) && paradas.length > 3) break;
    paradas.push(parada);
  }
  return paradas;
}

/** Alvos de toque menores que 44x44 entre os controles interativos visíveis. */
async function alvosPequenos(page: Page) {
  return page.evaluate(() => {
    const seletor = 'button, a, input, select, [role="button"], [tabindex="0"]';
    return [...document.querySelectorAll<HTMLElement>(seletor)]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          alvo: `${el.tagName.toLowerCase()}.${(typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).join('.')}`,
          texto: (el.textContent || '').trim().slice(0, 20),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })
      .filter((m) => m.w < 44 || m.h < 44);
  });
}

/** Geometria de sala: rolagem, controles dentro do viewport, sobreposição. */
async function geometria(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const r = (s: string) => document.querySelector(s)?.getBoundingClientRect() || null;
    const controls = r('.controls');
    const stage = r('.stage');
    const chat = r('.chat-panel');
    const music = r('.music-panel');
    const videoStage = r('.video-stage');
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      scrollHeight: doc.scrollHeight,
      innerHeight: window.innerHeight,
      semScrollHorizontal: doc.scrollWidth <= doc.clientWidth,
      semScrollVertical: doc.scrollHeight <= window.innerHeight,
      controlsBottom: controls ? Math.round(controls.bottom) : null,
      controlsDentro: controls ? controls.bottom <= window.innerHeight + 1 : null,
      // O empilhamento de ≤720px: o chat/música ficam ABAIXO do palco de vídeo.
      chatAbaixoDoVideo: chat && videoStage ? chat.top >= videoStage.bottom - 1 : null,
      musicAbaixoDoVideo: music && videoStage ? music.top >= videoStage.bottom - 1 : null,
      stageAltura: stage ? Math.round(stage.height) : null,
    };
  });
}

/** As invariantes que o E2E mede e que esta entrega não pode mexer. */
async function contratoE2E(page: Page) {
  return page.evaluate(() => {
    const zi = (s: string) => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).zIndex : null;
    };
    const video = document.querySelector('.video-tile video');
    const sinks = document.querySelector('.peer-audio-sinks');
    return {
      objectFit: video ? getComputedStyle(video).objectFit : null,
      aspectTile: document.querySelector('.video-tile')
        ? getComputedStyle(document.querySelector('.video-tile')!).aspectRatio
        : null,
      peerAudioDisplay: sinks ? getComputedStyle(sinks).display : null,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      zToasts: zi('.toasts'),
      zParticipantes: zi('.participants-panel'),
      zVoto: zi('.music-vote-card'),
      zSettings: zi('.modal-backdrop.settings'),
      zAprovacao: zi('.modal-backdrop:not(.settings)'),
      backdropPosition: document.querySelector('.modal-backdrop')
        ? getComputedStyle(document.querySelector('.modal-backdrop')!).position
        : null,
      selects: document.querySelectorAll('.settings-modal select').length,
      chaves: Object.keys(localStorage).sort(),
    };
  });
}

async function main() {
  await Promise.all([buildClient(), buildServer()]);
  const turn = startTurn();
  const sinalizacao = startSignaling();
  await sinalizacao.ready;
  const cliente = startClientServer();
  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    // Mesmo formato do roteiro do E2E: o id é o path e a chave é o fragmento.
    const roomUrl = `${CLIENT_ORIGIN}/sala-design-22#chave-do-design`;

    // ------------------------------------------------------ Home e PreJoin
    const solo = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const soloPage = await solo.newPage();
    await soloPage.setViewportSize(DESKTOP);
    await soloPage.goto(`${CLIENT_ORIGIN}/`);
    await soloPage.getByRole('button', { name: 'Criar sala' }).waitFor({ timeout: 15000 });

    const suportaTema = await temaSuportado(soloPage);
    const temas: ('dark' | 'light')[] = suportaTema ? ['dark', 'light'] : ['dark'];
    log(`tema alternável nesta passada: ${suportaTema ? 'sim (dark + light)' : 'não (só dark)'}`);

    for (const viewport of [
      ['desktop', DESKTOP],
      ['390px', MOBILE],
    ] as const) {
      await soloPage.setViewportSize(viewport[1]);
      for (const tema of temas) {
        await setTheme(soloPage, tema);
        await shot(soloPage, 'home', tema, viewport[0]);
      }
    }

    // PreJoin: o lobby de uma sala existente.
    await soloPage.setViewportSize(DESKTOP);
    await soloPage.goto(roomUrl);
    await soloPage.locator('.prejoin').waitFor({ timeout: 15000 });
    await sleep(800);
    for (const viewport of [
      ['desktop', DESKTOP],
      ['390px', MOBILE],
    ] as const) {
      await soloPage.setViewportSize(viewport[1]);
      for (const tema of temas) {
        await setTheme(soloPage, tema);
        await shot(soloPage, 'prejoin', tema, viewport[0]);
      }
    }
    medicoes.focoPreJoin = await varrerFoco(soloPage, 12);
    await solo.close();

    // ---------------------------------------------------- Sala com 3 pessoas
    const alice = await openParticipant(browser, { roomUrl, name: 'Alice', cameraOn: true });
    await alice.page.setViewportSize(DESKTOP);
    await alice.page.getByRole('button', { name: /^Chat/ }).waitFor({ timeout: 30000 });

    // Bob pede entrada: o modal de aprovação aparece para Alice.
    const bob = await openParticipant(browser, { roomUrl, name: 'Bob', cameraOn: true });
    await alice.page.locator('.join-request-modal').waitFor({ timeout: 30000 });
    for (const tema of temas) {
      await setTheme(alice.page, tema);
      await shot(alice.page, 'join-request-modal', tema, 'desktop');
    }
    await alice.page.setViewportSize(MOBILE);
    await sleep(400);
    for (const tema of temas) {
      await setTheme(alice.page, tema);
      await shot(alice.page, 'join-request-modal', tema, '390px');
    }
    await alice.page.setViewportSize(DESKTOP);
    await sleep(300);

    // Aprovação: o toast de entrada nasce agora e some em poucos segundos.
    await setTheme(alice.page, 'dark');
    await approveAll(alice.page);
    await alice.page.locator('.toast').first().waitFor({ timeout: 15000 });
    for (const tema of temas) {
      await setTheme(alice.page, tema);
      await shot(alice.page, 'toasts', tema, 'desktop');
    }

    await bob.page.getByRole('button', { name: /^Chat/ }).waitFor({ timeout: 30000 });
    const carol = await openParticipant(browser, { roomUrl, name: 'Carol', cameraOn: true });
    await waitFor(
      async () => {
        await approveAll(alice.page);
        return (await carol.page.getByRole('button', { name: /^Chat/ }).count()) > 0;
      },
      { timeout: 45000, label: 'Carol na chamada' },
    );
    await waitFor(async () => (await alice.page.locator('.video-tile').count()) >= 3, {
      timeout: 30000,
      label: 'três tiles no palco de Alice',
    });
    await sleep(1500);

    // Grade
    for (const viewport of [
      ['desktop', DESKTOP],
      ['390px', MOBILE],
    ] as const) {
      await alice.page.setViewportSize(viewport[1]);
      await sleep(700);
      for (const tema of temas) {
        await setTheme(alice.page, tema);
        await shot(alice.page, 'room-grade', tema, viewport[0]);
      }
      medicoes[`geometriaGrade-${viewport[0]}`] = await geometria(alice.page);
      if (viewport[0] === '390px') medicoes.alvosPequenosGrade390 = await alvosPequenos(alice.page);
    }
    await alice.page.setViewportSize(DESKTOP);
    await sleep(500);

    // Chat aberto
    await alice.page.getByRole('button', { name: /^Chat/ }).click();
    await alice.page.locator('.chat-panel').waitFor({ timeout: 10000 });
    const campo = alice.page.getByLabel('Mensagem');
    await campo.evaluate((input: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'olá, o design mudou');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await alice.page.getByRole('button', { name: 'Enviar' }).click().catch(() => {});
    await sleep(600);
    for (const viewport of [
      ['desktop', DESKTOP],
      ['390px', MOBILE],
    ] as const) {
      await alice.page.setViewportSize(viewport[1]);
      await sleep(700);
      for (const tema of temas) {
        await setTheme(alice.page, tema);
        await shot(alice.page, 'chat-panel', tema, viewport[0]);
      }
      medicoes[`geometriaChat-${viewport[0]}`] = await geometria(alice.page);
    }
    await alice.page.setViewportSize(DESKTOP);
    await alice.page.getByRole('button', { name: /^Chat/ }).click();
    await sleep(400);

    // Painel de música (o player nasce desligado; o botão abre a proposta)
    await alice.page.getByRole('button', { name: 'Música' }).click();
    await sleep(1200);
    const temPainelMusica = (await alice.page.locator('.music-panel').count()) > 0;
    const temVoto = (await alice.page.locator('.music-vote-card').count()) > 0;
    if (temVoto) {
      for (const tema of temas) {
        await setTheme(alice.page, tema);
        await shot(alice.page, 'music-vote-card', tema, 'desktop');
      }
      // Aprovar a proposta nos três para o painel abrir de fato.
      for (const p of [bob, carol]) {
        await p.page
          .locator('.music-vote-card')
          .getByRole('button', { name: /Sim|Ligar|Aprovar/ })
          .first()
          .click()
          .catch(() => {});
      }
      await sleep(2500);
    }
    if ((await alice.page.locator('.music-panel').count()) === 0) {
      await alice.page.getByRole('button', { name: 'Música' }).click().catch(() => {});
      await sleep(1500);
    }
    log(`painel de música aberto na primeira tentativa: ${temPainelMusica}; votação: ${temVoto}`);
    if ((await alice.page.locator('.music-panel').count()) > 0) {
      for (const viewport of [
        ['desktop', DESKTOP],
        ['390px', MOBILE],
      ] as const) {
        await alice.page.setViewportSize(viewport[1]);
        await sleep(700);
        for (const tema of temas) {
          await setTheme(alice.page, tema);
          await shot(alice.page, 'music-panel', tema, viewport[0]);
        }
        medicoes[`geometriaMusica-${viewport[0]}`] = await geometria(alice.page);
        if (viewport[0] === '390px')
          medicoes.alvosPequenosMusica390 = await alvosPequenos(alice.page);
      }
      await alice.page.setViewportSize(DESKTOP);
      await alice.page.getByRole('button', { name: 'Música' }).click().catch(() => {});
      await sleep(400);
    } else {
      log('⚠️  painel de música não abriu — captura pulada');
    }

    // Modo destaque: Carol compartilha a tela.
    await carol.page.getByRole('button', { name: 'Compartilhar tela' }).click();
    await waitFor(async () => (await alice.page.locator('.spotlight-layout').count()) > 0, {
      timeout: 30000,
      label: 'palco em modo destaque',
    });
    await sleep(1500);
    for (const viewport of [
      ['desktop', DESKTOP],
      ['390px', MOBILE],
    ] as const) {
      await alice.page.setViewportSize(viewport[1]);
      await sleep(900);
      for (const tema of temas) {
        await setTheme(alice.page, tema);
        await shot(alice.page, 'room-destaque', tema, viewport[0]);
      }
      medicoes[`geometriaDestaque-${viewport[0]}`] = await geometria(alice.page);
      if (viewport[0] === '390px')
        medicoes.alvosPequenosDestaque390 = await alvosPequenos(alice.page);
    }
    await alice.page.setViewportSize(DESKTOP);
    await sleep(500);
    medicoes.contratoDestaque = await contratoE2E(alice.page);
    medicoes.focoSala = await varrerFoco(alice.page, 20);
    await carol.page.getByRole('button', { name: 'Parar compartilhamento' }).click().catch(() => {});
    await sleep(1200);

    // Modal de configurações
    await alice.page.locator('.controls').getByRole('button', { name: 'Configurações' }).click();
    await alice.page.locator('.settings-modal').waitFor({ timeout: 15000 });
    await alice.page.waitForFunction(
      () => {
        const s = document.querySelectorAll<HTMLSelectElement>('.settings-modal select');
        return s.length === 3 && [...s].every((x) => x.options.length > 1);
      },
      { timeout: 15000 },
    );
    await sleep(500);
    for (const viewport of [
      ['desktop', DESKTOP],
      ['390px', MOBILE],
    ] as const) {
      await alice.page.setViewportSize(viewport[1]);
      await sleep(600);
      for (const tema of temas) {
        await setTheme(alice.page, tema);
        await shot(alice.page, 'settings-modal', tema, viewport[0]);
      }
    }
    await alice.page.setViewportSize(DESKTOP);
    await sleep(400);
    medicoes.contratoSettings = await contratoE2E(alice.page);
    medicoes.focoSettings = await varrerFoco(alice.page, 16);

    // Alternância pelo controle real da UI (só existe na passada `depois`).
    if (suportaTema) {
      const radios = alice.page.locator('.settings-modal input[type="radio"]');
      const quantos = await radios.count();
      log(`rádios de tema no modal: ${quantos}`);
      if (quantos === 3) {
        await radios.nth(1).click();
        await sleep(400);
        const aposClaro = await alice.page.evaluate(() => ({
          atributo: document.documentElement.dataset.theme,
          gravado: localStorage.getItem('wtk-meet:theme'),
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
        }));
        await radios.nth(2).click();
        await sleep(400);
        const aposEscuro = await alice.page.evaluate(() => ({
          atributo: document.documentElement.dataset.theme,
          gravado: localStorage.getItem('wtk-meet:theme'),
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
        }));
        // Cancelar não reverte o tema (§3.7).
        await alice.page.getByRole('button', { name: 'Cancelar' }).click();
        await sleep(300);
        medicoes.alternancia = {
          aposClaro,
          aposEscuro,
          aposCancelar: await alice.page.evaluate(() => document.documentElement.dataset.theme),
          chaves: await alice.page.evaluate(() => Object.keys(localStorage).sort()),
          devices: await alice.page.evaluate(() => {
            const cru = localStorage.getItem('wtk-meet:devices');
            return cru ? Object.keys(JSON.parse(cru)).sort() : null;
          }),
        };
      }
    } else {
      await alice.page.getByRole('button', { name: 'Cancelar' }).click().catch(() => {});
    }

    // Uma aba nova, sem nada em storage: o tema tem que sair do sistema.
    for (const preferido of ['dark', 'light'] as const) {
      const ctx = await browser.newContext({ colorScheme: preferido });
      const p = await ctx.newPage();
      await p.goto(`${CLIENT_ORIGIN}/`);
      await p.getByRole('button', { name: 'Criar sala' }).waitFor({ timeout: 15000 });
      medicoes[`primeiraVisita-${preferido}`] = await p.evaluate(() => ({
        atributo: document.documentElement.dataset.theme || null,
        chaves: Object.keys(localStorage),
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
      }));
      await ctx.close();
    }

    // Preferência gravada vence a do sistema, e sobrevive ao reload.
    if (suportaTema) {
      const ctx = await browser.newContext({ colorScheme: 'dark' });
      await ctx.addInitScript({ content: "localStorage.setItem('wtk-meet:theme','light');" });
      const p = await ctx.newPage();
      await p.goto(`${CLIENT_ORIGIN}/`);
      await p.getByRole('button', { name: 'Criar sala' }).waitFor({ timeout: 15000 });
      const antes = await p.evaluate(() => document.documentElement.dataset.theme);
      await p.reload();
      await p.getByRole('button', { name: 'Criar sala' }).waitFor({ timeout: 15000 });
      medicoes.preferenciaGravada = {
        soPreferenciaClaraComSOEscuro: antes,
        aposReload: await p.evaluate(() => document.documentElement.dataset.theme),
      };
      await ctx.close();
    }

    // 320x568 — o piso do §3.10.
    await alice.page.setViewportSize({ width: 320, height: 568 });
    await sleep(900);
    medicoes.geometria320 = await geometria(alice.page);
    medicoes.alvosPequenos320 = await alvosPequenos(alice.page);
    await shot(alice.page, 'room-grade', 'dark', '320px');
  } catch (erro) {
    falhou = erro;
    console.error('\n💥 sonda interrompida:', erro);
  } finally {
    writeFileSync(path.join(OUT, `${TAG}-medicoes.json`), JSON.stringify(medicoes, null, 2));
    writeFileSync(path.join(OUT, `${TAG}-relatorio.txt`), relatorio.join('\n') + '\n');
    console.log('\n===== MEDIÇÕES =====');
    console.log(JSON.stringify(medicoes, null, 2));
    await browser?.close().catch(() => {});
    cliente.stop();
    sinalizacao.stop();
    turn.stop();
    // O sandbox não entrega SIGTERM a filhos e os servidores seguram o loop.
    setTimeout(() => process.exit(falhou ? 1 : 0), 500).unref?.();
    process.exit(falhou ? 1 : 0);
  }
}

main();
