/**
 * Ambiente de navegador falso, escrito a mao de proposito.
 *
 * Por que nao jsdom: os modulos deste app tocam quatro APIs que jsdom tambem
 * nao implementa de verdade (getUserMedia, getDisplayMedia, RTCPeerConnection,
 * AnalyserNode). Se os doubles dessas quatro precisam existir de qualquer
 * forma, um DOM minimo sai mais barato que uma dependencia — e os testes ficam
 * podendo INSPECIONAR o que o codigo fez: quantas vezes `track.stop()` foi
 * chamado, o que foi para cada `sender`, quais nos entraram no DOM.
 *
 * Uso (a ordem importa: `media.js` e `speaking-ring.js` leem globais no
 * momento do import, entao instale ANTES de importar):
 *
 *   const env = installEnv();
 *   const { createLocalMedia } = await import('../src/media.js');
 *
 * `node --test` roda cada ARQUIVO de teste em um processo proprio, portanto os
 * globais instalados aqui nunca vazam de um arquivo para outro.
 */

// --------------------------------------------------------------------- DOM ---

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.parentNode = null;
  }
}

class ClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }

  sync() {
    this.el._className = [...this.set].join(' ');
  }

  add(...names) {
    for (const n of names) this.set.add(n);
    this.sync();
  }

  remove(...names) {
    for (const n of names) this.set.delete(n);
    this.sync();
  }

  contains(name) {
    return this.set.has(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    this.sync();
    return on;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this._className = '';
    this.classList = new ClassList(this);
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.value = '';
    this.srcObject = null;
    // Rolagem: valores fixos que deixam `atBottom()` verdadeiro por padrao.
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 100;
    this.rect = { width: 320, height: 180 };
    this.styleProps = new Map();
    this.style = {
      setProperty: (k, v) => this.styleProps.set(k, v),
      getPropertyValue: (k) => this.styleProps.get(k) ?? '',
      removeProperty: (k) => this.styleProps.delete(k),
    };
    if (this.tagName === 'CANVAS') {
      this.width = 0;
      this.height = 0;
      this.ctx = new FakeCanvasContext();
    }
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value);
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent ?? '').join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== '' && value != null) this.appendChild(new TextNode(value));
  }

  appendChild(node) {
    node.parentNode?.removeChild?.(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) this.appendChild(node);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  /** Dispara um evento neste elemento. @returns {boolean} houve preventDefault */
  fire(type, props = {}) {
    let defaultPrevented = false;
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {
        defaultPrevented = true;
      },
      stopPropagation() {},
      ...props,
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    return defaultPrevented;
  }

  click() {
    this.fire('click');
  }

  focus() {
    globalThis.document.activeElement = this;
  }

  blur() {
    if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
  }

  getBoundingClientRect() {
    return { width: this.rect.width, height: this.rect.height, top: 0, left: 0, x: 0, y: 0 };
  }

  getContext() {
    return this.ctx;
  }

  play() {
    this.played = (this.played ?? 0) + 1;
    return Promise.resolve();
  }

  /** Suporta apenas `.classe` e `tag` — o bastante para o que o app usa. */
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.')) {
        if (child.classList.contains(selector.slice(1))) return child;
      } else if (child.tagName === selector.toUpperCase()) {
        return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  matches(selector) {
    return selector
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .includes(this.tagName);
  }

  /** Todos os descendentes (elementos), em profundidade. Util nas asserts. */
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

/** Canvas 2D que so anota o que foi pedido — os testes leem `calls`. */
class FakeCanvasContext {
  constructor() {
    this.calls = [];
    this.lineWidth = 1;
    this.strokeStyle = '';
    this.fillStyle = '';
  }

  record(op, args) {
    this.calls.push({ op, args });
  }

  count(op) {
    return this.calls.filter((c) => c.op === op).length;
  }

  clearRect(...a) {
    this.record('clearRect', a);
  }

  setTransform(...a) {
    this.record('setTransform', a);
  }

  beginPath(...a) {
    this.record('beginPath', a);
  }

  rect(...a) {
    this.record('rect', a);
  }

  roundRect(...a) {
    this.record('roundRect', a);
  }

  arc(...a) {
    this.record('arc', a);
  }

  fill(...a) {
    this.record('fill', a);
  }

  stroke(...a) {
    this.record('stroke', a);
  }
}

function createDocument() {
  const doc = {
    activeElement: null,
    listeners: new Map(),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new TextNode(text),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    },
    fire(type, props = {}) {
      const event = { type, preventDefault() {}, ...props };
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    },
  };
  doc.body = new FakeElement('body');
  return doc;
}

