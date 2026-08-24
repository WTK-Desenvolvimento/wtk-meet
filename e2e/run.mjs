/**
 * Teste E2E das cinco melhorias, com 3 participantes em contextos Chromium
 * isolados. Cobre exatamente o roteiro do definition of done:
 *
 *   A. conexão do mesh (3 participantes, 2 peers cada)
 *   B. indicador de fala (anel azul) sem tráfego de nível de áudio
 *   C. compartilhamento de tela + glare (dois compartilhando ao mesmo tempo) e o
 *      modo destaque 80/20 que ele ativa, com seleção local da tela destacada
 *   D. chat P2P via data channel, sem passar pelo servidor
 *   E. desligar/religar câmera com track.stop() e replaceTrack, sem renegociar
 *   S. modal de configurações: listagem, troca de câmera/mic em chamada,
 *      saída de áudio, cancelamento e devicechange
 *   N. player de música: votação, fila convergente e áudio no quarto canal
 *   F. saída da sala sem vazar tracks/AudioContext/rAF
 *
 * Rodar: node e2e/run.mjs   (o próprio script builda o client)
 */
import os from 'node:os';
import path from 'node:path';

import {
  CLIENT_ORIGIN,
  approveAll,
  buildClient,
  inboundAudio,
  launchBrowser,
  noPageScroll,
  openParticipant,
  openSettings,
  peerStats,
  rmsBetween,
  roomLayout,
  senderTracks,
  setInputValue,
  setSelectValue,
  sleep,
  spotlightLayout,
  startClientServer,
  startSignaling,
  startTurn,
  writeAudioFixture,
  writeNoiseFixture,
} from './harness.mjs';

const results = [];
let failures = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const mark = passed ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condição' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout esperando ${label} (último valor: ${JSON.stringify(last)})`);
}

// Endereço personalizado, na raiz e sem `/room/` — o formato que a
// WTK-MEET-10 entregou. O sufixo aleatório usa o mesmo alfabeto base32 sem
// ambiguidade do client (`lib/roomSlug.js`): um caractere fora dele seria
// normalizado pela sala, o redirect mudaria a URL no meio do teste e as falhas
// apareceriam longe da causa.
const ALFABETO = '0123456789abcdefghjkmnpqrstvwxyz';
const sufixo = Array.from(crypto.getRandomValues(new Uint8Array(6)))
  .map((b) => ALFABETO[b % ALFABETO.length])
  .join('');
const roomId = `uma-sala-so-minha-${sufixo}`;
const passphrase = 'e2e-passphrase-nao-vai-ao-servidor';
const roomUrl = `${CLIENT_ORIGIN}/${roomId}#${passphrase}`;

await buildClient();

const turn = startTurn();
const client = startClientServer();
const signaling = startSignaling();
await signaling.ready;

/** Tudo que trafegou entre o browser e o servidor de sinalização. */
const wire = (page) => page.evaluate(() => window.__wtkWire);

const browser = await launchBrowser();
let alice;
let bob;
let carol;

