/**
 * `lib/micPipeline.js` — o dono do grafo de áudio do microfone.
 *
 * Por que este arquivo existe: o documento de arquitetura (§4.1/§4.4) punha o
 * grafo dentro de `noiseSuppression.js` e só previa teste para o DSP e para a
 * matriz de motor. O DoD exigiu que `noiseSuppression.js` fosse **puro**, o que
 * moveu todo o efeito colateral para cá — e a cobertura não veio junto. O que
 * mora aqui não é detalhe: é a diferença entre "o mesh transmite o track
 * processado" e "a pessoa entra na sala e ninguém a ouve".
 *
 * O E2E cobre o caminho feliz do worklet, e só ele. Os caminhos de **degradação**
 * são inalcançáveis lá por construção: num Chromium normal o `addModule` não
 * rejeita, o contexto não fica suspenso na hora errada e o destino sempre tem
 * track. São exatamente esses que este arquivo exercita, com fakes.
 *
 * A invariante que amarra quase todos os casos: **nunca entregar um track
 * morto**. Qualquer falha degrada para o track cru — pior que não suprimir é não
 * ter áudio, e um `MediaStreamAudioDestinationNode` em contexto suspenso produz
 * um track `live` que só emite silêncio, sem um erro sequer no console.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('../../../tools/viteUrlLoader.mjs', import.meta.url);

const { createMicPipeline, detectNoiseMode } = await import('../src/lib/micPipeline.js');
const { MODE, PROCESSOR_NAME } = await import('../src/lib/noiseSuppression.js');

// --------------------------------------------------------------------- fakes

/**
 * Os dublês implementam **o que o pipeline chama**. Os `as unknown as` estão na
 * fronteira (`withGlobals`, `withBrowserGlobals` e o `context` passado a
 * `createMicPipeline`), cada um comentado onde está.
 */
interface FakeTrack {
  id: string;
  kind: string;
  readyState: string;
  enabled: boolean;
  stops: number;
  stop(): void;
}

function fakeTrack({ kind = 'audio', readyState = 'live', id = 'track' } = {}): FakeTrack {
  return {
    id,
    kind,
    readyState,
    enabled: true,
    stops: 0,
    stop() {
      this.stops += 1;
      this.readyState = 'ended';
    },
  };
}

/** Um nó do grafo de áudio, com só o que o pipeline liga e desliga. */
interface FakeNode {
  label: string;
  disconnects: number;
  connectedTo: unknown[];
  connect(target: unknown): void;
  disconnect(): void;
  stream?: unknown;
}

function fakeNode(label: string): FakeNode {
  return {
    label,
    disconnects: 0,
    connectedTo: [] as unknown[],
    connect(target: unknown) {
      this.connectedTo.push(target);
    },
    disconnect() {
      this.disconnects += 1;
    },
  };
}

/**
 * `addModuleResult` aceita `true`, `false` ou uma rejeição — os três desfechos
 * reais de um `addModule`.
 */
/**
 * Um dublê entregue a `createMicPipeline`: track e contexto implementam o que o
 * pipeline chama, e nada mais.
 */
const comoTrack = (t: FakeTrack) => t as unknown as MediaStreamTrack;
const comoContexto = (c: ReturnType<typeof fakeContext>) => c as unknown as AudioContext;

function fakeContext({
  state = 'running',
  addModuleResult = true as boolean | Error,
  destinationTrack = fakeTrack({ id: 'processado' }) as FakeTrack | null,
  throwOnWorkletNode = false,
  hasAudioWorklet = true,
} = {}) {
  const ctx: {
    state: string;
    addModuleCalls: string[];
    closes: number;
    createdSources: FakeNode[];
    destinationNode: FakeNode | null;
    destinationTrack: FakeTrack | null;
    throwOnWorkletNode: boolean;
    audioWorklet?: { addModule(url: string): Promise<void> };
    close(): void;
    createMediaStreamSource(stream: unknown): FakeNode;
    createMediaStreamDestination(): FakeNode;
  } = {
    state,
    addModuleCalls: [],
    closes: 0,
    createdSources: [],
    destinationNode: null,
    destinationTrack,
    throwOnWorkletNode,
    close() { this.closes += 1; },
    createMediaStreamSource(stream: unknown) {
      const node = fakeNode('source');
      node.stream = stream;
      ctx.createdSources.push(node);
      return node;
    },
    createMediaStreamDestination() {
      const node = fakeNode('destination');
      node.stream = { getAudioTracks: () => (destinationTrack ? [destinationTrack] : []) };
      ctx.destinationNode = node;
      return node;
    },
  };
  if (hasAudioWorklet) {
    ctx.audioWorklet = {
      addModule(url: string) {
        ctx.addModuleCalls.push(url);
        if (addModuleResult instanceof Error) return Promise.reject(addModuleResult);
        return Promise.resolve(addModuleResult).then((ok) => {
          if (ok === false) throw new Error('addModule devolveu false');
          return undefined;
        });
      },
    };
  }
  return ctx;
}

