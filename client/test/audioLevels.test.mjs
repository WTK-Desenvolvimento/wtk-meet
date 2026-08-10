/**
 * Testes da lei de histerese do indicador de fala.
 *
 * O E2E prova que o anel acende e apaga de verdade no navegador, mas não
 * consegue cravar a temporização: o dispositivo de áudio falso do Chromium
 * emite bipes curtos e esparsos, e o Chrome não entrega o áudio de uma track a
 * um segundo AudioContext, então não há como instalar uma sonda independente
 * para marcar o instante real do silêncio. Aqui o relógio, o rAF e o analisador
 * são controlados, e os limites de 200ms (ataque) e 500ms (release) ficam
 * verificados de forma determinística.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const FRAME_MS = 16;

/** Ambiente de navegador mínimo, com relógio e rAF sob controle do teste. */
function installFakeBrowser() {
  let now = 0;
  let signal = 0;
  const pending = [];

  class FakeAnalyser {
    constructor() {
      this.fftSize = 2048;
      this.smoothingTimeConstant = 0;
    }
    // Sinal DC de amplitude `signal`: o RMS é exatamente |signal|.
    getFloatTimeDomainData(buffer) {
      buffer.fill(signal);
    }
    disconnect() {}
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return new FakeAnalyser();
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (cb) => pending.push(cb);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = {
    AudioContext: FakeAudioContext,
    addEventListener() {},
    removeEventListener() {},
  };

  return {
    setSignal: (value) => {
      signal = value;
    },
    /** Avança o relógio um frame e roda os callbacks de rAF pendentes. */
    frame: () => {
      now += FRAME_MS;
      const due = pending.splice(0, pending.length);
      for (const cb of due) cb();
    },
    at: () => now,
  };
}

const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] };

async function loadMonitor() {
  const { AudioLevelMonitor } = await import('../src/lib/audioLevels.js');
  return AudioLevelMonitor;
}

test('acende em menos de 200ms depois que a fala começa', async () => {
  const browser = installFakeBrowser();
  const AudioLevelMonitor = await loadMonitor();

  let speaking = false;
  const monitor = new AudioLevelMonitor({
    onUpdate: (snapshot) => {
      speaking = !!snapshot.alice?.speaking;
    },
  });
  monitor.attach('alice', fakeStream);

  browser.setSignal(0.2); // bem acima do limiar de ataque
  const startedAt = browser.at();
  for (let i = 0; i < 40 && !speaking; i += 1) browser.frame();

  assert.ok(speaking, 'o indicador deveria ter acendido');
  const attackMs = browser.at() - startedAt;
  assert.ok(attackMs < 200, `acendeu em ${attackMs}ms, esperado < 200ms`);

  monitor.close();
});

test('só apaga após ~500ms de silêncio contínuo', async () => {
  const browser = installFakeBrowser();
  const AudioLevelMonitor = await loadMonitor();

  let speaking = false;
  const monitor = new AudioLevelMonitor({
    onUpdate: (snapshot) => {
      speaking = !!snapshot.alice?.speaking;
    },
  });
  monitor.attach('alice', fakeStream);

  browser.setSignal(0.2);
  for (let i = 0; i < 40 && !speaking; i += 1) browser.frame();
  assert.ok(speaking);

  browser.setSignal(0); // silêncio
  const silenceStartedAt = browser.at();

  // Ainda aceso em 400ms: é o que impede o anel de piscar entre as palavras.
  while (browser.at() - silenceStartedAt < 400) browser.frame();
  assert.ok(speaking, `apagou cedo demais (${browser.at() - silenceStartedAt}ms de silêncio)`);

  // E apagado logo depois dos 500ms.
  while (speaking && browser.at() - silenceStartedAt < 1000) browser.frame();
  assert.ok(!speaking, 'não apagou depois de 1s de silêncio');
  const releaseMs = browser.at() - silenceStartedAt;
  assert.ok(releaseMs >= 500, `apagou em ${releaseMs}ms, esperado >= 500ms`);
  assert.ok(releaseMs < 700, `demorou ${releaseMs}ms para apagar, esperado < 700ms`);

  monitor.close();
});

test('uma pausa curta entre palavras não apaga o indicador', async () => {
  const browser = installFakeBrowser();
  const AudioLevelMonitor = await loadMonitor();

  let speaking = false;
  const monitor = new AudioLevelMonitor({
    onUpdate: (snapshot) => {
      speaking = !!snapshot.alice?.speaking;
    },
  });
  monitor.attach('alice', fakeStream);

  browser.setSignal(0.2);
  for (let i = 0; i < 40 && !speaking; i += 1) browser.frame();
  assert.ok(speaking);

  // Fala entrecortada: 300ms de pausa, volta a falar, repete.
  for (let round = 0; round < 4; round += 1) {
    browser.setSignal(0);
    const pauseStartedAt = browser.at();
    while (browser.at() - pauseStartedAt < 300) browser.frame();
    assert.ok(speaking, `o anel piscou numa pausa de 300ms (rodada ${round})`);
    browser.setSignal(0.2);
    for (let i = 0; i < 4; i += 1) browser.frame();
  }

  monitor.close();
});

test('um único loop de rAF e um único AudioContext para vários streams', async () => {
  const browser = installFakeBrowser();
  const AudioLevelMonitor = await loadMonitor();

  let contexts = 0;
  const OriginalContext = globalThis.window.AudioContext;
  globalThis.window.AudioContext = class extends OriginalContext {
    constructor(...args) {
      super(...args);
      contexts += 1;
    }
  };

  let rafCalls = 0;
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => {
    rafCalls += 1;
    return originalRaf(cb);
  };

  const monitor = new AudioLevelMonitor({ onUpdate: () => {} });
  for (const id of ['alice', 'bob', 'carol', 'dave']) monitor.attach(id, fakeStream);

  assert.equal(contexts, 1, 'deveria criar um único AudioContext');

  browser.setSignal(0.2);
  const before = rafCalls;
  for (let i = 0; i < 10; i += 1) browser.frame();
  // Um agendamento por frame, não um por stream.
  assert.ok(rafCalls - before <= 11, `${rafCalls - before} chamadas de rAF em 10 frames com 4 streams`);

  monitor.close();
  const afterClose = rafCalls;
  browser.frame();
  assert.equal(rafCalls, afterClose, 'o loop continuou rodando depois de close()');
});

test('close() encerra o AudioContext e solta os analisadores', async () => {
  installFakeBrowser();
  const AudioLevelMonitor = await loadMonitor();

  const monitor = new AudioLevelMonitor({ onUpdate: () => {} });
  monitor.attach('alice', fakeStream);
  const ctx = monitor.ctx;
  assert.equal(ctx.state, 'running');

  monitor.close();
  assert.equal(ctx.state, 'closed');
  assert.equal(monitor.sources.size, 0);
  assert.equal(monitor.ctx, null);
});
