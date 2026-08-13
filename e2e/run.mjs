/**
 * Teste E2E das cinco melhorias, com 3 participantes em contextos Chromium
 * isolados. Cobre exatamente o roteiro do definition of done:
 *
 *   A. conexão do mesh (3 participantes, 2 peers cada)
 *   B. indicador de fala (anel azul) sem tráfego de nível de áudio
 *   C. compartilhamento de tela + glare (dois compartilhando ao mesmo tempo)
 *   D. chat P2P via data channel, sem passar pelo servidor
 *   E. desligar/religar câmera com track.stop() e replaceTrack, sem renegociar
 *   S. modal de configurações: listagem, troca de câmera/mic em chamada,
 *      saída de áudio, cancelamento e devicechange
 *   F. saída da sala sem vazar tracks/AudioContext/rAF
 *
 * Rodar: node e2e/run.mjs   (o próprio script builda o client)
 */
import {
  CLIENT_ORIGIN,
  approveAll,
  buildClient,
  launchBrowser,
  noPageScroll,
  openParticipant,
  openSettings,
  peerStats,
  roomLayout,
  senderTracks,
  setInputValue,
  setSelectValue,
  sleep,
  startClientServer,
  startSignaling,
  startTurn,
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

const roomId = crypto.randomUUID();
const passphrase = 'e2e-passphrase-nao-vai-ao-servidor';
const roomUrl = `${CLIENT_ORIGIN}/room/${roomId}#${passphrase}`;

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

  // Layout esperado por conexão: 3 canais de envio (mic, câmera, tela) e os 3
  // espelhos de recepção criados pelo navegador ao aplicar a oferta remota.
  const aliceTx = (await peerStats(alice.page))[0].transceivers;
  const send = aliceTx.filter((t) => t.currentDirection === 'sendonly');
  const recv = aliceTx.filter((t) => t.currentDirection === 'recvonly');
  check(
    'A2. Cada conexão tem 2 canais de vídeo por sentido (câmera + tela) e 1 de áudio',
    send.filter((t) => t.kind === 'video').length === 2 &&
      send.filter((t) => t.kind === 'audio').length === 1 &&
      recv.filter((t) => t.kind === 'video').length === 2 &&
      recv.filter((t) => t.kind === 'audio').length === 1,
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

  await waitFor(
    async () => (await alice.page.locator('.tile-badge').count()) >= 2,
    { timeout: 25000, label: 'dois tiles de tela na grade de Alice' },
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

  const aliceTilesWithScreen = await alice.page.locator('.video-tile').count();
  check('C5. Grade de Alice cresce para 5 tiles (3 câmeras + 2 telas)', aliceTilesWithScreen === 5, `tiles=${aliceTilesWithScreen}`);

  // Sair do compartilhamento restaura a grade.
  await bob.page.getByRole('button', { name: 'Parar compartilhamento' }).click();
  await waitFor(
    async () => (await alice.page.locator('.video-tile').count()) === 4,
    { timeout: 15000, label: 'grade sem a tela de Bob' },
  );
  check('C6. Sair do compartilhamento remove a track e restaura a grade', true);

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
    async () => (await alice.page.locator('.video-tile').count()) === 3,
    { timeout: 15000, label: 'grade sem telas' },
  ).catch(() => false);
  // A track precisa ter sido efetivamente encerrada pelo handler, não só sumido
  // da grade: é o que garante que a captura de tela realmente parou.
  const carolScreenEnded = await carol.page.evaluate(() =>
    [...window.__wtkDisplayTracks].every((t) => t.readyState === 'ended'),
  );
  const carolButtonBack = await carol.page.getByRole('button', { name: 'Compartilhar tela' }).count();
  check(
    'C7. "Parar compartilhamento" do navegador (evento ended) também encerra a tela',
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

  // ------------------------------------------------------ S. saída de áudio
  await openSettings(alice.page);
  await setSelectValue(alice.page.locator('.settings-modal select').nth(2), 'spk-b');
  await alice.page.getByRole('button', { name: 'Salvar' }).click();
  await alice.page.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 });
  await sleep(500);

  const sinkState = await alice.page.evaluate(() => ({
    calls: window.__wtkSinkIds.filter((c) => c.sinkId === 'spk-b').length,
    tiles: document.querySelectorAll('.video-tile video').length,
    saved: JSON.parse(localStorage.getItem('wtk-meet:devices')).audioOutputId,
  }));
  check(
    'S9. A saída escolhida é aplicada com setSinkId em todos os elementos de mídia dos tiles',
    sinkState.calls >= sinkState.tiles && sinkState.tiles > 0 && sinkState.saved === 'spk-b',
    `setSinkId('spk-b') em ${sinkState.calls} elementos, ${sinkState.tiles} tiles, salvo=${sinkState.saved}`,
  );

  // ------------------------------------- S. trocar de mic estando silenciado
  await alice.page.getByRole('button', { name: 'Silenciar' }).click();
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
  await alice.page.getByRole('button', { name: 'Silenciar' }).waitFor({ timeout: 5000 });

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
  await alice.page.locator('.settings-modal input[type="checkbox"]').evaluate((box) => {
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