/**
 * Atribuição direta não serve para `globalThis.navigator`: o Node moderno o
 * define como acessor só-getter, e `globalThis.navigator = x` lança
 * `TypeError: Cannot set property navigator`. `defineProperty` sobrepõe, e o
 * descritor original é restaurado no fim para não vazar para outro arquivo de
 * teste.
 */
function withGlobals<T>(values: Record<string, unknown>, run: () => T): T {
  const saved: [string, PropertyDescriptor | undefined][] = Object.keys(values).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    return run();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      // O cast: o nome é dinâmico, e a limpeza é justamente tirar o global.
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

/** Instala os globais de navegador que `createMicPipeline` toca, e os remove depois. */
function withBrowserGlobals(
  run: (warnings: string[]) => unknown,
  { workletNodeThrows = false } = {},
) {
  const saved = {
    MediaStream: globalThis.MediaStream,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    warn: console.warn,
  };
  const warnings: string[] = [];
  // Os três casts do bloco: cada dublê tem só o que o pipeline usa.
  globalThis.MediaStream = class {
    tracks: unknown;
    constructor(tracks: unknown) {
      this.tracks = tracks;
    }
  } as unknown as typeof MediaStream;
  globalThis.AudioWorkletNode = class {
    context: unknown;
    name: unknown;
    options: unknown;
    constructor(context: { throwOnWorkletNode?: boolean }, name: unknown, options: unknown) {
      if (workletNodeThrows || context.throwOnWorkletNode) {
        throw new Error('unknown processor');
      }
      Object.assign(this, fakeNode('worklet'));
      this.context = context;
      this.name = name;
      this.options = options;
    }
  } as unknown as typeof AudioWorkletNode;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
  return Promise.resolve(run(warnings)).finally(() => {
    globalThis.MediaStream = saved.MediaStream;
    globalThis.AudioWorkletNode = saved.AudioWorkletNode;
    console.warn = saved.warn;
  });
}

// ------------------------------------------------------------ detectNoiseMode

/** `AudioContext` de mentira cujo protótipo anuncia (ou não) o `audioWorklet`. */
function fakeAudioContextCtor({ withAudioWorklet = true } = {}) {
  class AC {}
  // O cast: o teste anuncia `audioWorklet` no protótipo, que é o que a detecção
  // de capacidade procura.
  if (withAudioWorklet) (AC.prototype as { audioWorklet?: unknown }).audioWorklet = {};
  return AC;
}

test('detectNoiseMode: constraint nativa presente vence o worklet', () => {
  withGlobals(
    {
      navigator: { mediaDevices: { getSupportedConstraints: () => ({ noiseSuppression: true }) } },
      window: { AudioContext: fakeAudioContextCtor() },
      AudioWorkletNode: class {},
    },
    () => {
      // Mesmo com AudioWorklet disponível: empilhar as duas supressões em série
      // é pior que uma só, então o nativo tem precedência sempre que existe.
      assert.equal(detectNoiseMode(), MODE.NATIVE);
    },
  );
});

test('detectNoiseMode: sem constraint nativa, cai no worklet', () => {
  withGlobals(
    {
      navigator: { mediaDevices: { getSupportedConstraints: () => ({}) } },
      window: { AudioContext: fakeAudioContextCtor() },
      AudioWorkletNode: class {},
    },
    () => assert.equal(detectNoiseMode(), MODE.WORKLET),
  );
});

test('detectNoiseMode: sem nativo e sem AudioWorklet, unsupported — é o toggle desabilitado', () => {
  withGlobals(
    {
      navigator: { mediaDevices: { getSupportedConstraints: () => ({}) } },
      window: { AudioContext: fakeAudioContextCtor({ withAudioWorklet: false }) },
      AudioWorkletNode: undefined,
    },
    () => assert.equal(detectNoiseMode(), MODE.UNSUPPORTED),
  );
});

test('detectNoiseMode: getSupportedConstraints lançando não derruba a decisão', () => {
  withGlobals(
    {
      navigator: {
        mediaDevices: { getSupportedConstraints: () => { throw new Error('bloqueado'); } },
      },
      window: {},
      AudioWorkletNode: undefined,
    },
    () => assert.equal(detectNoiseMode(), MODE.UNSUPPORTED),
  );
});

// ------------------------------------------------------- caminho de passagem

test('sem rawTrack, o pipeline é degenerado e stop() não quebra', async () => {
  await withBrowserGlobals(async () => {
    const pipeline = await createMicPipeline({ rawTrack: null, enabled: true, mode: MODE.WORKLET });
    assert.equal(pipeline.track, null);
    assert.equal(pipeline.processing, false);
    pipeline.stop();
  });
});

test('no modo nativo o grafo NÃO é montado — o navegador já processou', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack();
    const ctx = fakeContext();
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.NATIVE, context: comoContexto(ctx),
    });
    assert.equal(pipeline.processing, false);
    assert.equal(pipeline.track, raw);
    assert.equal(ctx.addModuleCalls.length, 0, 'addModule não deveria ter sido chamado');
  });
});