try {
  // ------------------------------------------------------------------ A. mesh
  /** Espera o participante entrar na chamada, aprovando enquanto isso. */
  const waitInCall = (participant, approver) =>
    waitFor(
      async () => {
        if (approver) await approveAll(approver.page);
        return (await participant.page.locator('.room.in-call').count()) > 0;
      },
      { timeout: 40000, label: `${participant.name} entrar na chamada` },
    );

  alice = await openParticipant(browser, { roomUrl, name: 'Alice' });
  await waitInCall(alice, null);

  // Com 1 participante o tile antigo (4:3 em auto-fit) ocupava a largura inteira
  // e empurrava a barra de controles para fora da tela. É o bug de origem desta
  // suíte de checagens de layout.
  const soloLayout = await roomLayout(alice.page);
  check(
    'L1. Com 1 participante a página não rola e o tile não excede a área da grade',
    noPageScroll(soloLayout) &&
    soloLayout.cols === 1 &&
    soloLayout.tileWidth > 0 &&
    soloLayout.tileFitsStage === true,
    `scrollHeight=${soloLayout.scrollHeight} innerHeight=${soloLayout.innerHeight} ` +
    `cols=${soloLayout.cols} tile=${Math.round(soloLayout.tileWidth)}px ` +
    `cabe no palco=${soloLayout.tileFitsStage}`,
  );
  check(
    'L2. Os controles ficam dentro do viewport, sem depender de scroll',
    soloLayout.controlsBottom !== null && soloLayout.controlsBottom <= soloLayout.innerHeight + 1,
    `controls.bottom=${Math.round(soloLayout.controlsBottom)} innerHeight=${soloLayout.innerHeight}`,
  );

  bob = await openParticipant(browser, { roomUrl, name: 'Bob' });

  // ------------------------------------------- M. modal de pedido de entrada
  // O pedido tem que ser impossível de não ver: quem espera depende de uma ação
  // de quem já está dentro. Antes ele era um bloco inline empurrado para fora da
  // área visível pelo tile gigante — na prática, ninguém entrava.
  await alice.page.locator('.join-request-modal').waitFor({ timeout: 40000 });
  const modal = await alice.page.evaluate(() => {
    const dialog = document.querySelector('.join-request-modal');
    const approve = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Aprovar');
    const rect = dialog.getBoundingClientRect();
    const backdrop = document.querySelector('.modal-backdrop');
    const zOf = (el) => (el ? Number(getComputedStyle(el).zIndex) || 0 : 0);
    // Os toasts só existem no DOM quando há algum na fila, e neste instante não
    // há. Uma sonda com a mesma classe lê o z-index da regra CSS de verdade —
    // comparar contra um elemento ausente daria um "passou" vazio.
    const probe = document.createElement('div');
    probe.className = 'toasts';
    document.body.appendChild(probe);
    const toastZ = zOf(probe);
    probe.remove();
    return {
      backdropFixed: getComputedStyle(backdrop).position === 'fixed',
      backdropZ: zOf(backdrop),
      toastZ,
      role: dialog.getAttribute('role'),
      ariaModal: dialog.getAttribute('aria-modal'),
      hasLabel: !!document.getElementById(dialog.getAttribute('aria-labelledby') || ''),
      focusOnApprove: !!approve && document.activeElement === approve,
      hasDeny: [...dialog.querySelectorAll('button')].some((b) => b.textContent === 'Negar'),
      // Visível sem rolagem, em qualquer estado da tela.
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0,
      pageScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    };
  });
  check(
    'M1. Pedido de entrada abre um modal centralizado, visível sem rolagem',
    modal.inViewport && modal.hasDeny && modal.pageScrollHeight <= modal.innerHeight,
    `inViewport=${modal.inViewport} scrollHeight=${modal.pageScrollHeight}/${modal.innerHeight}`,
  );
  check(
    'M2. O modal é acessível: role=dialog, aria-modal, título associado e foco em "Aprovar"',
    modal.role === 'dialog' &&
    modal.ariaModal === 'true' &&
    modal.hasLabel &&
    modal.focusOnApprove,
    `role=${modal.role} aria-modal=${modal.ariaModal} rotulado=${modal.hasLabel} ` +
    `foco em Aprovar=${modal.focusOnApprove}`,
  );
  // Se o empilhamento inverter, o clique em "Aprovar" é interceptado e ninguém
  // entra na sala — falha longe da causa.
  check(
    'M3. O modal é fixo e fica acima dos toasts',
    modal.backdropFixed && modal.backdropZ > modal.toastZ && modal.toastZ > 0,
    `position=${modal.backdropFixed ? 'fixed' : 'outro'} backdrop z=${modal.backdropZ} toasts z=${modal.toastZ}`,
  );

  // Esc equivale a "não decidi": o pedido continua pendente e o modal continua
  // aberto. Fechar aqui deixaria alguém esperando indefinidamente do outro lado.
  // O evento é despachado de dentro da página porque neste headless a injeção de
  // teclado via CDP não chega ao renderer (ver `setInputValue` no harness).
  await alice.page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await sleep(200);
  const afterEsc = await alice.page.evaluate(() => {
    const dialog = document.querySelector('.join-request-modal');
    return {
      stillOpen: !!dialog,
      // Não fecha "em silêncio": a tentativa recebe uma resposta na tela.
      feedback: dialog?.querySelector('.join-request-hint')?.textContent?.trim() || '',
    };
  });
  check(
    'M4. Esc não decide e não fecha o modal — o pedido continua pendente, com aviso na tela',
    afterEsc.stillOpen && /Esc/i.test(afterEsc.feedback),
    `aberto=${afterEsc.stillOpen} aviso=${JSON.stringify(afterEsc.feedback)}`,
  );

  await waitInCall(bob, alice);

  // Grava os toasts que passarem pela tela de Alice a partir daqui. Sem isso o
  // aviso de entrada precisaria ser lido dentro da janela de ~4s em que ele
  // existe no DOM — uma corrida contra a própria expiração.
  await alice.page.evaluate(() => {
    window.__wtkToastLog = [];
    const record = () => {
      for (const el of document.querySelectorAll('.toast')) {
        const entry = { cls: el.className, text: el.innerText };
        if (!window.__wtkToastLog.some((e) => e.text === entry.text && e.cls === entry.cls)) {
          window.__wtkToastLog.push(entry);
        }
      }
    };
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
    record();
  });
  const beepsBeforeCarol = await alice.page.evaluate(() => window.__wtkCounters.oscillators);

  carol = await openParticipant(browser, { roomUrl, name: 'Carol' });
  await waitInCall(carol, alice);

  const everyoneConnected = async () => {
    for (const p of [alice, bob, carol]) {
      const stats = await peerStats(p.page);
      const live = stats.filter((s) => s.connectionState === 'connected');
      if (live.length !== 2) return false;
    }
    return true;
  };
  await waitFor(everyoneConnected, { timeout: 45000, label: 'mesh conectado (2 peers por participante)' });
  check('A1. Mesh conecta: 3 participantes, 2 RTCPeerConnection "connected" cada', true);

  // Aferido aqui, com todo mundo dentro: mais adiante Bob e Carol saem da sala
  // (seção F) e a URL deles vira a da Home. O que esta checagem prova é o
  // essencial do endereço novo — navegadores diferentes, abrindo o mesmo
  // endereço personalizado na raiz, terminam na mesma sala, com mídia fluindo
  // (é o que A1–A3 mediram no mesmo instante).
  const urlEsperada = `${CLIENT_ORIGIN}/${roomId}#${passphrase}`;
  check(
    'R1. Os três navegadores estão no endereço personalizado, na raiz e sem /room/',
    [alice, bob, carol].every((p) => p.page.url() === urlEsperada),
    [alice, bob, carol].map((p) => `${p.name}=${p.page.url()}`).join(' '),
  );

  // Layout esperado por conexão: 4 canais de envio (mic, câmera, tela, música) e
  // os 4 espelhos de recepção criados pelo navegador ao aplicar a oferta remota.
  //
  // A **ordem** é verificada junto, e não por preciosismo: ela é o contrato que
  // permite ao outro lado classificar as m-lines que chegam. Criar o canal de
  // música em qualquer outra posição embaralha câmera com tela, ou faz a música
  // cair no stream de voz — onde ela acende o anel de "falando" no tile de quem
  // toca e deixa de ter volume próprio. Nos dois casos *parece* funcionar.
  const aliceTx = (await peerStats(alice.page))[0].transceivers;
  const send = aliceTx.filter((t) => t.currentDirection === 'sendonly');
  const recv = aliceTx.filter((t) => t.currentDirection === 'recvonly');
  const sendOrder = send.map((t) => t.kind).join(',');
  check(
    'A2. Cada conexão tem 4 canais por sentido, na ordem mic, câmera, tela, música',
    sendOrder === 'audio,video,video,audio' &&
    recv.filter((t) => t.kind === 'video').length === 2 &&
    recv.filter((t) => t.kind === 'audio').length === 2,
    `transceivers=${JSON.stringify(aliceTx.map((t) => `${t.kind}:${t.currentDirection}`))}`,
  );

  const nTiles = await alice.page.locator('.video-tile').count();
  check('A3. Grade mostra 3 tiles (local + 2 remotos)', nTiles === 3, `tiles=${nTiles}`);

  // A grade se reorganiza sozinha: 3 tiles num palco em paisagem viram 2 colunas
  // (2x2), e nada disso pode custar uma barra de rolagem na página.
  const trioLayout = await roomLayout(alice.page);
  check(
    'L3. Com 3 participantes a grade vira 2 colunas e a página continua sem rolar',
    noPageScroll(trioLayout) && trioLayout.cols === 2 && !trioLayout.overflowing,
    `cols=${trioLayout.cols} scrollHeight=${trioLayout.scrollHeight}/${trioLayout.innerHeight} ` +
    `overflowing=${trioLayout.overflowing}`,
  );
  check(
    'L4. O tile é 16:9 e o vídeo usa letterbox (object-fit: contain), sem corte nem deformação',
    Math.abs(trioLayout.tileRatio - 16 / 9) < 0.02 && trioLayout.videoFit === 'contain',
    `proporção=${trioLayout.tileRatio?.toFixed(3)} (alvo ${(16 / 9).toFixed(3)}) ` +
    `object-fit=${trioLayout.videoFit}`,
  );

  // ------------------------------------------------- A4. toasts de entrada
  // O aviso de entrada tem texto e bipe próprios (740Hz subindo, contra 420Hz
  // descendo na saída), então a checagem de saída em F não cobre este caminho.
  const joinToast = await waitFor(
    async () => {
      const log = await alice.page.evaluate(() => window.__wtkToastLog);
      return log.find((t) => /Carol/.test(t.text)) || false;
    },
    { timeout: 10000, label: 'toast de entrada de Carol' },
  );
  check(
    'A4. Entrada dispara toast com o nome',
    /Carol entrou na sala/.test(joinToast.text) && /toast-join/.test(joinToast.cls),
    JSON.stringify(joinToast.text.replace(/\n/g, ' ')),
  );

  const beepsAfterCarol = await alice.page.evaluate(() => window.__wtkCounters.oscillators);
  check(
    'A5. A entrada também é anunciada por um bipe',
    beepsAfterCarol === beepsBeforeCarol + 1,
    `osciladores: ${beepsBeforeCarol} → ${beepsAfterCarol}`,
  );

  // ------------------------------------------------------- B. anel de fala
  // A câmera/mic falsos do Chromium emitem um tom contínuo: o indicador de
  // fala deve acender em todos os tiles com áudio.
  const speaking = await waitFor(
    async () => {
      const n = await alice.page.locator('.video-tile.speaking').count();
      return n >= 2 ? n : false;
    },
    { timeout: 20000, label: 'anel azul de fala' },
  );
  check('B1. Anel de fala acende a partir do áudio (local + remotos)', speaking >= 2, `tiles falando=${speaking}`);

  const contexts = await alice.page.evaluate(() => window.__wtkAudioContexts.length);
  check('B2. Um único AudioContext para a sala inteira', contexts === 1, `AudioContexts=${contexts}`);

  // Um loop de rAF compartilhado dá ~60 chamadas/s independentemente do número
  // de tiles; um loop por tile daria ~60 × 3.
  const rafRate = await alice.page.evaluate(async () => {
    const before = window.__wtkCounters.raf;
    await new Promise((r) => setTimeout(r, 1000));
    return window.__wtkCounters.raf - before;
  });
  check(
    'B3. Um único loop requestAnimationFrame para todos os tiles',
    rafRate > 10 && rafRate < 90,
    `${rafRate} chamadas/s com 3 tiles`,
  );

  // Histerese observada no navegador (MutationObserver na classe do tile).
  //
  // A temporização exata (200ms de ataque, 500ms de release) é verificada de
  // forma determinística nos testes unitários de `lib/audioLevels.js`, onde
  // relógio e analisador são controlados. Aqui não dá: o dispositivo de áudio
  // falso do Chromium emite bipes curtos e esparsos em vez de um tom contínuo,
  // e o Chrome não entrega o áudio de uma track a um segundo AudioContext, então
  // não há como instalar uma sonda que marque o instante real do silêncio.
  //
  // O que este teste garante — e que o unitário não alcança — é o ciclo completo
  // no navegador de verdade: silenciar apaga o anel, religar acende de novo, e o
  // apagar leva um tempo compatível com a janela de histerese (nunca instantâneo,
  // nunca acima do teto).
  const hysteresis = await alice.page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const tile = document.querySelector('.video-tile');
        const micButton = () =>
          [...document.querySelectorAll('.controls button')].find(
            (b) => b.textContent === 'Silenciar' || b.textContent === 'Ativar mic',
          );
        const waitFlag = (want) =>
          new Promise((res) => {
            if (tile.classList.contains('speaking') === want) return res(performance.now());
            const observer = new MutationObserver(() => {
              if (tile.classList.contains('speaking') === want) {
                observer.disconnect();
                res(performance.now());
              }
            });
            observer.observe(tile, { attributes: true, attributeFilter: ['class'] });
          });

        setTimeout(() => reject(new Error('timeout medindo o ciclo do indicador')), 30000);
        (async () => {
          const releases = [];
          let cameBackOn = false;

          // Vários ciclos: o clique em "Silenciar" cai em pontos aleatórios do
          // padrão de bipes, então o MAIOR release observado é o que mais se
          // aproxima da janela real de histerese.
          for (let round = 0; round < 5; round += 1) {
            await waitFlag(true);
            const mutedAt = performance.now();
            micButton().click();
            const offAt = await waitFlag(false);
            releases.push(offAt - mutedAt);

            micButton().click();
            await waitFlag(true);
            cameBackOn = true;
          }

          resolve({
            maxReleaseMs: Math.max(...releases),
            minReleaseMs: Math.min(...releases),
            cameBackOn,
          });
        })().catch(reject);
      }),
  );
  check(
    'B4. Religar o microfone acende o anel de novo (ciclo completo, 5×)',
    hysteresis.cameBackOn,
  );
  check(
    'B5. O anel apaga dentro da janela de histerese, nunca instantaneamente',
    hysteresis.maxReleaseMs <= 700 && hysteresis.maxReleaseMs >= 200,
    `release observado: ${Math.round(hysteresis.minReleaseMs)}–${Math.round(hysteresis.maxReleaseMs)}ms ` +
    '(o limite exato de 500ms é verificado nos testes unitários de audioLevels)',
  );

  // A aplicação não transmite nível de áudio. O filtro olha os payloads de
  // eventos Socket.IO (frames `42[...]`), não o SDP: SDP legitimamente declara
  // a extensão de cabeçalho RTP `ssrc-audio-level`, que é padrão do WebRTC em
  // qualquer app, viaja dentro do SRTP entre os peers e não é o que alimenta o
  // indicador — ele lê o áudio localmente com AnalyserNode.
  const levelWire = (await wire(alice.page)).filter(
    (f) => /^\d+\[/.test(f.data) && /"(level|speaking|volume|rms|audioLevel)"\s*:/i.test(f.data),
  );
  check(
    'B6. Nenhum nível de áudio é transmitido pela aplicação',
    levelWire.length === 0,
    `${levelWire.length} payloads suspeitos`,
  );

  const chatBefore = (await wire(alice.page)).length;

  // ---------------------------------------------------- C. tela + glare
  // Bob e Carol entram em compartilhamento praticamente ao mesmo tempo: é o
  // cenário de glare que o perfect negotiation precisa absorver.
  const sldBefore = await bob.page.evaluate(() => window.__wtkCounters.setLocalDescription);
  await Promise.all([
    bob.page.getByRole('button', { name: 'Compartilhar tela' }).click(),
    carol.page.getByRole('button', { name: 'Compartilhar tela' }).click(),
  ]);

  // Com duas telas ativas a coluna vira um grupo de escolha: uma miniatura por
  // tela, a da tela em destaque marcada com `aria-pressed`. Esperar pelas duas
  // miniaturas selecionáveis é esperar pelas duas telas de uma vez.
  await waitFor(
    async () => (await alice.page.locator('.thumb-select').count()) >= 2,
    { timeout: 25000, label: 'as duas telas no palco de Alice (uma em destaque, uma na coluna)' },
  );
  check('C1. Dois participantes compartilham tela ao mesmo tempo (glare)', true);

  const stillConnected = await everyoneConnected();
  check('C2. Nenhuma conexão cai durante o glare', stillConnected);

  const badTransceivers = (await peerStats(alice.page)).some((s) =>
    s.signalingState !== 'stable',
  );
  check('C3. signalingState volta a "stable" nos dois lados', !badTransceivers);

  const sldAfter = await bob.page.evaluate(() => window.__wtkCounters.setLocalDescription);
  check(
    'C4. Compartilhar tela não exigiu renegociação de SDP (transceiver pré-criado)',
    sldAfter === sldBefore,
    `setLocalDescription: ${sldBefore} → ${sldAfter}`,
  );

  // O ponto da entrega: com tela compartilhada o palco **não** é mais uma grade
  // uniforme. A tela em destaque é várias vezes maior que qualquer miniatura,
  // em vez de dividir o palco em partes iguais com as câmeras.
  const spotAlice = await spotlightLayout(alice.page);
  const aliceTilesWithScreen = await alice.page.locator('.video-tile').count();
  check(
    'C5. Com tela compartilhada o palco entra em modo destaque, e o destaque é ≥ 3× a miniatura',
    spotAlice.active &&
    !spotAlice.gridActive &&
    // 1 destaque + 3 câmeras + 2 miniaturas de tela (a em destaque entra na
    // coluna como marcador pressionado, sem stream — ver `Room.jsx`).
    aliceTilesWithScreen === 6 &&
    spotAlice.thumbCount === 5 &&
    spotAlice.selectableCount === 2 &&
    spotAlice.pressedCount === 1 &&
    spotAlice.spotlightWidth >= spotAlice.thumbWidth * 3,
    `destaque=${Math.round(spotAlice.spotlightWidth || 0)}px ` +
    `miniatura=${Math.round(spotAlice.thumbWidth || 0)}px ` +
    `miniaturas=${spotAlice.thumbCount} selecionáveis=${spotAlice.selectableCount} ` +
    `pressionadas=${spotAlice.pressedCount} tiles=${aliceTilesWithScreen}`,
  );

  const spotLayout = await roomLayout(alice.page);
  check(
    'C6. O modo destaque não gera scroll de página nem empurra os controles',
    noPageScroll(spotLayout) &&
    spotLayout.tileFitsStage &&
    spotLayout.controlsBottom <= spotLayout.innerHeight + 1,
    `scrollHeight=${spotLayout.scrollHeight}/${spotLayout.innerHeight} ` +
    `destaque cabe no palco=${spotLayout.tileFitsStage}`,
  );

  // A escolha do destaque é **local**: Alice clicar na miniatura não pode mexer
  // no que Bob está vendo. Sincronizar isso exigiria um evento novo na rede, que
  // é justamente o que esta entrega não faz.
  const bobBeforeSelect = await spotlightLayout(bob.page);
  // A que **não** está pressionada: a pressionada é a que já está em destaque, e
  // clicar nela seria um no-op.
  await alice.page.locator('.thumb-select[aria-pressed="false"]').first().click();
  const aliceAfterSelect = await waitFor(
    async () => {
      const now = await spotlightLayout(alice.page);
      return now.spotlightLabel && now.spotlightLabel !== spotAlice.spotlightLabel ? now : null;
    },
    { timeout: 5000, label: 'o destaque de Alice trocar de tela' },
  ).catch(() => null);
  const bobAfterSelect = await spotlightLayout(bob.page);
  check(
    'C7. Clicar na miniatura troca o destaque só na aba que clicou',
    !!aliceAfterSelect && bobAfterSelect.spotlightLabel === bobBeforeSelect.spotlightLabel,
    `Alice: ${JSON.stringify(spotAlice.spotlightLabel)} → ${JSON.stringify(aliceAfterSelect?.spotlightLabel)} | ` +
    `Bob: ${JSON.stringify(bobBeforeSelect.spotlightLabel)} → ${JSON.stringify(bobAfterSelect.spotlightLabel)}`,
  );

  // Teclado e leitor de tela: a miniatura de tela é um `<button>` de verdade,
  // com rótulo e `aria-pressed`; a de câmera não é clicável nem focável.
  //
  // Enter/Espaço não são injetados aqui: neste headless o teclado via CDP não
  // chega ao renderer (ver `setInputValue` no harness). O que se verifica é a
  // razão de a tecla funcionar — o controle é um `<button>` nativo, focável e na
  // ordem de tabulação, e não um `div` com `onClick` — mais a ativação pelo
  // mesmo caminho que Enter dispara.
  const railA11y = await alice.page.evaluate(() => {
    const selectable = [...document.querySelectorAll('.thumb-select')];
    const cameras = [...document.querySelectorAll('.thumb-item:not(.thumb-select)')];
    const target = selectable.find((el) => el.getAttribute('aria-pressed') === 'false');
    target?.focus();
    return {
      buttons: selectable.every(
        (el) => el.tagName === 'BUTTON' && el.type === 'button' && el.hasAttribute('aria-pressed'),
      ),
      // `tabIndex === 0` sem atributo: é o padrão do `<button>` habilitado, o que
      // prova que ninguém o tirou da tabulação.
      tabbable: selectable.every((el) => el.tabIndex === 0 && !el.disabled),
      labelled: selectable.every((el) => (el.getAttribute('aria-label') || '').includes('destaque')),
      camerasInert: cameras.every(
        (el) => el.tagName !== 'BUTTON' && !el.hasAttribute('tabindex') && !el.hasAttribute('role'),
      ),
      focused: !!target && document.activeElement === target,
    };
  });
  const labelBeforeKeyboard = (await spotlightLayout(alice.page)).spotlightLabel;
  // `click()` no elemento focado é exatamente o que a ativação por Enter faz.
  await alice.page.evaluate(() => document.activeElement?.click());
  const keyboardSwitched = await waitFor(
    async () => (await spotlightLayout(alice.page)).spotlightLabel !== labelBeforeKeyboard,
    { timeout: 5000, label: 'o destaque trocar pela ativação do botão focado' },
  ).catch(() => false);
  // O botão ativado continua existindo (agora pressionado) e o foco fica nele:
  // é o ganho de manter a tela em destaque na coluna em vez de removê-la.
  const focusKept = await alice.page.evaluate(
    () => document.activeElement?.getAttribute('aria-pressed') === 'true',
  );
  check(
    'C8. A miniatura de tela é operável por teclado; a de câmera não entra na tabulação',
    railA11y.buttons &&
    railA11y.tabbable &&
    railA11y.labelled &&
    railA11y.camerasInert &&
    railA11y.focused &&
    keyboardSwitched &&
    focusKept,
    `botões=${railA11y.buttons} tabuláveis=${railA11y.tabbable} rotulados=${railA11y.labelled} ` +
    `câmeras inertes=${railA11y.camerasInert} focou=${railA11y.focused} ` +
    `ativação trocou=${keyboardSwitched} foco preservado=${focusKept}`,
  );

  // Palco estreito: o destaque toma a largura inteira e a coluna vira um painel
  // sob demanda. O limiar é medido no palco, não no viewport — por isso o teste
  // encolhe a janela e depois devolve o tamanho, em vez de confiar numa media
  // query.
  const wideViewport = alice.page.viewportSize();
  await alice.page.setViewportSize({ width: 500, height: 820 });
  await sleep(400);
  const narrowStage = await spotlightLayout(alice.page);
  const narrowLayout = await roomLayout(alice.page);
  await alice.page.locator('.participants-toggle').click();
  await alice.page.locator('.participants-panel').waitFor({ timeout: 5000 });
  const withPanel = await spotlightLayout(alice.page);
  // Ao contrário do modal de aprovação, o painel fecha por Esc: aqui não há
  // ninguém esperando uma decisão do outro lado. O evento é despachado de dentro
  // da página pelo mesmo motivo da checagem M4 — o teclado via CDP não chega ao
  // renderer neste headless.
  await alice.page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await alice.page.locator('.participants-panel').waitFor({ state: 'detached', timeout: 5000 });
  const afterEscape = await spotlightLayout(alice.page);
  check(
    'C9. Em palco estreito o destaque ocupa a largura inteira e a coluna vira painel sob demanda',
    narrowStage.narrow === true &&
    narrowStage.railWidth === null && // nenhuma coluna no fluxo
    narrowStage.toggleCount === 1 &&
    withPanel.panelOpen === true &&
    withPanel.selectableCount === 2 && // a mesma lista, no painel
    afterEscape.panelOpen === false &&
    noPageScroll(narrowLayout) &&
    narrowLayout.controlsBottom <= narrowLayout.innerHeight + 1,
    `estreito=${narrowStage.narrow} coluna=${narrowStage.railWidth} ` +
    `botão=${narrowStage.toggleCount} painel abriu=${withPanel.panelOpen} ` +
    `itens no painel=${withPanel.selectableCount} Esc fechou=${!afterEscape.panelOpen}`,
  );
  await alice.page.setViewportSize(wideViewport);
  await sleep(400);

  // Uma das telas acaba: o destaque migra para a que restou, sem tela em branco
  // e sem voltar para a grade — ainda há o que destacar.
  await bob.page.getByRole('button', { name: 'Parar compartilhamento' }).click();
  const afterBobStopped = await waitFor(
    async () => {
      const now = await spotlightLayout(alice.page);
      return now.active && now.selectableCount === 0 && !now.gridActive ? now : null;
    },
    { timeout: 15000, label: 'o destaque migrar para a tela que restou' },
  ).catch(() => null);
  check(
    'C10. Com a tela em destaque encerrada, o destaque migra para a outra tela ativa',
    !!afterBobStopped && (afterBobStopped.spotlightLabel || '').includes('Carol'),
    `destaque agora: ${JSON.stringify(afterBobStopped?.spotlightLabel)}`,
  );

  // Carol para pelo outro caminho: a barra nativa "Parar compartilhamento" do
  // navegador não é clicável em headless, mas o que ela faz com a página é
  // disparar `ended` na track — que é o gatilho real que o código escuta.
  const endedDispatched = await carol.page.evaluate(() => {
    const track = [...window.__wtkDisplayTracks].find((t) => t.readyState === 'live');
    if (!track) return false;
    track.dispatchEvent(new Event('ended'));
    return true;
  });
  // O timeout vira `false` em vez de exceção: se este caminho quebrar, o certo é
  // a checagem reportar a falha com nome, não a suíte inteira abortar aqui.
  const gridRestored = await waitFor(
    async () => {
      const now = await spotlightLayout(alice.page);
      const tiles = await alice.page.locator('.video-tile').count();
      return now.gridActive && !now.active && tiles === 3;
    },
    { timeout: 15000, label: 'a grade uniforme de volta, sem telas' },
  ).catch(() => false);
  // A track precisa ter sido efetivamente encerrada pelo handler, não só sumido
  // do palco: é o que garante que a captura de tela realmente parou.
  const carolScreenEnded = await carol.page.evaluate(() =>
    [...window.__wtkDisplayTracks].every((t) => t.readyState === 'ended'),
  );
  const carolButtonBack = await carol.page.getByRole('button', { name: 'Compartilhar tela' }).count();
  check(
    'C11. Sem nenhuma tela ativa o palco volta à grade uniforme (inclusive pelo evento ended)',
    endedDispatched && gridRestored && carolScreenEnded && carolButtonBack === 1,
    `ended disparado=${endedDispatched} grade restaurada=${gridRestored} ` +
    `track encerrada=${carolScreenEnded} botão restaurado=${carolButtonBack === 1}`,
  );

  // ------------------------------------------------------------- D. chat
  // O chat divide o palco com a grade: abrir tem que encolher os tiles, não
  // criar scroll de página nem empurrar os controles para fora.
  const beforeChat = await roomLayout(alice.page);
  await alice.page.getByRole('button', { name: /^Chat/ }).click();
  await alice.page.locator('.chat-panel').waitFor({ timeout: 5000 });
  await sleep(400); // uma volta do ResizeObserver
  const withChat = await roomLayout(alice.page);
  check(
    'L5. Abrir o chat encolhe a grade e não gera scroll de página',
    noPageScroll(withChat) &&
    withChat.tileWidth < beforeChat.tileWidth &&
    withChat.controlsBottom <= withChat.innerHeight + 1,
    `tile ${Math.round(beforeChat.tileWidth)}px → ${Math.round(withChat.tileWidth)}px, ` +
    `scrollHeight=${withChat.scrollHeight}/${withChat.innerHeight}`,
  );

  await bob.page.getByRole('button', { name: /^Chat/ }).click();
  await carol.page.getByRole('button', { name: /^Chat/ }).click();

  const secret = `mensagem-p2p-${crypto.randomUUID().slice(0, 8)}`;
  const t0 = Date.now();
  await setInputValue(alice.page.getByLabel('Mensagem'), secret);
  await alice.page.getByRole('button', { name: 'Enviar' }).click();

  await waitFor(
    async () =>
      (await bob.page.locator('.chat-text', { hasText: secret }).count()) > 0 &&
      (await carol.page.locator('.chat-text', { hasText: secret }).count()) > 0,
    { timeout: 5000, label: 'mensagem entregue a Bob e Carol' },
  );
  const deliveryMs = Date.now() - t0;
  check('D1. Mensagem chega a todos os participantes em < 1s', deliveryMs < 1000, `${deliveryMs}ms`);

  const bobMeta = await bob.page.locator('.chat-message').last().evaluate((el) => el.textContent);
  check(
    'D2. Mensagem exibe nome do autor e horário',
    bobMeta.includes('Alice') && /\d{1,2}:\d{2}/.test(bobMeta),
    JSON.stringify(bobMeta.replace(/\n/g, ' | ')),
  );

  const allWire = await wire(alice.page);
  const leaked = allWire.filter((f) => f.data.includes(secret));
  check(
    'D3. Conteúdo do chat NÃO aparece em nenhum frame trocado com o servidor',
    leaked.length === 0,
    `${allWire.length} frames inspecionados (WebSocket + polling), ${allWire.length - chatBefore} deles após o envio`,
  );

  const chatFrames = allWire.filter((f) => /"chat"|chat-message|"message"/i.test(f.data));
  check(
    'D4. Nenhum evento de chat existe no protocolo Socket.IO',
    chatFrames.length === 0,
    chatFrames.slice(0, 2).map((f) => f.data.slice(0, 120)).join(' | '),
  );

  const storageClean = await bob.page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  const persisted = [...storageClean.local, ...storageClean.session].filter((k) => /chat|message/i.test(k));
  check(
    'D5. Nada de chat em localStorage/sessionStorage',
    persisted.length === 0,
    `local=${JSON.stringify(storageClean.local)} session=${JSON.stringify(storageClean.session)}`,
  );

  // Bob recarrega: volta como um socket novo, então Alice precisa aprovar de
  // novo — daí o loop de aprovação enquanto esperamos ele voltar à chamada.
  await bob.page.reload();
  await waitFor(
    async () => {
      await approveAll(alice.page);
      return (await bob.page.getByRole('button', { name: /^Chat/ }).count()) > 0;
    },
    { timeout: 40000, label: 'Bob de volta na chamada após reload' },
  );
  await bob.page.getByRole('button', { name: /^Chat/ }).click();
  const afterReload = await bob.page.locator('.chat-text').count();
  check('D6. Recarregar a página apaga o histórico por completo', afterReload === 0, `mensagens=${afterReload}`);

  await waitFor(everyoneConnected, { timeout: 45000, label: 'mesh reconectado após reload de Bob' });

  // ----------------------------------------------------------- E. câmera
  const gumBefore = await alice.page.evaluate(() => window.__wtkCounters.getUserMedia);
  const sldBeforeCam = await alice.page.evaluate(() => window.__wtkCounters.setLocalDescription);

  await alice.page.getByRole('button', { name: 'Desligar câmera' }).click();
  await alice.page.getByRole('button', { name: 'Ativar câmera' }).waitFor({ timeout: 5000 });
  await sleep(300);

  const stoppedTracks = await alice.page.evaluate(() =>
    window.__wtkTrackStates().filter((t) => t.kind === 'video' && t.readyState === 'ended').length,
  );
  check(
    'E1. Desligar a câmera chama track.stop() (readyState "ended" → LED apaga)',
    stoppedTracks >= 1,
    `tracks de vídeo encerradas=${stoppedTracks}`,
  );

  const aliceSenders = (await peerStats(alice.page)).map((s) => s.senders.filter((x) => x.kind === 'video').length);
  check(
    'E2. replaceTrack(null): nenhum sender de vídeo de câmera com track em Alice',
    aliceSenders.every((n) => n === 0),
    `senders de vídeo por peer=${JSON.stringify(aliceSenders)}`,
  );

  const aliceTileInBob = bob.page.locator('.video-tile').filter({ hasText: 'Alice' });
  await waitFor(
    async () => (await aliceTileInBob.locator('.video-placeholder').count()) === 1,
    { timeout: 10000, label: 'placeholder no tile da Alice, visto por Bob' },
  );
  check('E3. Peers remotos mostram placeholder (deixam de receber vídeo)', true);

  const stillUpAfterCamOff = await everyoneConnected();
  check('E4. A chamada não cai ao desligar a câmera', stillUpAfterCamOff);

  const audioAlive = await alice.page.evaluate(() =>
    window.__wtkTrackStates().some((t) => t.kind === 'audio' && t.readyState === 'live'),
  );
  check('E5. Áudio continua vivo com a câmera desligada', audioAlive);

  await alice.page.getByRole('button', { name: 'Ativar câmera' }).click();
  await alice.page.getByRole('button', { name: 'Desligar câmera' }).waitFor({ timeout: 10000 });
  await sleep(500);

  const gumAfter = await alice.page.evaluate(() => window.__wtkCounters.getUserMedia);
  check(
    'E6. Religar faz um novo getUserMedia({video:true})',
    gumAfter === gumBefore + 1,
    `getUserMedia: ${gumBefore} → ${gumAfter}`,
  );

  const sendersBack = (await peerStats(alice.page)).map((s) => s.senders.filter((x) => x.kind === 'video').length);
  check(
    'E7. Track novo aplicado via replaceTrack em todos os senders de vídeo do mesh',
    sendersBack.length === 2 && sendersBack.every((n) => n === 1),
    `senders de vídeo por peer=${JSON.stringify(sendersBack)}`,
  );

  const sldAfterCam = await alice.page.evaluate(() => window.__wtkCounters.setLocalDescription);
  check(
    'E8. Ciclo desligar/religar câmera sem nenhuma renegociação de SDP',
    sldAfterCam === sldBeforeCam,
    `setLocalDescription: ${sldBeforeCam} → ${sldAfterCam}`,
  );

  const audioStillAlive = await alice.page.evaluate(() =>
    window.__wtkTrackStates().some((t) => t.kind === 'audio' && t.readyState === 'live'),
  );
  check('E9. Áudio não caiu no ciclo de câmera', audioStillAlive);

  // ------------------------------------- S. modal de configurações de mídia
  // Os dispositivos são simulados pelo harness: a flag de câmera falsa do
  // Chromium expõe exatamente um device de cada tipo, e não existe flag para um
  // segundo — sem a simulação, "trocar de câmera" é inexecutável no navegador.
  const readPrefs = (page) =>
    page.evaluate(() => JSON.parse(localStorage.getItem('wtk-meet:devices') || 'null'));
  const kindIds = (snapshot, kind) =>
    new Set(snapshot.flat().filter((t) => t.kind === kind).map((t) => t.id));

  const sdpBeforeSwap = await alice.page.evaluate(() => ({
    local: window.__wtkCounters.setLocalDescription,
    remote: window.__wtkCounters.setRemoteDescription,
  }));
  const tracksBeforeSwap = await senderTracks(alice.page);

  await openSettings(alice.page);

  const modalState = await alice.page.evaluate(() => {
    const dialog = document.querySelector('.settings-modal');
    const [video, audio, output] = dialog.querySelectorAll('select');
    const read = (el) => [...el.options].map((o) => ({ value: o.value, label: o.textContent }));
    return {
      role: dialog.getAttribute('role'),
      ariaModal: dialog.getAttribute('aria-modal'),
      hasLabel: !!document.getElementById(dialog.getAttribute('aria-labelledby') || ''),
      focusOnFirstField: document.activeElement === video,
      video: read(video),
      audio: read(audio),
      output: read(output),
      // O empilhamento importa: configurações abaixo do pedido de entrada, acima
      // dos toasts.
      backdropZ: Number(getComputedStyle(document.querySelector('.modal-backdrop.settings')).zIndex),
      audioContexts: window.__wtkAudioContexts.length,
      previewPlaying: !!document.querySelector('.settings-preview video')?.srcObject,
    };
  });
  const noDupes = (list) => new Set(list.map((o) => o.value)).size === list.length;
  check(
    'S1. O modal lista os três kinds com rótulos reais, sem duplicatas e com "Padrão do sistema" na frente',
    modalState.video.length === 3 &&
    modalState.audio.length === 3 &&
    modalState.output.length === 3 &&
    [modalState.video, modalState.audio, modalState.output].every(
      (l) => noDupes(l) && l[0].value === '' && /Padrão do sistema/.test(l[0].label),
    ) &&
    modalState.video.some((o) => o.value === 'cam-b' && /Câmera Falsa B/.test(o.label)) &&
    modalState.audio.some((o) => o.value === 'mic-b' && /Microfone Falso B/.test(o.label)) &&
    modalState.output.some((o) => o.value === 'spk-b' && /Saída Falsa B/.test(o.label)),
    `câmeras=${JSON.stringify(modalState.video.map((o) => o.label))} ` +
    `mics=${JSON.stringify(modalState.audio.map((o) => o.label))} ` +
    `saídas=${JSON.stringify(modalState.output.map((o) => o.label))}`,
  );
  check(
    'S2. O modal é acessível, tem preview ao vivo e não cria um segundo AudioContext',
    modalState.role === 'dialog' &&
    modalState.ariaModal === 'true' &&
    modalState.hasLabel &&
    modalState.focusOnFirstField &&
    modalState.previewPlaying &&
    modalState.audioContexts === 1 &&
    modalState.backdropZ === 28,
    `role=${modalState.role} foco no 1º campo=${modalState.focusOnFirstField} ` +
    `preview=${modalState.previewPlaying} AudioContexts=${modalState.audioContexts} z=${modalState.backdropZ}`,
  );

  const selects = alice.page.locator('.settings-modal select');
  await setSelectValue(selects.nth(0), 'cam-b');
  await setSelectValue(selects.nth(1), 'mic-b');
  await sleep(600); // o preview reinicia a cada mudança de seleção pendente

  const previewTracksOpen = await alice.page.evaluate(
    () => window.__wtkTrackStates().filter((t) => t.readyState === 'live').length,
  );
  await alice.page.getByRole('button', { name: 'Salvar' }).click();
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 10000 });
  await sleep(1200);

  const tracksAfterSwap = await senderTracks(alice.page);
  const sdpAfterSwap = await alice.page.evaluate(() => ({
    local: window.__wtkCounters.setLocalDescription,
    remote: window.__wtkCounters.setRemoteDescription,
  }));

  const videoBefore = kindIds(tracksBeforeSwap, 'video');
  const videoAfter = kindIds(tracksAfterSwap, 'video');
  const audioBefore = kindIds(tracksBeforeSwap, 'audio');
  const audioAfter = kindIds(tracksAfterSwap, 'audio');
  const disjoint = (a, b) => [...a].every((id) => !b.has(id));
  check(
    'S3. Salvar troca o track em TODOS os senders do mesh (câmera e microfone)',
    tracksAfterSwap.length === 2 &&
    tracksAfterSwap.every(
      (peer) =>
        peer.filter((t) => t.kind === 'video').length === 1 &&
        peer.filter((t) => t.kind === 'audio').length === 1,
    ) &&
    videoAfter.size === 1 &&
    audioAfter.size === 1 &&
    disjoint(videoBefore, videoAfter) &&
    disjoint(audioBefore, audioAfter),
    `vídeo ${JSON.stringify([...videoBefore])} → ${JSON.stringify([...videoAfter])}, ` +
    `áudio ${JSON.stringify([...audioBefore])} → ${JSON.stringify([...audioAfter])}`,
  );
  check(
    'S4. A troca de dispositivo não renegocia SDP (replaceTrack em transceiver já negociado)',
    sdpAfterSwap.local === sdpBeforeSwap.local && sdpAfterSwap.remote === sdpBeforeSwap.remote,
    `setLocalDescription: ${sdpBeforeSwap.local} → ${sdpAfterSwap.local}, ` +
    `setRemoteDescription: ${sdpBeforeSwap.remote} → ${sdpAfterSwap.remote}`,
  );
  check('S5. Nenhuma conexão cai na troca de dispositivo', await everyoneConnected());

  const asked = await alice.page.evaluate(() => window.__wtkCounters.gumRequests);
  check(
    'S6. O getUserMedia da troca pediu exatamente os deviceId escolhidos',
    asked.some((r) => r.video === 'cam-b') && asked.some((r) => r.audio === 'mic-b'),
    `últimos pedidos=${JSON.stringify(asked.slice(-4))}`,
  );

  const savedPrefs = await readPrefs(alice.page);
  check(
    'S7. A preferência é gravada em localStorage["wtk-meet:devices"] com exatamente as quatro chaves',
    savedPrefs &&
    savedPrefs.videoInputId === 'cam-b' &&
    savedPrefs.audioInputId === 'mic-b' &&
    Object.keys(savedPrefs).sort().join() ===
    'audioInputId,audioOutputId,soundsEnabled,videoInputId',
    JSON.stringify(savedPrefs),
  );

  // ------------------------------------------------------ S. cancelamento
  await openSettings(alice.page);
  await setSelectValue(alice.page.locator('.settings-modal select').nth(0), 'cam-a');
  await sleep(600);
  await alice.page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(400);

  const afterCancel = await readPrefs(alice.page);
  const liveAfterCancel = await alice.page.evaluate(
    () => window.__wtkTrackStates().filter((t) => t.readyState === 'live').length,
  );
  const sendersAfterCancel = await senderTracks(alice.page);
  check(
    'S8. Esc descarta a seleção, para o stream de preview e mantém os devices em uso',
    afterCancel.videoInputId === 'cam-b' &&
    disjoint(kindIds(sendersAfterCancel, 'video'), videoBefore) &&
    kindIds(sendersAfterCancel, 'video').size === 1 &&
    [...kindIds(sendersAfterCancel, 'video')][0] === [...videoAfter][0] &&
    liveAfterCancel < previewTracksOpen,
    `preferência=${afterCancel.videoInputId} tracks vivas: ${previewTracksOpen} (modal aberto) → ` +
    `${liveAfterCancel} (fechado)`,
  );

  // Clique no backdrop é a terceira via de saída (junto de "Cancelar" e Esc). O
  // clique vai num canto: o centro do backdrop é onde o próprio modal está.
  await openSettings(alice.page);
  await setSelectValue(alice.page.locator('.settings-modal select').nth(1), 'mic-a');
  await alice.page.locator('.modal-backdrop.settings').click({ position: { x: 4, y: 4 } });
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(300);
  const afterBackdrop = await readPrefs(alice.page);
  check(
    'S8b. Clique no backdrop também descarta a seleção pendente',
    afterBackdrop.audioInputId === 'mic-b',
    `microfone gravado=${afterBackdrop.audioInputId} (a seleção descartada era mic-a)`,
  );

  // ------------------------------------------------------ S. saída de áudio
  await openSettings(alice.page);
  await setSelectValue(alice.page.locator('.settings-modal select').nth(2), 'spk-b');
  await alice.page.getByRole('button', { name: 'Salvar' }).click();
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(500);

  // Reescrita na WTK-MEET-16. Antes esta checagem contava `.video-tile video` e
  // exigia `calls >= tiles` — e passava verde afirmando algo falso: o
  // `setSinkId` era aplicado no `<video>` do tile, que é `muted` fixo, então a
  // chamada tinha sucesso e não produzia som nenhum. O seletor "Saída de áudio"
  // não tinha efeito sobre a voz de ninguém, e a suíte dizia que tinha.
  //
  // Agora afirma o que passou a ser verdade: o sink é aplicado em cada `<audio>`
  // de peer, e em **nenhum** `<video>`. A segunda metade é o que impede a
  // regressão de voltar; afrouxar para `calls > 0` passaria com a música sozinha
  // e o defeito inteiro de volta.
  const sinkState = await alice.page.evaluate(() => {
    const chosen = window.__wtkSinkIds.filter((c) => c.sinkId === 'spk-b');
    return {
      audio: chosen.filter((c) => c.tag === 'AUDIO').length,
      video: window.__wtkSinkIds.filter((c) => c.tag === 'VIDEO').length,
      peers: document.querySelectorAll('.peer-audio-sinks audio').length,
      tiles: document.querySelectorAll('.video-tile video').length,
      saved: JSON.parse(localStorage.getItem('wtk-meet:devices')).audioOutputId,
    };
  });
  check(
    'S9. A saída escolhida é aplicada com setSinkId nos <audio> que produzem som, e em nenhum <video>',
    sinkState.peers > 0 &&
      sinkState.audio >= sinkState.peers &&
      sinkState.video === 0 &&
      sinkState.saved === 'spk-b',
    `setSinkId('spk-b') em ${sinkState.audio} <audio> para ${sinkState.peers} peers, ` +
    `${sinkState.video} chamadas em <video> (esperado 0), ${sinkState.tiles} tiles, salvo=${sinkState.saved}`,
  );

  // ------------------------------------- S. trocar de mic estando silenciado
  // `exact` obrigatório: a barra tem "Silenciar" (microfone) e "Silenciar
  // avisos" (bipe), e o seletor solto casa os dois — erro de strict mode que
  // aborta a suíte inteira aqui, longe da causa.
  await alice.page.getByRole('button', { name: 'Silenciar', exact: true }).click();
  await alice.page.getByRole('button', { name: 'Ativar mic' }).waitFor({ timeout: 5000 });
  await openSettings(alice.page);
  await setSelectValue(alice.page.locator('.settings-modal select').nth(1), 'mic-a');
  await sleep(600);
  await alice.page.getByRole('button', { name: 'Salvar' }).click();
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(1000);

  const mutedSwap = await senderTracks(alice.page);
  const stillMuted = await alice.page.getByRole('button', { name: 'Ativar mic' }).count();
  check(
    'S10. Trocar de microfone estando mudo gera track novo já com enabled=false (continua mudo)',
    mutedSwap.length === 2 &&
    mutedSwap.every((peer) => peer.some((t) => t.kind === 'audio' && t.enabled === false)) &&
    disjoint(kindIds(mutedSwap, 'audio'), audioAfter) &&
    stillMuted === 1,
    `áudio ${JSON.stringify([...audioAfter])} → ${JSON.stringify([...kindIds(mutedSwap, 'audio')])}, ` +
    `botão "Ativar mic" presente=${stillMuted === 1}`,
  );
  await alice.page.getByRole('button', { name: 'Ativar mic' }).click();
  await alice.page.getByRole('button', { name: 'Silenciar', exact: true }).waitFor({ timeout: 5000 });

  // ------------------------------ S. trocar de câmera com a câmera desligada
  await alice.page.getByRole('button', { name: 'Desligar câmera' }).click();
  await alice.page.getByRole('button', { name: 'Ativar câmera' }).waitFor({ timeout: 5000 });
  await openSettings(alice.page);
  // Medido com o modal já aberto: o preview do microfone (a câmera está
  // desligada, então ele não pede vídeo) é uma ação à parte do "Salvar".
  const gumBeforeSave = await alice.page.evaluate(() => window.__wtkCounters.getUserMedia);
  await setSelectValue(alice.page.locator('.settings-modal select').nth(0), 'cam-a');
  await alice.page.getByRole('button', { name: 'Salvar' }).click();
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(800);

  const camOffSwap = await alice.page.evaluate(() => ({
    gum: window.__wtkCounters.getUserMedia,
    videoRequests: window.__wtkCounters.gumRequests.filter((r) => r.video !== null).length,
    liveVideo: window.__wtkTrackStates().filter((t) => t.kind === 'video' && t.readyState === 'live')
      .length,
    saved: JSON.parse(localStorage.getItem('wtk-meet:devices')).videoInputId,
  }));
  check(
    'S11. Com a câmera desligada, trocar de câmera só grava a preferência — o LED não acende',
    camOffSwap.gum === gumBeforeSave && camOffSwap.liveVideo === 0 && camOffSwap.saved === 'cam-a',
    `getUserMedia ${gumBeforeSave} → ${camOffSwap.gum}, tracks de vídeo vivas=${camOffSwap.liveVideo}, ` +
    `preferência=${camOffSwap.saved}`,
  );

  await alice.page.getByRole('button', { name: 'Ativar câmera' }).click();
  await alice.page.getByRole('button', { name: 'Desligar câmera' }).waitFor({ timeout: 10000 });
  await sleep(600);
  const relit = await alice.page.evaluate(() => window.__wtkCounters.gumRequests.at(-1));
  check(
    'S12. Religar a câmera usa a preferência escolhida enquanto ela estava desligada',
    relit.video === 'cam-a',
    `último pedido=${JSON.stringify(relit)}`,
  );

  // ------------------------------- S. persistência lida num documento novo
  // Um documento novo no mesmo perfil é o teste honesto de "sobrevive a reload
  // e a fechar/reabrir o navegador": nada da sessão anterior está na memória, e
  // a única fonte possível para a seleção é o localStorage.
  const homePage = await alice.context.newPage();
  await homePage.goto(CLIENT_ORIGIN);
  await homePage.locator('main.home').waitFor({ timeout: 10000 });
  await openSettings(homePage, { source: 'main.home' });
  const restored = await homePage.evaluate(() => {
    const [video, audio, output] = document.querySelectorAll('.settings-modal select');
    return {
      stored: JSON.parse(localStorage.getItem('wtk-meet:devices') || 'null'),
      video: video.value,
      audio: audio.value,
      output: output.value,
      // Rótulos reais dependem de permissão concedida — e é o preview que a
      // concede, o que só funciona se ele vier ANTES do enumerateDevices.
      labelled: [...video.options].every((o) => o.textContent.trim().length > 0),
    };
  });
  check(
    'S15. A preferência é lida do localStorage num documento novo, e o modal abre na seleção salva',
    restored.stored &&
    restored.video === restored.stored.videoInputId &&
    restored.audio === restored.stored.audioInputId &&
    restored.output === restored.stored.audioOutputId &&
    restored.video === 'cam-a' &&
    restored.output === 'spk-b' &&
    restored.labelled,
    `gravado=${JSON.stringify(restored.stored)} seletores=${restored.video}/${restored.audio}/${restored.output}`,
  );
  await homePage.close();

  // --------------------------------------------------- S. devicechange
  await openSettings(alice.page);
  await alice.page.evaluate(() =>
    window.__wtkAddDevice({
      deviceId: 'cam-c',
      kind: 'videoinput',
      label: 'Câmera Falsa C',
      groupId: 'grp-c',
    }),
  );
  const appeared = await waitFor(
    async () =>
      alice.page.evaluate(() =>
        [...document.querySelectorAll('.settings-modal select')[0].options].some(
          (o) => o.value === 'cam-c',
        ),
      ),
    { timeout: 8000, label: 'opção do device conectado aparecer no modal' },
  ).catch(() => false);
  check(
    'S13. Conectar um dispositivo com o modal aberto atualiza a lista (devicechange), sem reabrir',
    appeared === true,
  );

  // O device em uso é arrancado: o navegador encerra o track e não migra
  // sozinho — quem repõe é a aplicação.
  await alice.page.evaluate(() => window.__wtkRemoveDevice('mic-a'));
  const recovered = await waitFor(
    async () => {
      const state = await alice.page.evaluate(() => ({
        saved: JSON.parse(localStorage.getItem('wtk-meet:devices')).audioInputId,
        warning: document.querySelector('.warning')?.textContent || '',
        audioLive: window
          .__wtkTrackStates()
          .filter((t) => t.kind === 'audio' && t.readyState === 'live').length,
      }));
      return state.saved === '' && /desconectad/i.test(state.warning) ? state : false;
    },
    { timeout: 12000, label: 'recuperação do microfone removido' },
  ).catch(() => false);
  check(
    'S14. Remover o dispositivo em uso cai para o padrão do sistema e avisa na tela',
    recovered !== false && recovered.audioLive > 0,
    recovered === false
      ? 'a preferência não voltou ao padrão ou nenhum aviso foi exibido'
      : `preferência="${recovered.saved}" aviso=${JSON.stringify(recovered.warning)} ` +
      `tracks de áudio vivas=${recovered.audioLive}`,
  );

  await alice.page.getByRole('button', { name: 'Cancelar' }).click();
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  // ----------------------------------------------------------- N. música
  // O roteiro cobre o caminho que só existe com três pessoas de verdade:
  // votação da sala, fila convergente e áudio saindo pelo quarto canal.

  const controlButtons = await alice.page.locator('.controls button').allTextContents();
  check(
    'N1. Botão "Música" entra na barra sem alterar o texto dos botões existentes',
    controlButtons.includes('Música') &&
    controlButtons.includes('Silenciar') &&
    controlButtons.some((t) => t === 'Chat' || t.startsWith('Chat')),
    JSON.stringify(controlButtons),
  );

  // Alice propõe. Em Bob e Carol tem que aparecer um card — e a tela **não**
  // pode ficar bloqueada: música não é pedido de entrada, ignorar não deixa
  // ninguém preso do lado de fora.
  await alice.page.getByRole('button', { name: 'Música' }).click();
  await waitFor(
    async () =>
      (await bob.page.locator('.music-vote-card').count()) === 1 &&
      (await carol.page.locator('.music-vote-card').count()) === 1,
    { timeout: 10000, label: 'card de votação em Bob e Carol' },
  );
  const cardText = await bob.page.locator('.music-vote-card').innerText();
  // Usar a sala com a votação aberta não pode custar o voto: o card fica no
  // canto, não intercepta clique nenhum, e "cliquei em Silenciar" não é
  // "quis fechar a votação".
  await bob.page.getByRole('button', { name: 'Silenciar', exact: true }).click();
  const micToggled = await bob.page.getByRole('button', { name: 'Ativar mic' }).count();
  await bob.page.getByRole('button', { name: 'Ativar mic' }).click();
  await sleep(300);
  const cardSurvived = await bob.page.locator('.music-vote-card').count();
  check(
    'N2. Votação é um card não-bloqueante: dá para usar a sala sem perder o voto',
    cardText.includes('Alice') &&
    /\d+s para votar/.test(cardText) &&
    micToggled === 1 &&
    cardSurvived === 1,
    `${JSON.stringify(cardText.replace(/\n/g, ' | '))} mic clicável=${micToggled === 1} ` +
    `card sobreviveu=${cardSurvived === 1}`,
  );

  // 2 sim (Alice, Bob) e 1 não (Carol): maioria dos válidos com quórum. O "não"
  // fecha a votação antes do prazo, porque todo mundo já se manifestou.
  await bob.page.locator('.music-vote-card').getByRole('button', { name: 'Sim' }).click();
  await carol.page.locator('.music-vote-card').getByRole('button', { name: 'Não' }).click();

  const musicFixture = writeAudioFixture('e2e-music-a.wav', { seconds: 40, freq: 440 });
  const musicFixtureB = writeAudioFixture('e2e-music-b.wav', { seconds: 40, freq: 660 });

  async function openMusicPanel(participant) {
    await waitFor(
      async () => {
        if ((await participant.page.locator('.music-panel').count()) === 1) return true;
        await participant.page.getByRole('button', { name: 'Música' }).click();
        await sleep(300);
        return (await participant.page.locator('.music-panel').count()) === 1;
      },
      { timeout: 15000, label: `painel de música de ${participant.name}` },
    );
  }

  await openMusicPanel(alice);
  await openMusicPanel(bob);
  await openMusicPanel(carol);
  check('N3. Aprovada por maioria, a votação habilita o player nos três participantes', true);

  // Abrir o player fecha o chat e não pode ressuscitar o scroll de página: dois
  // painéis no palco espremeriam os tiles até o piso de legibilidade.
  const withMusic = await roomLayout(alice.page);
  const chatStillOpen = await alice.page.locator('.chat-panel').count();
  check(
    'N4. Abrir a música fecha o chat e a página continua sem rolar',
    chatStillOpen === 0 &&
    noPageScroll(withMusic) &&
    withMusic.controlsBottom <= withMusic.innerHeight + 1,
    `chat aberto=${chatStillOpen} scrollHeight=${withMusic.scrollHeight}/${withMusic.innerHeight} ` +
    `controls.bottom=${Math.round(withMusic.controlsBottom)}`,
  );

  // Alice e Bob adicionam uma faixa cada, quase ao mesmo tempo. Os três têm que
  // exibir as duas na **mesma** ordem — é a ordem total por (lamport, autor, id).
  await setInputValue(alice.page.getByLabel('Adicionar faixa por link'), musicFixture);
  await setInputValue(bob.page.getByLabel('Adicionar faixa por link'), musicFixtureB);
  await alice.page.locator('.music-composer').getByRole('button', { name: 'Adicionar' }).click();
  await bob.page.locator('.music-composer').getByRole('button', { name: 'Adicionar' }).click();

  const queueOf = async (participant) =>
    participant.page.locator('.music-queue-item .music-queue-title').allTextContents();
  const queues = await waitFor(
    async () => {
      const all = await Promise.all([queueOf(alice), queueOf(bob), queueOf(carol)]);
      return all.every((q) => q.length === 2) ? all : false;
    },
    { timeout: 20000, label: 'as duas faixas na fila dos três participantes' },
  );
  check(
    'N5. Faixas adicionadas por dois participantes aparecem na mesma ordem nos três',
    JSON.stringify(queues[0]) === JSON.stringify(queues[1]) &&
    JSON.stringify(queues[1]) === JSON.stringify(queues[2]),
    queues.map((q) => JSON.stringify(q)).join(' vs '),
  );

  // O áudio da faixa de Alice tem que chegar pelo **quarto** canal (o dedicado a
  // música), não pelo do microfone. Medir por mid é o que distingue os dois: se a
  // música vazasse para o canal de voz, o teste passaria por acidente.
  const musicBytes = await waitFor(
    async () => {
      const value = await bob.page.evaluate(async () => {
        const pcs = (window.__wtkPeers || []).filter((pc) => pc.connectionState === 'connected');
        let best = 0;
        for (const pc of pcs) {
          const recv = pc.getTransceivers().filter((t) => t.currentDirection === 'recvonly');
          // Ordem das m-lines: mic, câmera, tela, música.
          const music = recv[3];
          if (!music?.receiver.track) continue;
          const stats = await pc.getStats(music.receiver.track);
          stats.forEach((report) => {
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
              best = Math.max(best, report.bytesReceived || 0);
            }
          });
        }
        return best;
      });
      return value > 2000 ? value : false;
    },
    { timeout: 30000, label: 'áudio de música chegando no quarto canal de Bob' },
  );
  check(
    'N6. O áudio da faixa chega a outro participante pelo canal dedicado de música',
    musicBytes > 2000,
    `bytesReceived no 4º canal=${musicBytes}`,
  );

  // Silenciar o microfone durante a música: o canal é outro, então a música não
  // pode parar. Este é o bug que a decisão do canal dedicado existe para evitar.
  const bytesBeforeMute = musicBytes;
  await alice.page.getByRole('button', { name: 'Silenciar', exact: true }).click();
  await sleep(3000);
  const bytesAfterMute = await bob.page.evaluate(async () => {
    const pcs = (window.__wtkPeers || []).filter((pc) => pc.connectionState === 'connected');
    let best = 0;
    for (const pc of pcs) {
      const music = pc.getTransceivers().filter((t) => t.currentDirection === 'recvonly')[3];
      if (!music?.receiver.track) continue;
      const stats = await pc.getStats(music.receiver.track);
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          best = Math.max(best, report.bytesReceived || 0);
        }
      });
    }
    return best;
  });
  await alice.page.getByRole('button', { name: 'Ativar mic' }).click();
  check(
    'N7. Silenciar o microfone de quem transmite não interrompe a música',
    bytesAfterMute > bytesBeforeMute,
    `bytesReceived ${bytesBeforeMute} → ${bytesAfterMute}`,
  );

  // Pular é aberto: quem não é dono da faixa também pode, e o estado converge.
  const currentBefore = await alice.page.locator('.music-now-title').innerText();
  await carol.page.locator('.music-now').getByRole('button', { name: 'Pular' }).click();
  const currentAfter = await waitFor(
    async () => {
      const titles = await Promise.all(
        [alice, bob, carol].map(async (p) => {
          const n = await p.page.locator('.music-now-title').count();
          return n === 1 ? p.page.locator('.music-now-title').innerText() : null;
        }),
      );
      if (titles.some((t) => t === null || t === currentBefore)) return false;
      return titles.every((t) => t === titles[0]) ? titles[0] : false;
    },
    { timeout: 20000, label: 'a próxima faixa assumindo em todos os participantes' },
  );
  check(
    'N8. Qualquer participante pula a faixa, e a próxima assume nos três',
    currentAfter && currentAfter !== currentBefore,
    `"${currentBefore}" → "${currentAfter}"`,
  );

  const musicWire = (await wire(alice.page)).filter((f) => /music-|"entry"|queue-add/i.test(f.data));
  check(
    'N9. Nenhuma mensagem de música existe no protocolo Socket.IO',
    musicWire.length === 0,
    musicWire.slice(0, 2).map((f) => f.data.slice(0, 120)).join(' | '),
  );

  const musicStorage = await bob.page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
  ]);
  check(
    'N10. Nada de música em localStorage/sessionStorage',
    musicStorage.filter((k) => /music|queue|track|playlist/i.test(k)).length === 0,
    JSON.stringify(musicStorage),
  );

  // Fecha o player nos três: a seção F mede toasts e vazamentos, e um painel
  // aberto muda o palco medido.
  for (const p of [alice, bob, carol]) {
    await p.page.locator('.music-panel').getByRole('button', { name: 'Fechar player' }).click();
  }

  // ------------------------------------------------ F. saída e vazamentos
  // Zera a fila de toasts antes de medir: o reload de Bob (seção D) gera um
  // "Bob saiu da sala" legítimo que pode ainda estar na tela.
  await waitFor(
    async () => (await alice.page.locator('.toast').count()) === 0,
    { timeout: 10000, label: 'fila de toasts esvaziar antes da medição' },
  );

  // Carol sai: Alice e Bob devem ver o toast com o nome.
  const beepsBefore = await alice.page.evaluate(() => window.__wtkCounters.oscillators);
  await carol.page.getByRole('button', { name: 'Sair' }).click();
  const toastText = await waitFor(
    async () => {
      const n = await alice.page.locator('.toast').count();
      return n > 0 ? alice.page.locator('.toast').first().innerText() : false;
    },
    { timeout: 10000, label: 'toast de saída' },
  );
  check('F1. Saída dispara toast com o nome', /Carol saiu da sala/.test(toastText), JSON.stringify(toastText));

  await waitFor(
    async () => (await alice.page.locator('.toast').count()) === 0,
    { timeout: 8000, label: 'toast expirar (~4s)' },
  );
  check('F2. Toast é efêmero (some sozinho em ~4s)', true);

  const beepsAfter = await alice.page.evaluate(() => window.__wtkCounters.oscillators);
  check(
    'F3. O aviso vem acompanhado de um bipe',
    beepsAfter === beepsBefore + 1,
    `osciladores: ${beepsBefore} → ${beepsAfter}`,
  );

  // Silenciar os avisos deve calar o bipe sem calar o toast. O toggle saiu da
  // barra de controles (espaço escasso, e o layout de altura fixa depende de ela
  // não crescer) e agora vive dentro do modal de configurações.
  const soundsInControls = await alice.page
    .locator('.controls')
    .getByRole('button', { name: /avisos/i })
    .count();
  check(
    'F4a. O toggle de avisos sonoros não ocupa mais um slot na barra de controles',
    soundsInControls === 0,
    `botões de aviso na barra=${soundsInControls}`,
  );

  await openSettings(alice.page);
  // Pelo rótulo, e não pela posição: o modal passou a ter dois checkboxes
  // (supressão de ruído e avisos sonoros), e `input[type=checkbox]` sozinho
  // pegaria os dois.
  await alice.page
    .getByRole('checkbox', { name: /avisos sonoros/i })
    .evaluate((box) => {
      box.click();
    });
  await alice.page.getByRole('button', { name: 'Salvar' }).click();
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  const soundsOff = await alice.page.evaluate(
    () => JSON.parse(localStorage.getItem('wtk-meet:devices')).soundsEnabled,
  );
  check(
    'F4b. O toggle de avisos vive no modal e a escolha é persistida',
    soundsOff === false,
    `soundsEnabled=${soundsOff}`,
  );
  const beepsMuted = await alice.page.evaluate(() => window.__wtkCounters.oscillators);
  await bob.page.getByRole('button', { name: 'Sair' }).click();
  const bobToast = await waitFor(
    async () => {
      const n = await alice.page.locator('.toast').count();
      return n > 0 ? alice.page.locator('.toast').first().innerText() : false;
    },
    { timeout: 10000, label: 'toast da saída de Bob' },
  );
  const beepsAfterMuted = await alice.page.evaluate(() => window.__wtkCounters.oscillators);
  check(
    'F4. "Silenciar avisos" cala o bipe mas mantém o toast',
    /Bob saiu da sala/.test(bobToast) && beepsAfterMuted === beepsMuted,
    `toast=${JSON.stringify(bobToast)} osciladores: ${beepsMuted} → ${beepsAfterMuted}`,
  );

  // Carol saiu da sala (voltou para a Home): todos os recursos devem ter sido
  // liberados no unmount do componente Room.
  await sleep(1000);
  const carolLeak = await carol.page.evaluate(async () => {
    const rafBefore = window.__wtkCounters.raf;
    await new Promise((r) => setTimeout(r, 1000));
    return {
      liveTracks: window.__wtkTrackStates().filter((t) => t.readyState === 'live'),
      openPeers: window.__wtkPeers.filter((pc) => pc.connectionState !== 'closed').length,
      audioContextStates: window.__wtkAudioContexts.map((c) => c.state),
      rafPerSecond: window.__wtkCounters.raf - rafBefore,
    };
  });
  check(
    'F5. Ao sair, todos os tracks (câmera, mic, tela) estão "ended" — LED apaga',
    carolLeak.liveTracks.length === 0,
    `tracks vivas=${JSON.stringify(carolLeak.liveTracks)}`,
  );
  check(
    'F6. Ao sair, todas as RTCPeerConnection (e seus data channels) estão fechadas',
    carolLeak.openPeers === 0,
    `pcs abertas=${carolLeak.openPeers}`,
  );
  check(
    'F7. Ao sair, o AudioContext é fechado',
    carolLeak.audioContextStates.every((s) => s === 'closed'),
    `estados=${JSON.stringify(carolLeak.audioContextStates)}`,
  );
  check(
    'F8. Ao sair, o loop de requestAnimationFrame é cancelado',
    carolLeak.rafPerSecond === 0,
    `${carolLeak.rafPerSecond} chamadas/s após sair`,
  );

  const aliceTilesAfterLeave = await alice.page.locator('.video-tile').count();
  check('F9. Grade encolhe quando alguém sai', aliceTilesAfterLeave === 1, `tiles=${aliceTilesAfterLeave}`);

  // ------------------------ M (cont.). fila do modal e desistência do pedido
  // Dois pedidos ao mesmo tempo, e os dois solicitantes desistem antes de
  // qualquer decisão: o modal não pode ficar com botões que não fazem nada.
  // Dave entra com uma preferência obsoleta gravada (o headset ficou na outra
  // máquina): a mídia tem que abrir pelo padrão, sem nenhuma mensagem de erro, e
  // a preferência tem que se corrigir sozinha.
  const dave = await openParticipant(browser, {
    roomUrl,
    name: 'Dave',
    preferences: {
      videoInputId: 'cam-de-outra-maquina',
      audioInputId: 'mic-de-outra-maquina',
      audioOutputId: '',
      soundsEnabled: true,
    },
  });
  const erin = await openParticipant(browser, { roomUrl, name: 'Erin' });

  const stale = await waitFor(
    async () => {
      const state = await dave.page.evaluate(() => ({
        prefs: JSON.parse(localStorage.getItem('wtk-meet:devices') || 'null'),
        warnings: document.querySelectorAll('.warning, .error').length,
        liveTracks: window.__wtkTrackStates().filter((t) => t.readyState === 'live').length,
        askedFor: window.__wtkCounters.gumRequests[0] || null,
      }));
      return state.prefs && state.prefs.videoInputId !== 'cam-de-outra-maquina' ? state : false;
    },
    { timeout: 20000, label: 'preferência obsoleta de Dave se corrigir' },
  ).catch(() => false);
  check(
    'S16. Preferência salva para um device inexistente cai no padrão sem erro visível, e se corrige',
    stale !== false &&
    stale.warnings === 0 &&
    stale.liveTracks > 0 &&
    stale.askedFor?.video === 'cam-de-outra-maquina' &&
    stale.prefs.audioInputId !== 'mic-de-outra-maquina',
    stale === false
      ? 'a preferência obsoleta continuou gravada'
      : `pedido inicial=${JSON.stringify(stale.askedFor)} → gravado=${JSON.stringify(stale.prefs)}, ` +
      `avisos na tela=${stale.warnings} tracks vivas=${stale.liveTracks}`,
  );

  const queued = await waitFor(
    async () => {
      const n = await alice.page.locator('.join-request').count();
      return n >= 2 ? n : false;
    },
    { timeout: 40000, label: 'dois pedidos simultâneos no modal' },
  );
  const queuedNames = await alice.page.locator('.join-request').allInnerTexts();
  check(
    'M5. O modal lista múltiplos pedidos simultâneos, um por linha',
    queued === 2 &&
    queuedNames.some((t) => /Dave/.test(t)) &&
    queuedNames.some((t) => /Erin/.test(t)),
    `pedidos=${queued} ${JSON.stringify(queuedNames.map((t) => t.replace(/\n/g, ' ')))}`,
  );

  await dave.context.close();
  await erin.context.close();
  const modalClosed = await waitFor(
    async () => (await alice.page.locator('.join-request-modal').count()) === 0,
    { timeout: 25000, label: 'modal fechar quando os solicitantes desistem' },
  ).catch(() => false);
  check(
    'M6. O modal fecha sozinho quando os solicitantes desconectam',
    modalClosed === true,
    modalClosed === true ? '' : 'o modal continuou aberto com pedidos que já não podem ser aprovados',
  );

  // ------------------------------------------------- L (cont.). viewport móvel
  // O breakpoint de 720px empilha o chat sobre a grade. É o cenário em que a
  // altura é mais escassa e onde `100vh` (em vez de `100dvh`) esconderia os
  // controles debaixo da barra de endereço.
  //
  // O chat de Alice ficou aberto desde a seção D — fecha aqui para medir os dois
  // estados em sequência (sem chat, depois com chat).
  if ((await roomLayout(alice.page)).chatOpen) {
    await alice.page.getByRole('button', { name: /^Chat/ }).click();
    await alice.page.locator('.chat-panel').waitFor({ state: 'detached', timeout: 5000 });
  }
  await alice.page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  const mobile = await roomLayout(alice.page);
  check(
    'L6. Em viewport móvel a página continua sem rolar e os controles seguem visíveis',
    noPageScroll(mobile) && mobile.controlsBottom <= mobile.innerHeight + 1,
    `scrollHeight=${mobile.scrollHeight}/${mobile.innerHeight} ` +
    `controls.bottom=${Math.round(mobile.controlsBottom)}`,
  );

  await alice.page.getByRole('button', { name: /^Chat/ }).click();
  await alice.page.locator('.chat-panel').waitFor({ timeout: 5000 });
  await sleep(500);
  const mobileChat = await roomLayout(alice.page);
  const stacked = await alice.page.evaluate(() => {
    const grid = document.querySelector('.video-stage')?.getBoundingClientRect();
    const chat = document.querySelector('.chat-panel')?.getBoundingClientRect();
    if (!grid || !chat) return false;
    return chat.top >= grid.bottom - 1; // empilhado, não lado a lado
  });
  // Aqui quem encolhe é a ÁREA da grade, não necessariamente o tile: com um
  // único tile em retrato o limite é a largura, que o empilhamento não muda. O
  // que precisa valer é que a grade cede altura ao chat e o tile continua
  // inteiro dentro dela — sem scroll de página e com os controles alcançáveis.
  check(
    'L7. Em ≤720px o chat empilha abaixo da grade, a grade se reduz e a página continua sem rolar',
    noPageScroll(mobileChat) &&
    stacked &&
    mobileChat.stageHeight < mobile.stageHeight &&
    mobileChat.tileFitsStage === true &&
    mobileChat.controlsBottom <= mobileChat.innerHeight + 1,
    `empilhado=${stacked} área da grade ${Math.round(mobile.stageHeight)}px → ` +
    `${Math.round(mobileChat.stageHeight)}px, tile cabe=${mobileChat.tileFitsStage}, ` +
    `scrollHeight=${mobileChat.scrollHeight}/${mobileChat.innerHeight}`,
  );

  // ------------------------------------------------- R. endereço da sala
  // O link é o produto: um endereço de um segmento na raiz, sem `/room/`, com a
  // chave no fragmento. Estas checagens cobrem o que só o navegador prova — a
  // barra de endereço, o histórico e o que sai no fio — enquanto a gramática em
  // si vive em `client/test/roomSlug.test.mjs` e `roomRouting.test.mjs`.
  const joinFrames = (await wire(alice.page))
    .map((f) => /^\d+\["join-request",(.*)\]$/.exec(f.data)?.[1])
    .filter(Boolean)
    .map((json) => JSON.parse(json))
    // O servidor também **emite** `join-request` para quem aprova; só o payload
    // com `roomId` é o que este cliente pediu.
    .filter((payload) => 'roomId' in payload);
  check(
    'R2. O join-request no fio carrega o path canônico, e nada mais',
    joinFrames.length > 0 && joinFrames.every((p) => p.roomId === roomId),
    `${joinFrames.length} pedido(s): ${JSON.stringify(joinFrames.map((p) => p.roomId))}`,
  );

  // Link antigo, do jeito que ainda circula em conversa — precisa cair na mesma
  // sala de sinalização, não numa sala nova de path "room".
  const frank = await openParticipant(browser, {
    roomUrl: `${CLIENT_ORIGIN}/room/${roomId}#${passphrase}`,
    name: 'Frank',
  });
  const frankUrl = await waitFor(
    async () => {
      const url = frank.page.url();
      return url.includes('/room/') ? false : url;
    },
    { timeout: 15000, label: 'o redirect do link legado' },
  ).catch(() => frank.page.url());
  check(
    'R3. /room/<id>#chave redireciona para /<id>#chave com o fragmento intacto',
    frankUrl === urlEsperada,
    `url=${frankUrl}`,
  );

  await waitInCall(frank, alice);
  const frankNaSala = await waitFor(
    async () => (await alice.page.locator('.video-label').allInnerTexts()).some((t) => /Frank/.test(t)),
    { timeout: 25000, label: 'Frank aparecer na grade de Alice' },
  ).catch(() => false);
  // Nesta altura da suíte só Alice continua na sala (Bob e Carol saíram na
  // seção F), então o mesh de Frank é uma conexão só — o que precisa valer é
  // que ela **conecta**: mesma sala de sinalização, mídia negociada.
  const frankMesh = await waitFor(
    async () => {
      const stats = await peerStats(frank.page);
      return stats.filter((s) => s.connectionState === 'connected').length >= 1;
    },
    { timeout: 45000, label: 'o mesh de Frank conectar' },
  ).catch(() => false);
  const frankTiles = await frank.page.locator('.video-tile').count();
  check(
    'R4. Quem entrou pelo link legado caiu na MESMA sala, com mídia fluindo',
    frankNaSala === true && frankMesh === true && frankTiles >= 2,
    `Frank visível para Alice=${frankNaSala}, mesh conectado=${frankMesh}, ` +
    `tiles na tela de Frank=${frankTiles}`,
  );
  await frank.context.close();

  // Abrir um endereço sem `#` **é** criar a sala: a chave nasce no client e a
  // URL é reescrita com `replace`.
  const semChave = await browser.newContext();
  const semChavePage = await semChave.newPage();
  await semChavePage.goto(`${CLIENT_ORIGIN}/e2e-sala-sem-chave-${sufixo}`);
  const comChave = await waitFor(
    async () => {
      const url = new URL(semChavePage.url());
      return url.hash.length > 1 ? url : false;
    },
    { timeout: 15000, label: 'a passphrase nascer no fragmento' },
  ).catch(() => new URL(semChavePage.url()));
  check(
    'R5. Path sem fragmento ganha passphrase e mantém o mesmo endereço',
    comChave.pathname === `/e2e-sala-sem-chave-${sufixo}` && comChave.hash.length > 1,
    `url=${comChave.href}`,
  );
  // `replace`, não `push`: um Voltar que devolvesse o path sem chave geraria
  // outra chave, e outra, em laço.
  const voltou = await semChavePage.goBack({ timeout: 5000 }).catch(() => null);
  const urlAposVoltar = semChavePage.url();
  check(
    'R6. O redirect da passphrase não deixa entrada no histórico (replace)',
    voltou === null || !urlAposVoltar.endsWith(`/e2e-sala-sem-chave-${sufixo}`),
    `voltou=${voltou !== null} url=${urlAposVoltar}`,
  );

  // Maiúscula na barra de endereço (teclado de celular com autocapitalize) tem
  // que convergir para o mesmo path — senão são duas salas, cada uma vazia.
  await semChavePage.goto(`${CLIENT_ORIGIN}/E2E-Sala-Maiuscula#k`);
  const canonico = await waitFor(
    async () => {
      const url = new URL(semChavePage.url());
      return url.pathname === '/e2e-sala-maiuscula' ? url : false;
    },
    { timeout: 15000, label: 'a canonicalização para minúsculas' },
  ).catch(() => new URL(semChavePage.url()));
  check(
    'R7. Endereço com maiúsculas cai no path canônico, preservando a chave',
    canonico.pathname === '/e2e-sala-maiuscula' && canonico.hash === '#k',
    `url=${canonico.href}`,
  );

  // Rota reservada e multi-segmento não são sala: voltam para a Home.
  const naoSala = [];
  for (const path of ['/assets', '/a/b', '/app/tela-que-nao-existe']) {
    await semChavePage.goto(`${CLIENT_ORIGIN}${path}`);
    const final = await waitFor(
      async () => (new URL(semChavePage.url()).pathname === '/' ? '/' : false),
      { timeout: 10000, label: `${path} voltar para a Home` },
    ).catch(() => new URL(semChavePage.url()).pathname);
    naoSala.push([path, final]);
  }
  check(
    'R8. Reservado e multi-segmento voltam para a Home, sem virar sala',
    naoSala.every(([, final]) => final === '/'),
    naoSala.map(([path, final]) => `${path}→${final}`).join(' '),
  );
  await semChave.close();

  // ------------------------------------------- T. supressão de ruído
  //
  // Browser próprio, sala própria, microfone próprio. Três razões, todas
  // concretas:
  //
  // - `--use-file-for-fake-audio-capture` é flag de **processo**: aplicá-la ao
  //   browser principal trocaria o tom contínuo por ruído para a suíte inteira,
  //   e o tom é justamente o que aciona o anel de fala das checagens B.
  // - o motor precisa ser o **worklet**, e o Chromium suporta a constraint
  //   nativa: sem `__wtkForceWorkletNs` o fallback nunca seria exercitado — e é
  //   o fallback que tem DSP nosso para dar errado.
  // - a medição compara duas janelas do mesmo sinal, então o sinal tem que ser
  //   o mesmo o tempo todo.
  const noiseFile = writeNoiseFixture(path.join(os.tmpdir(), 'wtk-meet-ruido.wav'));
  const noiseBrowser = await launchBrowser({ audioFile: noiseFile });
  let dora = null;
  let elias = null;
  let flavia = null;
  try {
    const salaRuido = `${CLIENT_ORIGIN}/e2e-ruido#chave-do-ruido`;
    const abrirComRuido = (name) =>
      openParticipant(noiseBrowser, { roomUrl: salaRuido, name, forceWorkletNoiseSuppression: true });
    const entrar = (participant, approver) =>
      waitFor(
        async () => {
          if (approver) await approveAll(approver.page);
          return (await participant.page.locator('.room.in-call').count()) > 0;
        },
        { timeout: 40000, label: `${participant.name} entrar na sala de ruído` },
      );

    dora = await abrirComRuido('Dora');
    await entrar(dora, null);
    elias = await abrirComRuido('Elias');
    await entrar(elias, dora);
    flavia = await abrirComRuido('Flavia');
    await entrar(flavia, dora);

    await waitFor(
      async () => {
        for (const p of [dora, elias, flavia]) {
          const stats = await peerStats(p.page);
          if (stats.filter((s) => s.connectionState === 'connected').length !== 2) return false;
        }
        return true;
      },
      { timeout: 45000, label: 'mesh da sala de ruído' },
    );

    // Flavia entra muda: com dois emissores tocando o mesmo ruído, a energia
    // que chega em Elias seria a soma dos dois, e a medição deixaria de ser
    // sobre o microfone de Dora.
    await flavia.page.getByRole('button', { name: 'Silenciar', exact: true }).click();
    await sleep(500);

    const gumDeDora = await dora.page.evaluate(() => window.__wtkCounters.gumRequests);
    check(
      'T1. O primeiro getUserMedia pede supressão de ruído explicitamente',
      gumDeDora[0]?.audioProcessing?.noiseSuppression === true,
      `pedidos=${JSON.stringify(gumDeDora.slice(0, 2))}`,
    );

    // A preferência nasce ligada **por default em memória**, e a chave só é
    // escrita quando alguém escolhe de fato (T6 cobre o depois de salvar).
    // Gravar na entrada materializaria uma escolha que ninguém fez, e o único
    // ganho seria congelar o default de hoje contra uma mudança futura dele —
    // troca ruim para um projeto cuja regra é zero persistência com exceções
    // nomeadas (ARCHITECTURE.md §6.10). Quem prova que o default vale é o T1,
    // no que foi PEDIDO ao getUserMedia; o que se afirma aqui é que a chave de
    // dispositivos não é contaminada, nem por campo nem por valor.
    const prefsDeDora = await dora.page.evaluate(() => localStorage.getItem('wtk-meet:audio'));
    const chavesDeDevices = await dora.page.evaluate(() =>
      Object.keys(JSON.parse(localStorage.getItem('wtk-meet:devices') || '{}')),
    );
    check(
      'T2. Antes de qualquer escolha, nada é gravado e wtk-meet:devices não é contaminado',
      prefsDeDora === null && !chavesDeDevices.includes('noiseSuppression'),
      `wtk-meet:audio=${prefsDeDora} wtk-meet:devices=${JSON.stringify(chavesDeDevices)}`,
    );

    const trackDoGum = await dora.page.evaluate(
      () => window.__wtkTrackStates().filter((t) => t.kind === 'audio').length,
    );
    const senderLigado = (await senderTracks(dora.page)).flat().find((t) => t.kind === 'audio');
    const contextos = await dora.page.evaluate(() => window.__wtkAudioContexts.length);
    check(
      'T3. No modo worklet o mesh transmite o track PROCESSADO, sem um segundo AudioContext',
      // O track do destino não é rastreado por `__wtkLiveTracks` (que só vê
      // getUserMedia/getDisplayMedia), então o id do sender não pode ser o de
      // nenhum track cru conhecido.
      !!senderLigado?.id && contextos === 1 && trackDoGum >= 1,
      `sender=${senderLigado?.id} audioContexts=${contextos}`,
    );

    // ---- janela 1: supressão LIGADA
    const antesLigado = await inboundAudio(elias.page);
    await sleep(6000);
    const depoisLigado = await inboundAudio(elias.page);
    const rmsLigado = rmsBetween(antesLigado, depoisLigado);

    const sdpAntes = await dora.page.evaluate(() => ({
      local: window.__wtkCounters.setLocalDescription,
      remote: window.__wtkCounters.setRemoteDescription,
      negociacoes: window.__wtkCounters.negotiationNeeded,
    }));
    const sendersAntes = (await senderTracks(dora.page)).flat();

    // ---- desliga pelo modal
    await openSettings(dora.page);
    await dora.page.getByRole('checkbox', { name: /supressão de ruído/i }).evaluate((box) => {
      box.click();
    });
    await dora.page.getByRole('button', { name: 'Salvar' }).click();
    await dora.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
    await sleep(1500);

    const sdpDepois = await dora.page.evaluate(() => ({
      local: window.__wtkCounters.setLocalDescription,
      remote: window.__wtkCounters.setRemoteDescription,
      negociacoes: window.__wtkCounters.negotiationNeeded,
    }));
    // `stable` é o estado de quem não tem oferta nem resposta pendente. Junto
    // com os contadores, fecha o cerco: nada terminou, nada foi pedido e nada
    // ficou no meio do caminho.
    const signaling = await dora.page.evaluate(() =>
      (window.__wtkPeers || []).filter((pc) => pc.connectionState !== 'closed').map((pc) => pc.signalingState),
    );
    const sendersDepois = (await senderTracks(dora.page)).flat();
    const audioAntes = sendersAntes.filter((t) => t.kind === 'audio').map((t) => t.id);
    const audioDepois = sendersDepois.filter((t) => t.kind === 'audio').map((t) => t.id);

    check(
      'T4. Alternar o toggle troca o track por replaceTrack, sem renegociar SDP',
      sdpDepois.local === sdpAntes.local &&
      sdpDepois.remote === sdpAntes.remote &&
      sdpDepois.negociacoes === sdpAntes.negociacoes &&
      signaling.length > 0 &&
      signaling.every((state) => state === 'stable') &&
      audioDepois.length === audioAntes.length &&
      audioDepois.length > 0 &&
      audioDepois.every((id, i) => id !== audioAntes[i]),
      `sdp local ${sdpAntes.local}→${sdpDepois.local} remote ${sdpAntes.remote}→${sdpDepois.remote} ` +
      `negotiationneeded ${sdpAntes.negociacoes}→${sdpDepois.negociacoes} ` +
      `signaling=${JSON.stringify(signaling)} ` +
      `tracks ${JSON.stringify(audioAntes)}→${JSON.stringify(audioDepois)}`,
    );

    check(
      'T5. Nenhuma conexão cai ao alternar a supressão',
      (await peerStats(dora.page)).every((s) => s.connectionState === 'connected'),
      JSON.stringify((await peerStats(dora.page)).map((s) => s.connectionState)),
    );

    const prefsDesligada = await dora.page.evaluate(() =>
      JSON.parse(localStorage.getItem('wtk-meet:audio')).noiseSuppression,
    );
    check(
      'T6. Desligar persiste a escolha na chave própria',
      prefsDesligada === false,
      `noiseSuppression=${prefsDesligada}`,
    );

    // ---- janela 2: supressão DESLIGADA, mesma duração
    const antesDesligado = await inboundAudio(elias.page);
    await sleep(6000);
    const depoisDesligado = await inboundAudio(elias.page);
    const rmsDesligado = rmsBetween(antesDesligado, depoisDesligado);

    check(
      'T7. O áudio continua chegando aos peers depois de alternar (bytes subindo, track vivo)',
      depoisDesligado.bytes > antesDesligado.bytes &&
      (await elias.page.evaluate(
        () => window.__wtkTrackStates().filter((t) => t.kind === 'audio' && t.readyState === 'live').length,
      )) > 0,
      `bytes ${antesDesligado.bytes}→${depoisDesligado.bytes}`,
    );

    const reducao = rmsLigado && rmsDesligado ? 20 * Math.log10(rmsDesligado / rmsLigado) : null;
    check(
      'T8. Com supressão ligada o RMS no peer receptor é ao menos 6 dB menor',
      reducao !== null && reducao >= 6,
      `rms ligado=${rmsLigado?.toFixed(5)} desligado=${rmsDesligado?.toFixed(5)} ` +
      `redução=${reducao === null ? 'n/d' : `${reducao.toFixed(2)} dB`}`,
    );

    // ---- religa: o ciclo completo é o que o DoD pede
    await openSettings(dora.page);
    await dora.page.getByRole('checkbox', { name: /supressão de ruído/i }).evaluate((box) => {
      box.click();
    });
    await dora.page.getByRole('button', { name: 'Salvar' }).click();
    await dora.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
    await sleep(1500);

    const antesReligado = await inboundAudio(elias.page);
    await sleep(3000);
    const depoisReligado = await inboundAudio(elias.page);
    check(
      'T9. Religar a supressão mantém o áudio fluindo e a conexão de pé',
      depoisReligado.bytes > antesReligado.bytes &&
      (await peerStats(elias.page)).every((s) => s.connectionState === 'connected'),
      `bytes ${antesReligado.bytes}→${depoisReligado.bytes}`,
    );

    // Mudo + supressão: alternar não pode desmutar ninguém.
    await dora.page.getByRole('button', { name: 'Silenciar', exact: true }).click();
    await openSettings(dora.page);
    await dora.page.getByRole('checkbox', { name: /supressão de ruído/i }).evaluate((box) => {
      box.click();
    });
    await dora.page.getByRole('button', { name: 'Salvar' }).click();
    await dora.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
    await sleep(1000);
    const senderMudo = (await senderTracks(dora.page)).flat().find((t) => t.kind === 'audio');
    check(
      'T10. Alternar a supressão estando mudo não desmuta',
      senderMudo?.enabled === false,
      `sender.enabled=${senderMudo?.enabled} botão="${await dora.page
        .locator('.controls button')
        .first()
        .innerText()}"`,
    );

    // Sair não pode deixar nem o track cru nem o do destino vivos.
    await dora.page.getByRole('button', { name: 'Sair' }).click();
    await sleep(1500);
    const vivosAoSair = await dora.page.evaluate(() =>
      window.__wtkTrackStates().filter((t) => t.readyState === 'live'),
    );
    check(
      'T11. Sair da sala com o worklet ativo não deixa nenhum track vivo',
      vivosAoSair.length === 0,
      JSON.stringify(vivosAoSair),
    );

    for (const p of [dora, elias, flavia]) {
      const relevant = p.consoleErrors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED/i.test(e));
      check(
        `T12. Sem erros de JS no console de ${p.name} (uma rejeição de addModule bastaria)`,
        relevant.length === 0,
        relevant.slice(0, 3).join(' | '),
      );
    }
  } finally {
    await noiseBrowser.close();
  }

  // ------------------- U. áudio dos peers: saída, autoplay e estado da conexão
  //
  // Sala e contextos próprios, pelas mesmas razões do bloco T: este roteiro
  // **bloqueia o autoplay** e **força transições de connectionState**, e as duas
  // coisas contaminariam os participantes principais para todas as checagens
  // seguintes. A sala principal continua intacta.
  //
  // O que se afirma aqui é a última etapa da recepção de áudio — a que
  // transforma o que chega em som. Ela é comum a todos os pares, e é por isso
  // que quebrá-la produzia o sintoma "ele nos ouve e não ouve ninguém".
  let gil = null;
  let helena = null;
  try {
    const salaAudio = `${CLIENT_ORIGIN}/e2e-audio-peers#chave-do-audio`;
    const entrarU = (participant, approver) =>
      waitFor(
        async () => {
          if (approver) await approveAll(approver.page);
          return (await participant.page.locator('.room.in-call').count()) > 0;
        },
        { timeout: 40000, label: `${participant.name} entrar na sala de áudio` },
      );

    // A Gil escolhe a saída **antes** de a Helena existir: é o caso do peer que
    // entra depois da escolha e precisa nascer com o sink já aplicado, sem
    // nenhuma interação nova.
    gil = await openParticipant(browser, { roomUrl: salaAudio, name: 'Gil' });
    await entrarU(gil, null);
    await openSettings(gil.page);
    await setSelectValue(gil.page.locator('.settings-modal select').nth(2), 'spk-b');
    await gil.page.getByRole('button', { name: 'Salvar' }).click();
    await gil.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
    await gil.page.evaluate(() => { window.__wtkSinkIds.length = 0; });

    helena = await openParticipant(browser, { roomUrl: salaAudio, name: 'Helena' });
    await entrarU(helena, gil);
    await waitFor(async () => (await gil.page.locator('.peer-audio-sinks audio').count()) > 0, {
      label: 'o <audio> do peer aparecer para a Gil',
    });
    await sleep(500);

    const nascido = await gil.page.evaluate(() => ({
      audio: window.__wtkSinkIds.filter((c) => c.tag === 'AUDIO' && c.sinkId === 'spk-b').length,
      video: window.__wtkSinkIds.filter((c) => c.tag === 'VIDEO').length,
      elementos: document.querySelectorAll('.peer-audio-sinks audio').length,
      mudos: [...document.querySelectorAll('.peer-audio-sinks audio')].filter((a) => a.muted).length,
    }));
    check(
      'U1. Um peer que entra depois da escolha nasce com a saída já aplicada, e em nenhum <video>',
      nascido.audio >= nascido.elementos && nascido.elementos > 0 && nascido.video === 0 &&
        nascido.mudos === 0,
      `${nascido.audio} chamadas em <audio> para ${nascido.elementos} elementos, ` +
      `${nascido.video} em <video> (esperado 0), ${nascido.mudos} elementos mudos (esperado 0)`,
    );

    // Voltar para "Padrão do sistema" é trabalho de verdade para quem já recebeu
    // um sink — e nada para quem nunca recebeu.
    await gil.page.evaluate(() => { window.__wtkSinkIds.length = 0; });
    await openSettings(gil.page);
    await setSelectValue(gil.page.locator('.settings-modal select').nth(2), '');
    await gil.page.getByRole('button', { name: 'Salvar' }).click();
    await gil.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
    await sleep(500);
    const voltou = await gil.page.evaluate(() => ({
      padrao: window.__wtkSinkIds.filter((c) => c.sinkId === '').length,
      outros: window.__wtkSinkIds.filter((c) => c.sinkId !== '').length,
      salvo: JSON.parse(localStorage.getItem('wtk-meet:devices')).audioOutputId,
    }));
    check(
      'U2. Voltar para o padrão do sistema chama setSinkId(\'\') em quem já tinha sink',
      voltou.padrao > 0 && voltou.outros === 0 && voltou.salvo === '',
      `${voltou.padrao} chamadas com '', ${voltou.outros} com outro id, salvo="${voltou.salvo}"`,
    );

    // ---- estado da conexão no tile
    const semIndicador = await gil.page.evaluate(() => ({
      chips: document.querySelectorAll('.tile-connection').length,
      tiles: document.querySelectorAll('.video-tile').length,
    }));
    check(
      'U3. Com o mesh saudável, nenhum tile exibe indicador de conexão',
      semIndicador.chips === 0 && semIndicador.tiles >= 2,
      `${semIndicador.chips} indicadores em ${semIndicador.tiles} tiles`,
    );

    // Os rótulos antes e depois: a contagem de tiles e o texto de `.video-label`
    // são premissa de blocos que não são deste roteiro (R11).
    const antes = await gil.page.evaluate(() => ({
      tiles: document.querySelectorAll('.video-tile').length,
      labels: [...document.querySelectorAll('.video-label')].map((n) => n.textContent),
    }));

    /** Força o estado numa das conexões da página, pelo handler real da app. */
    const forcar = (page, state) =>
      page.evaluate((s) => {
        window.__wtkPeers[0].__wtkForceState(s);
      }, state);

    for (const [state, rotulo, nivel] of [
      ['connecting', 'Conectando…', 'warn'],
      ['disconnected', 'Instável', 'warn'],
      ['failed', 'Sem conexão', 'bad'],
    ]) {
      await forcar(gil.page, state);
      const visto = await waitFor(
        async () => {
          const found = await gil.page.evaluate(() => {
            const chip = document.querySelector('.tile-connection');
            return chip
              ? {
                  texto: chip.textContent,
                  nivel: chip.className.replace('tile-connection ', ''),
                  quantos: document.querySelectorAll('.tile-connection').length,
                  raiz: document.querySelectorAll('.video-tile.conn-warn, .video-tile.conn-bad').length,
                }
              : null;
          });
          return found && found.texto === rotulo ? found : false;
        },
        { timeout: 8000, label: `o tile mostrar "${rotulo}"` },
      );
      check(
        `U4${state[0]}. ${state} aparece no tile como "${rotulo}", em um tile só`,
        visto.texto === rotulo && visto.nivel === nivel && visto.quantos === 1 && visto.raiz === 1,
        `texto="${visto.texto}" nível=${visto.nivel} indicadores=${visto.quantos} tiles marcados=${visto.raiz}`,
      );
    }

    // O tile local não pode ter indicador: não existe `RTCPeerConnection`
    // consigo mesmo, e um chip ali seria uma afirmação sem fonte.
    const local = await gil.page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.video-tile')];
      const meu = tiles.find((t) => /\(você\)/.test(t.querySelector('.video-label')?.textContent || ''));
      return { achou: !!meu, chip: meu ? meu.querySelectorAll('.tile-connection').length : -1 };
    });
    check(
      'U5. O tile local nunca exibe indicador de conexão',
      local.achou && local.chip === 0,
      `tile local encontrado=${local.achou}, indicadores nele=${local.chip}`,
    );

    // Voltar a `connected` apaga o indicador — sem recarregar a página.
    await forcar(gil.page, 'connected');
    const limpou = await waitFor(
      async () => (await gil.page.locator('.tile-connection').count()) === 0,
      { timeout: 8000, label: 'o indicador sumir ao voltar para connected' },
    ).then(() => true).catch(() => false);
    check(
      'U6. Voltando para connected, o indicador some sem recarregar a página',
      limpou,
    );

    const depois = await gil.page.evaluate(() => ({
      tiles: document.querySelectorAll('.video-tile').length,
      labels: [...document.querySelectorAll('.video-label')].map((n) => n.textContent),
    }));
    check(
      'U7. A contagem de .video-tile e o texto de .video-label não mudaram',
      depois.tiles === antes.tiles &&
        JSON.stringify(depois.labels) === JSON.stringify(antes.labels),
      `${antes.tiles}→${depois.tiles} tiles; rótulos ${JSON.stringify(depois.labels)}`,
    );

    // O indicador precisa existir também no modo destaque — o modo em que a
    // sala fica quando alguém compartilha tela.
    await helena.page.getByRole('button', { name: 'Compartilhar tela' }).click();
    await waitFor(async () => (await gil.page.locator('.spotlight-stage').count()) > 0, {
      timeout: 20000,
      label: 'a Gil entrar no modo destaque',
    });
    await forcar(gil.page, 'failed');
    const destaque = await waitFor(
      async () => {
        const found = await gil.page.evaluate(() => ({
          destaque: document.querySelectorAll('.spotlight-main .tile-connection').length,
          miniaturas: document.querySelectorAll('.thumb-rail .tile-connection').length,
        }));
        return found.destaque + found.miniaturas > 0 ? found : false;
      },
      { timeout: 8000, label: 'o indicador aparecer no modo destaque' },
    ).catch(() => ({ destaque: 0, miniaturas: 0 }));
    check(
      'U8. O indicador aparece também no modo destaque (destaque e miniaturas)',
      destaque.destaque > 0 && destaque.miniaturas > 0,
      `${destaque.destaque} no destaque, ${destaque.miniaturas} nas miniaturas`,
    );

    // ---- autoplay bloqueado
    //
    // Recarregar com o nome já em `sessionStorage` entra na sala **sem gesto
    // nenhum** — é o caminho documentado em `Room.jsx`, e exatamente o que a
    // política de autoplay barra no Safari, no Firefox e no iOS.
    // Via `addInitScript`, e não `evaluate`: o reload re-executa a
    // INSTRUMENTATION, que redefine `__wtkBlockAutoplay = false`. Um script de
    // inicialização acrescentado depois roda depois dela, e a flag sobrevive.
    await gil.context.addInitScript({ content: 'window.__wtkBlockAutoplay = true;' });
    await gil.page.reload();
    // Reentrar exige aprovação da Helena, que já está na sala — por isso o
    // `approveAll` vai **dentro** do laço de espera.
    await entrarU(gil, helena);
    const semGesto = await gil.page.evaluate(() => window.__wtkPlayCalls);
    const banner = gil.page.locator('button.audio-blocked');
    const apareceu = await waitFor(
      async () => (await banner.count()) > 0,
      { timeout: 20000, label: 'o aviso de som bloqueado aparecer' },
    ).then(() => true).catch(() => false);
    check(
      'U9. Autoplay bloqueado, entrando sem gesto, mostra um aviso clicável na sala',
      apareceu && (await gil.page.locator('.music-panel button.audio-blocked').count()) === 0,
      `play() tentado ${semGesto} vez(es) sem gesto; o aviso está fora de qualquer painel`,
    );

    // Clicar sem destravar de fato: a re-tentativa falha de novo e o aviso volta
    // sozinho. Um aviso que sumisse aqui seria o silêncio de volta, sem saída.
    if (apareceu) {
      await banner.click();
      const voltouAviso = await waitFor(
        async () => (await banner.count()) > 0,
        { timeout: 8000, label: 'o aviso reaparecer depois da re-tentativa falhar' },
      ).then(() => true).catch(() => false);
      check(
        'U10. Se a re-tentativa falha de novo, o aviso volta a aparecer',
        voltouAviso,
      );

      // Agora destravando de verdade: um clique, e voz e música voltam a tocar.
      const antesDoClique = await gil.page.evaluate(() => {
        window.__wtkBlockAutoplay = false;
        return window.__wtkPlayCalls;
      });
      await banner.click();
      const sumiu = await waitFor(
        async () => (await banner.count()) === 0,
        { timeout: 8000, label: 'o aviso sumir depois do destravamento' },
      ).then(() => true).catch(() => false);
      const depoisDoClique = await gil.page.evaluate(() => window.__wtkPlayCalls);
      check(
        'U11. Um clique re-tenta a reprodução de todos os elementos e o aviso some',
        sumiu && depoisDoClique > antesDoClique,
        `play() chamado ${depoisDoClique - antesDoClique} vez(es) no clique; aviso sumiu=${sumiu}`,
      );
    }

    const errosU = gil.consoleErrors.filter(
      (e) => !/favicon|ERR_CONNECTION_REFUSED/i.test(e),
    );
    check(
      'U12. Nenhuma rejeição de play()/setSinkId escapou como erro de console',
      errosU.length === 0,
      errosU.slice(0, 3).join(' | '),
    );
  } finally {
    await gil?.context.close();
    await helena?.context.close();
  }

  // ---------------------------------------------- G. nada de erro no console
  for (const p of [alice, bob]) {
    const relevant = p.consoleErrors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED/i.test(e));
    check(`G. Sem erros de JS no console de ${p.name}`, relevant.length === 0, relevant.slice(0, 3).join(' | '));
  }

  // ---------------------------------- H. inventário do tráfego do servidor
  const frames = await wire(alice.page);
  const events = new Set();
  for (const frame of frames) {
    // Frames Socket.IO: `42["nome-do-evento",{...}]` (prefixo engine.io + tipo).
    const match = frame.data.match(/^\d+\["([^"]+)"/);
    if (match) events.add(match[1]);
  }
  console.log(
    `\nEventos Socket.IO observados no fio (${frames.length} frames): ${JSON.stringify([...events].sort())}`,
  );
} catch (err) {
  console.error('\n💥 Falha na execução do teste:', err);
  failures += 1;
  // Diagnóstico: estado de cada conexão e erros de console de cada participante.
  for (const p of [alice, bob, carol]) {
    if (!p) continue;
    try {
      const stats = await peerStats(p.page);
      console.error(
        `\n[${p.name}] ${stats.length} conexões:`,
        JSON.stringify(
          stats.map((s) => ({
            conn: s.connectionState,
            ice: s.iceConnectionState,
            sig: s.signalingState,
          })),
        ),
      );
      if (p.consoleErrors.length) console.error(`[${p.name}] console:`, p.consoleErrors.slice(0, 5));
    } catch {
      console.error(`[${p.name}] página indisponível para diagnóstico`);
    }
  }
} finally {
  await browser?.close();
  signaling.stop();
  client.stop();
  turn.stop();
}

console.log(`\n${results.filter((r) => r.passed).length}/${results.length} checagens passaram`);
process.exit(failures === 0 ? 0 : 1);
