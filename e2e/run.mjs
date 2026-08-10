/**
 * Teste E2E das cinco melhorias, com 3 participantes em contextos Chromium
 * isolados. Cobre exatamente o roteiro do definition of done:
 *
 *   A. conexão do mesh (3 participantes, 2 peers cada)
 *   B. indicador de fala (anel azul) sem tráfego de nível de áudio
 *   C. compartilhamento de tela + glare (dois compartilhando ao mesmo tempo)
 *   D. chat P2P via data channel, sem passar pelo servidor
 *   E. desligar/religar câmera com track.stop() e replaceTrack, sem renegociar
 *   F. saída da sala sem vazar tracks/AudioContext/rAF
 *
 * Rodar: node e2e/run.mjs   (o próprio script builda o client)
 */
import {
  CLIENT_ORIGIN,
  approveAll,
  buildClient,
  launchBrowser,
  openParticipant,
  peerStats,
  setInputValue,
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

  bob = await openParticipant(browser, { roomUrl, name: 'Bob' });
  await waitInCall(bob, alice);

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

  // ------------------------------------------------- A4. toasts de entrada
  // Alice viu Bob e Carol entrarem; o toast dura ~4s, então já expirou.
  // Verificamos o mecanismo forçando uma saída mais abaixo (F).

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

  await carol.page.getByRole('button', { name: 'Parar compartilhamento' }).click();
  await waitFor(
    async () => (await alice.page.locator('.video-tile').count()) === 3,
    { timeout: 15000, label: 'grade sem telas' },
  );

  // ------------------------------------------------------------- D. chat
  await alice.page.getByRole('button', { name: /^Chat/ }).click();
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

  // Silenciar os avisos deve calar o bipe sem calar o toast.
  await alice.page.getByRole('button', { name: 'Silenciar avisos' }).click();
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