test('com o toggle desligado, o track cru vai direto para o mesh', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack();
    const ctx = fakeContext();
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: false, mode: MODE.WORKLET, context: comoContexto(ctx),
    });
    assert.equal(pipeline.processing, false);
    assert.equal(pipeline.track, raw);
    assert.equal(ctx.addModuleCalls.length, 0);
  });
});

test('contexto SUSPENSO degrada para o cru — é a falha silenciosa mais cara da entrega', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack();
    // Estado normal na entrada da sala, antes do primeiro gesto. Montar o grafo
    // aqui entregaria um track `live` que só emite silêncio.
    const ctx = fakeContext({ state: 'suspended' });
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx),
    });
    assert.equal(pipeline.processing, false);
    assert.equal(pipeline.track, raw);
    assert.equal(ctx.addModuleCalls.length, 0);
  });
});

test('contexto sem audioWorklet degrada para o cru', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack();
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(fakeContext({ hasAudioWorklet: false })),
    });
    assert.equal(pipeline.processing, false);
    assert.equal(pipeline.track, raw);
  });
});

test('addModule rejeitando degrada para o cru, sem promise solta e com aviso', async () => {
  await withBrowserGlobals(async (warnings) => {
    const raw = fakeTrack();
    const ctx = fakeContext({ addModuleResult: new Error('404 no asset do worklet') });
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx),
    });
    assert.equal(pipeline.processing, false);
    assert.equal(pipeline.track, raw);
    assert.equal(raw.readyState, 'live', 'degradar não pode matar o microfone');
    assert.ok(
      warnings.some((w) => w.includes('addModule falhou')),
      `esperava aviso de addModule; veio ${JSON.stringify(warnings)}`,
    );
  });
});

test('AudioWorkletNode lançando desconecta o que já subiu e degrada', async () => {
  await withBrowserGlobals(async (warnings) => {
    const raw = fakeTrack();
    const ctx = fakeContext({ throwOnWorkletNode: true });
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx),
    });
    assert.equal(pipeline.processing, false);
    assert.equal(pipeline.track, raw);
    assert.equal(ctx.createdSources[0].disconnects, 1, 'o source já criado precisa ser desconectado');
    assert.ok(warnings.some((w) => w.includes('grafo indisponível')));
  });
});

test('destino sem track vivo degrada para o cru e desmonta o grafo', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack();
    const ctx = fakeContext({ destinationTrack: fakeTrack({ readyState: 'ended' }) });
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx),
    });
    assert.equal(pipeline.processing, false, 'um track ended jamais pode ir para o mesh');
    assert.equal(pipeline.track, raw);
    assert.equal(ctx.createdSources[0].disconnects, 1);
  });
});

// ------------------------------------------------------------- caminho feliz