// ------------------------------------------------------------------ midia ---

let trackSeq = 0;

/**
 * MediaStreamTrack falso. O que os testes olham:
 *  - `stopCount`: quantas vezes `stop()` foi chamado (0 = LED continua aceso)
 *  - `readyState`: 'ended' depois do stop, como no navegador
 */
export class FakeTrack {
  constructor(kind, { deviceId = null, label = '' } = {}) {
    trackSeq += 1;
    this.kind = kind;
    this.id = `${kind}-${trackSeq}`;
    this.label = label || this.id;
    this.readyState = 'live';
    this.enabled = true;
    this.muted = false;
    this.contentHint = '';
    this.stopCount = 0;
    this.deviceId = deviceId;
    this.listeners = new Map();
  }

  getSettings() {
    return { deviceId: this.deviceId ?? undefined, width: 1280, height: 720 };
  }

  stop() {
    this.stopCount += 1;
    this.readyState = 'ended';
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  /**
   * Simula o navegador: 'ended' (dispositivo sumiu / botao nativo), 'mute'.
   * No navegador o 'ended' e consequencia do track ter acabado, entao o
   * readyState muda ANTES do evento — o double precisa fazer o mesmo, senao
   * um track "encerrado pelo Chrome" continuaria contando como aberto.
   */
  fire(type) {
    if (type === 'ended') this.readyState = 'ended';
    if (type === 'mute') this.muted = true;
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, target: this });
  }
}

export class FakeMediaStream {
  constructor(tracks = []) {
    this.id = `stream-${(trackSeq += 1)}`;
    this.tracks = [...tracks];
    /** Amplitude 0..1 que o AnalyserNode falso vai "ouvir" deste stream. */
    this.amplitude = 0;
  }

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  addTrack(track) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }

  removeTrack(track) {
    const i = this.tracks.indexOf(track);
    if (i >= 0) this.tracks.splice(i, 1);
  }
}