test('caminho feliz: o mesh recebe o PROCESSADO e o cru continua acessível', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack({ id: 'cru' });
    const processado = fakeTrack({ id: 'processado' });
    const ctx = fakeContext({ destinationTrack: processado });
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx),
    });

    assert.equal(pipeline.processing, true);
    assert.equal(pipeline.track, processado, 'o mesh precisa receber o processado');
    assert.equal(pipeline.rawTrack, raw, 'o cru é o que o `ended` e a reconciliação observam');
    assert.notEqual(pipeline.track, pipeline.rawTrack);

    // source → worklet → destination, nessa ordem.
    // Os casts deste bloco: o grafo montado é de nós dublês, e é a **ligação**
    // entre eles que se afirma.
    const source = ctx.createdSources[0]!;
    assert.equal((source.stream as { tracks: unknown[] }).tracks[0], raw);
    assert.equal(source.connectedTo.length, 1);
    const worklet = source.connectedTo[0] as { name: string; connectedTo: unknown[] };
    assert.equal(worklet.name, PROCESSOR_NAME);
    assert.equal(worklet.connectedTo[0], ctx.destinationNode);
    assert.equal(ctx.addModuleCalls.length, 1);
    assert.match(ctx.addModuleCalls[0]!, /noiseSuppressorWorklet\.js$/);
  });
});

test('addModule roda uma vez por contexto, e de novo num contexto novo', async () => {
  await withBrowserGlobals(async () => {
    const ctx = fakeContext();
    await createMicPipeline({ rawTrack: comoTrack(fakeTrack()), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx) });
    await createMicPipeline({ rawTrack: comoTrack(fakeTrack()), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx) });
    assert.equal(ctx.addModuleCalls.length, 1, 'o WeakMap deve memoizar por contexto');

    // O AudioContext da sala é fechado e recriado a cada entrada: um flag global
    // faria a segunda sala pular o addModule num contexto que nunca o recebeu.
    const outro = fakeContext();
    await createMicPipeline({ rawTrack: comoTrack(fakeTrack()), enabled: true, mode: MODE.WORKLET, context: comoContexto(outro) });
    assert.equal(outro.addModuleCalls.length, 1);
  });
});

// ---------------------------------------------------------- release() e stop()

test('release() para só o processado e devolve um pipeline sobre o cru VIVO', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack({ id: 'cru' });
    const processado = fakeTrack({ id: 'processado' });
    const ctx = fakeContext({ destinationTrack: processado });
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx),
    });

    const liberado = pipeline.release();
    assert.equal(processado.stops, 1);
    // É o desligamento do toggle em chamada: matar o cru aqui deixaria a pessoa
    // sem microfone nenhum.
    assert.equal(raw.stops, 0);
    assert.equal(raw.readyState, 'live');
    assert.equal(liberado.processing, false);
    assert.equal(liberado.track, raw);
    assert.equal(ctx.destinationNode!.disconnects, 1);
    assert.equal(ctx.closes, 0);
  });
});

test('release() é idempotente e nunca ressuscita o grafo', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack();
    const processado = fakeTrack();
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(fakeContext({ destinationTrack: processado })),
    });
    pipeline.release();
    const segundo = pipeline.release();
    assert.equal(processado.stops, 1, 'o segundo release não pode parar de novo');
    assert.equal(segundo.track, raw);
    assert.equal(raw.stops, 0);
  });
});

test('stop() para os DOIS tracks e NÃO fecha o AudioContext da sala', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack({ id: 'cru' });
    const processado = fakeTrack({ id: 'processado' });
    const ctx = fakeContext({ destinationTrack: processado });
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.WORKLET, context: comoContexto(ctx),
    });

    pipeline.stop();
    // Parar só o destino deixaria o getUserMedia vivo — o LED do microfone
    // aceso depois de sair da sala.
    assert.equal(raw.stops, 1);
    assert.equal(processado.stops, 1);
    // O contexto é do Room: a música e o medidor de fala vivem nele.
    assert.equal(ctx.closes, 0);
    assert.equal(ctx.destinationNode!.disconnects, 1);

    pipeline.stop();
    assert.equal(raw.stops, 1, 'stop() precisa ser idempotente');
  });
});

test('stop() no pipeline degenerado para o track cru', async () => {
  await withBrowserGlobals(async () => {
    const raw = fakeTrack();
    const pipeline = await createMicPipeline({
      rawTrack: comoTrack(raw), enabled: true, mode: MODE.NATIVE, context: comoContexto(fakeContext()),
    });
    pipeline.stop();
    assert.equal(raw.stops, 1);
    pipeline.stop();
    assert.equal(raw.stops, 1);
  });
});