function namedError(name, message = name) {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * navigator.mediaDevices falso e roteirizavel.
 *
 * `tracks` acumula TODO track ja entregue — e assim que se caca track orfao:
 * ao final do teste, todo track que nao esta em uso precisa estar 'ended'.
 */
function createMediaDevices({ supportsDisplay = true } = {}) {
  const devices = {
    userMediaCalls: [],
    displayMediaCalls: [],
    tracks: [],
    /** Fila de erros: cada `failNext` vale para a proxima chamada. */
    failures: [],
    /** Simula camera que mudou de porta: o deviceId exato deixa de existir. */
    rejectExactDeviceId: false,
    cameraDeviceId: 'cam-1',
    micDeviceId: 'mic-1',
    displayDeviceId: 'screen-1',

    failNext(name) {
      devices.failures.push(name);
    },

    /** Segura as proximas aberturas no ar, para testar concorrencia. */
    hold() {
      devices.holding = true;
    },

    /** Solta o que estava segurado. */
    release() {
      devices.holding = false;
      for (const resolve of devices.waiting.splice(0)) resolve();
    },

    holding: false,
    waiting: [],

    async getUserMedia(constraints = {}) {
      devices.userMediaCalls.push(constraints);
      const failure = devices.failures.shift();
      if (failure) throw namedError(failure);
      if (constraints.video?.deviceId?.exact && devices.rejectExactDeviceId) {
        throw namedError('OverconstrainedError');
      }
      if (devices.holding) await new Promise((resolve) => devices.waiting.push(resolve));
      const tracks = [];
      if (constraints.audio) {
        tracks.push(new FakeTrack('audio', { deviceId: devices.micDeviceId, label: 'Microfone' }));
      }
      if (constraints.video) {
        tracks.push(new FakeTrack('video', { deviceId: devices.cameraDeviceId, label: 'Camera' }));
      }
      devices.tracks.push(...tracks);
      return new FakeMediaStream(tracks);
    },

    async enumerateDevices() {
      return [
        { kind: 'videoinput', deviceId: devices.cameraDeviceId, label: 'Camera' },
        { kind: 'audioinput', deviceId: devices.micDeviceId, label: 'Microfone' },
      ];
    },
  };

  if (supportsDisplay) {
    devices.getDisplayMedia = async (constraints = {}) => {
      devices.displayMediaCalls.push(constraints);
      const failure = devices.failures.shift();
      if (failure) throw namedError(failure);
      const track = new FakeTrack('video', { deviceId: devices.displayDeviceId, label: 'Tela 1' });
      devices.tracks.push(track);
      return new FakeMediaStream([track]);
    };
  }

  return devices;
}

// ---------------------------------------------------------------- WebAudio ---

class FakeAnalyser {
  constructor() {
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0;
    this.source = null;
  }

  connect(node) {
    return node;
  }

  disconnect() {}

  /** Preenche com uma senoide na amplitude atual do stream de origem. */
  getByteTimeDomainData(buffer) {
    const amplitude = this.source?.stream?.amplitude ?? 0;
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = Math.round(128 + Math.sin((i / buffer.length) * Math.PI * 8) * 127 * amplitude);
    }
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = { name: 'destination' };
    this.sources = [];
    this.oscillators = [];
    this.closed = false;
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(stream) {
    const source = {
      stream,
      disconnected: false,
      connect: (node) => {
        if (node instanceof FakeAnalyser) node.source = source;
        return node;
      },
      disconnect() {
        this.disconnected = true;
      },
    };
    this.sources.push(source);
    return source;
  }

  createAnalyser() {
    return new FakeAnalyser();
  }

  createOscillator() {
    const osc = {
      type: 'sine',
      started: false,
      stopped: false,
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (node) => node,
      start() {
        this.started = true;
      },
      stop() {
        this.stopped = true;
      },
    };
    this.oscillators.push(osc);
    return osc;
  }

  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (node) => node,
    };
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}
FakeAudioContext.instances = [];

// ------------------------------------------------------------------ WebRTC ---

function createSender() {
  return {
    track: null,
    /** Historico de tudo que passou por aqui — inclusive os `null`. */
    replaceCalls: [],
    replaceTrack(track) {
      this.track = track ?? null;
      this.replaceCalls.push(track ?? null);
      return Promise.resolve();
    },
    getParameters() {
      return { degradationPreference: undefined, encodings: [{}] };
    },
    setParameters(params) {
      this.params = params;
      return Promise.resolve();
    },
  };
}

/**
 * RTCPeerConnection falso.
 *
 * Um detalhe fiel ao navegador e essencial aqui: `setRemoteDescription` de uma
 * OFERTA cria os transceivers do lado que responde, e eles nascem 'recvonly'.
 * E exatamente essa armadilha que `rtc.js` corrige promovendo para 'sendrecv';
 * sem simular isso, o teste nao teria como provar a correcao.
 */
export class FakeRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.transceivers = [];
    this.localDescription = null;
    this.remoteDescription = null;
    this.iceCandidates = [];
    this.connectionState = 'new';
    this.closed = false;
    this.listeners = new Map();
    FakeRTCPeerConnection.instances.push(this);
  }

  static reset() {
    FakeRTCPeerConnection.instances = [];
  }

  addTransceiver(kind, { direction = 'sendrecv' } = {}) {
    const transceiver = { kind, direction, sender: createSender(), receiver: { track: new FakeTrack(kind) } };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers() {
    return [...this.transceivers];
  }

  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }

  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'sdp-oferta' });
  }

  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'sdp-resposta' });
  }

  setLocalDescription(description) {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description) {
    this.remoteDescription = description;
    if (description.type === 'offer' && this.transceivers.length === 0) {
      for (const kind of ['audio', 'video', 'video']) {
        this.addTransceiver(kind, { direction: 'recvonly' });
      }
    }
    return Promise.resolve();
  }

  addIceCandidate(candidate) {
    if (!this.remoteDescription) return Promise.reject(new Error('sem descricao remota'));
    this.iceCandidates.push(candidate);
    return Promise.resolve();
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  fire(type, props = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...props });
  }
}
FakeRTCPeerConnection.instances = [];

// ---------------------------------------------------------------- signaling ---

/** Coletor de mensagens no lugar do WebSocket. */
export function createFakeSignaling() {
  const sent = [];
  return {
    sent,
    send(msg) {
      sent.push(msg);
    },
    ofType(type) {
      return sent.filter((m) => m.t === type);
    },
    clear() {
      sent.length = 0;
    },
  };
}

// ----------------------------------------------------------------- install ---

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

/**
 * Instala os globais de navegador. Chame ANTES de importar os modulos de `src/`.
 *
 * @param {{reducedMotion?: boolean, supportsDisplay?: boolean}} options
 */
export function installEnv({ reducedMotion = false, supportsDisplay = true } = {}) {
  FakeRTCPeerConnection.reset();
  FakeAudioContext.instances = [];

  const document = createDocument();
  const mediaDevices = createMediaDevices({ supportsDisplay });
  const storage = new Map();

  const frames = [];
  let frameSeq = 0;

  // Relogio deslocavel. O medidor usa `performance.now()` para o hangover de
  // fala (500 ms); num teste sincrono o relogio real mal anda, e o estado
  // "falando" nunca cairia. O proxy repassa todo o resto do performance real,
  // para nao atrapalhar o proprio `node --test`.
  let clockOffset = 0;
  const realPerformance = globalThis.performance;
  const performanceProxy = new Proxy(realPerformance, {
    get(target, prop) {
      if (prop === 'now') return () => realPerformance.now() + clockOffset;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };

  const matchMediaCalls = [];
  const matchMedia = (query) => {
    matchMediaCalls.push(query);
    return {
      media: query,
      matches: reducedMotion && query.includes('prefers-reduced-motion'),
      addEventListener() {},
      removeEventListener() {},
    };
  };

  const requestAnimationFrame = (fn) => {
    frameSeq += 1;
    frames.push({ id: frameSeq, fn });
    return frameSeq;
  };

  const cancelAnimationFrame = (id) => {
    const i = frames.findIndex((f) => f.id === id);
    if (i >= 0) frames.splice(i, 1);
  };

  const windowStub = {
    devicePixelRatio: 1,
    AudioContext: FakeAudioContext,
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    localStorage,
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    },
    fire(type) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type });
    },
  };

  define('document', document);
  define('window', windowStub);
  define('navigator', { mediaDevices, userAgent: 'fake' });
  define('matchMedia', matchMedia);
  define('requestAnimationFrame', requestAnimationFrame);
  define('cancelAnimationFrame', cancelAnimationFrame);
  define('localStorage', localStorage);
  define('MediaStream', FakeMediaStream);
  define('RTCPeerConnection', FakeRTCPeerConnection);
  define('AudioContext', FakeAudioContext);
  define('performance', performanceProxy);
  define('Element', FakeElement);

  return {
    document,
    window: windowStub,
    mediaDevices,
    localStorage,
    matchMediaCalls,
    audioContexts: FakeAudioContext.instances,
    peers: FakeRTCPeerConnection.instances,

    el(tag = 'div') {
      return new FakeElement(tag);
    },

    /** Anda com o relogio de `performance.now()` (hangover de fala, ondas). */
    advanceClock(ms) {
      clockOffset += ms;
    },

    /** Executa os callbacks de rAF pendentes. @returns quantos rodaram */
    pumpFrames(times = 1) {
      let ran = 0;
      for (let i = 0; i < times; i += 1) {
        const pending = frames.splice(0);
        if (pending.length === 0) break;
        for (const frame of pending) {
          frame.fn(performance.now());
          ran += 1;
        }
      }
      return ran;
    },

    /** Quantos rAF estao agendados agora — 0 em silencio e o requisito. */
    get pendingFrames() {
      return frames.length;
    },

    /** Todo track entregue pelos dispositivos falsos. */
    get allTracks() {
      return mediaDevices.tracks;
    },

    /** Tracks que ficaram abertos: se sobrar algum ao sair, e vazamento. */
    get liveTracks() {
      return mediaDevices.tracks.filter((t) => t.readyState === 'live');
    },
  };
}

export { FakeElement, TextNode, FakeAudioContext };
