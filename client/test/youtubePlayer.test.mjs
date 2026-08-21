/**
 * A origem YouTube — a única parte do player que fala com um terceiro, e por
 * isso a única que precisa provar duas coisas: que **só** fala com a Google
 * quando alguém pede uma faixa de lá (o script é carregado sob demanda, nunca no
 * bundle), e que todo erro do player da Google (vídeo privado, removido, com
 * incorporação bloqueada) vira "faixa pulada com aviso" em vez de um player
 * travado sem explicação.
 *
 * O `window.YT` é um dublê: o que está sob teste é o envelope, que existe para
 * dar ao YouTube a mesma superfície do `MusicEngine` (`play`/`pause`/`seek`/
 * `positionSec`) — o `Room` trata as três origens pelo mesmo caminho.
 *
 * **O que mudou nesta rodada, e por quê.** O envelope não reusa mais o iframe:
 * cada faixa constrói um `YT.Player` novo e derruba o anterior. O caminho de
 * reuso zerava `this.ready` e nunca o restaurava — `onReady` é evento de
 * *construção* e não dispara de novo em `loadVideoById` —, e como todo comando
 * era guardado por `this.ready`, pular uma faixa deixava play/pause e volume
 * mudos com o vídeo anterior ainda tocando. Os dois casos que fixavam o reuso
 * foram invertidos de propósito; o dublê ainda expõe `loadVideoById` justamente
 * para o teste poder afirmar que ele **nunca** é chamado.
 *
 * Duas exigências que o dublê tem que cumprir para as asserções valerem:
 *
 * - `YT.Player` **substitui** o elemento que recebe por um `<iframe>`. O dublê
 *   faz o mesmo no nó falso, senão "no máximo um iframe sob o host" mediria o
 *   nada e passaria sempre.
 * - `autoReady: false` deixa o teste segurar o `onReady` e agir no meio do
 *   carregamento — é a única forma de exercitar a corrida entre dois `load()` e
 *   a intenção de reprodução pendente.
 *
 * `loadYouTubeApi` guarda a promessa num módulo, então cada caso que exercita o
 * carregamento importa uma instância nova do módulo (o `?n=` no specifier).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const API_SRC = 'https://www.youtube.com/iframe_api';

// ------------------------------------------------------------- dublês do DOM

const injected = [];

/**
 * Nó de árvore com o mínimo que o envelope usa: `appendChild`, `removeChild` e
 * `firstChild`. Precisa ser uma árvore de verdade (e não um objeto qualquer)
 * porque o envelope esvazia o host filho a filho no teardown, e é essa varredura
 * que o teste de "zero iframe" está medindo.
 */
function makeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    src: '',
    async: false,
    onerror: null,
    get firstChild() {
      return this.children[0] || null;
    },
    appendChild(child) {
      child.parent?.removeChild(child);
      child.parent = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parent = null;
      return child;
    },
  };
}

globalThis.document = {
  head: { appendChild: (node) => injected.push(node) },
  createElement: (tag) => makeNode(tag),
  querySelector: (selector) => injected.find((node) => node.src && selector.includes(node.src)) || null,
};
globalThis.window = {};

/** Quantos `<iframe>` existem na subárvore — a asserção central do áudio órfão. */
function countIframes(node) {
  if (!node) return 0;
  const self = node.tagName === 'IFRAME' ? 1 : 0;
  return node.children.reduce((total, child) => total + countIframes(child), self);
}

/**
 * Deixa correr tudo que estiver pendente. Um `await Promise.resolve()` não basta
 * para o `load()` chegar até `new YT.Player`: há o `await loadYouTubeApi()` e a
 * cadeia de `.catch()` dele no meio. Um turno de macrotask drena os dois.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeYT({ autoReady = true } = {}) {
  const YT = { PlayerState: { ENDED: 0, PLAYING: 1, BUFFERING: 3 }, players: [], autoReady };
  YT.Player = class FakePlayer {
    constructor(mount, options) {
      this.mount = mount;
      this.options = options;
      this.calls = [];
      this.state = 2; // pausado
      this.duration = 245;
      this.title = 'Faixa do YouTube';
      this.currentTime = 0;
      this.volume = 100;
      this.destroyThrows = false;
      this.destroyed = false;

      // O player real troca o elemento recebido por um `<iframe>`; o dublê faz o
      // mesmo para que a contagem de iframes signifique alguma coisa.
      const parent = mount.parent;
      this.iframe = document.createElement('iframe');
      parent?.appendChild(this.iframe);
      if (mount.parent === parent) parent?.removeChild(mount);

      YT.players.push(this);
      // O player real avisa o `onReady` de forma assíncrona; fazer isso de
      // dentro do construtor deixaria `this.player` ainda nulo no envelope.
      if (YT.autoReady) setTimeout(() => this.fireReady(), 0);
    }

    /** Dispara o `onReady` na mão — o caminho de `autoReady: false`. */
    fireReady() {
      if (!this.destroyed) this.options.events.onReady?.({ target: this });
    }

    playVideo() {
      this.calls.push('playVideo');
      this.state = 1;
    }

    pauseVideo() {
      this.calls.push('pauseVideo');
      this.state = 2;
    }

    stopVideo() {
      this.calls.push('stopVideo');
    }

    seekTo(seconds, allowSeekAhead) {
      this.calls.push(['seekTo', seconds, allowSeekAhead]);
      this.currentTime = seconds;
    }

    setVolume(value) {
      this.calls.push(['setVolume', value]);
      this.volume = value;
    }

    /**
     * Continua no dublê **de propósito**: o envelope não pode mais chamá-la, e a
     * forma de provar isso é ela existir e nunca aparecer em `calls`.
     */
    loadVideoById({ videoId, startSeconds }) {
      this.calls.push(['loadVideoById', videoId, startSeconds]);
    }

    getDuration() {
      return this.duration;
    }

    getVideoData() {
      return { title: this.title };
    }

    getCurrentTime() {
      return this.currentTime;
    }

    getPlayerState() {
      return this.state;
    }

    destroy() {
      this.calls.push('destroy');
      this.destroyed = true;
      // Um `destroy()` que estoura deixa o iframe onde estava: é o host varrido
      // pelo envelope que precisa dar conta, e é isso que o caso AC8 mede.
      if (this.destroyThrows) throw new Error('iframe já removido');
      this.iframe.parent?.removeChild(this.iframe);
    }
  };
  return YT;
}

let moduleCount = 0;
function freshModule() {
  moduleCount += 1;
  return import(`../src/lib/youtubePlayer.js?n=${moduleCount}`);
}

function makePlayer(Ctor) {
  const host = makeNode('div');
  const events = { ended: [], errors: [], durations: [], titles: [] };
  const player = new Ctor({
    host,
    onEnded: (videoId) => events.ended.push(videoId),
    onError: (payload) => events.errors.push(payload),
    onDurationKnown: (videoId, value) => events.durations.push([videoId, value]),
    onTitle: (videoId, title) => events.titles.push([videoId, title]),
  });
  return { player, events, host };
}

/** Nenhuma faixa deste arquivo pode ter passado pelo caminho de reuso. */
function assertNoReuse(YT) {
  const reused = YT.players.filter((p) => p.calls.some((c) => Array.isArray(c) && c[0] === 'loadVideoById'));
  assert.equal(reused.length, 0, 'loadVideoById é o caminho de reuso que a correção removeu');
}

// -------------------------------------------------------------- flag e API

test('a origem YouTube vem ligada por padrão nesta instalação', async () => {
  const { isYouTubeEnabled } = await freshModule();
  assert.equal(isYouTubeEnabled(), true);
});

test('a API é carregada sob demanda e o hook global de outro consumidor é preservado', async () => {
  injected.length = 0;
  globalThis.window = {};
  const { loadYouTubeApi } = await freshModule();

  let previousCalled = 0;
  window.onYouTubeIframeAPIReady = () => {
    previousCalled += 1;
  };

  const pending = loadYouTubeApi();
  assert.equal(injected.length, 1, 'nada de script de terceiro antes de alguém pedir YouTube');
  assert.equal(injected[0].src, API_SRC);
  assert.equal(injected[0].async, true);

  const YT = fakeYT();
  window.YT = YT;
  window.onYouTubeIframeAPIReady();

  assert.equal(await pending, YT);
  assert.equal(previousCalled, 1, 'sobrescrever o hook sem encadear quebraria outro consumidor');

  // A segunda chamada reaproveita a promessa: um script só na página.
  assert.equal(await loadYouTubeApi(), YT);
  assert.equal(injected.length, 1);
});

test('API já presente na página resolve sem injetar script nenhum', async () => {
  injected.length = 0;
  const YT = fakeYT();
  globalThis.window = { YT };
  const { loadYouTubeApi } = await freshModule();

  assert.equal(await loadYouTubeApi(), YT);
  assert.equal(injected.length, 0);
});

test('API bloqueada rejeita e deixa uma tentativa futura acontecer', async () => {
  injected.length = 0;
  globalThis.window = {};
  const { loadYouTubeApi } = await freshModule();

  const pending = loadYouTubeApi();
  injected[0].onerror();
  await assert.rejects(pending, /bloqueada/);

  // A promessa não pode ficar cacheada como rejeitada: a próxima tentativa
  // (outra faixa, outra sessão de rede) precisa poder injetar de novo.
  injected.length = 0;
  const retry = loadYouTubeApi();
  assert.equal(injected.length, 1);
  injected[0].onerror(); // e encerra o temporizador de 15s da tentativa
  await assert.rejects(retry, /bloqueada/);
});

// ------------------------------------------------------------------ envelope

test('carregar a faixa anuncia duração e título e não sai tocando sozinha', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, events, host } = makePlayer(YouTubeTrackPlayer);

  assert.equal(await player.load('dQw4w9WgXcQ', { startSeconds: 30 }), true);

  const inner = YT.players[0];
  assert.equal(inner.options.videoId, 'dQw4w9WgXcQ');
  assert.equal(inner.options.playerVars.playsinline, 1);
  assert.equal(inner.options.playerVars.controls, 0);
  assert.equal(inner.options.playerVars.start, 30);
  assert.deepEqual(events.durations, [['dQw4w9WgXcQ', 245]]);
  assert.deepEqual(events.titles, [['dQw4w9WgXcQ', 'Faixa do YouTube']]);
  assert.ok(inner.calls.includes('pauseVideo'));
  assert.ok(!inner.calls.includes('playVideo'));
  assert.equal(countIframes(host), 1);
});

test('com autoplay a faixa começa assim que o player fica pronto', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  await player.load('dQw4w9WgXcQ', { startSeconds: 0, autoplay: true });

  assert.ok(YT.players[0].calls.includes('playVideo'));
});

test('AC1. a faixa seguinte constrói um player novo, destrói o anterior e deixa um iframe só', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, host } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');
  const first = YT.players[0];

  assert.equal(await player.load('aaaaaaaaaaa', { startSeconds: 12 }), true);

  assert.equal(YT.players.length, 2, 'reusar o iframe é o bug; construir de novo é a correção');
  assert.ok(first.calls.includes('destroy'), 'o player anterior tem que cair');
  assert.equal(YT.players[1].options.videoId, 'aaaaaaaaaaa');
  assert.equal(YT.players[1].options.playerVars.start, 12);
  assert.equal(player.videoId, 'aaaaaaaaaaa');
  assert.equal(countIframes(host), 1, 'dois iframes sob o host é o áudio órfão que o usuário relatou');
  assertNoReuse(YT);
});

test('AC2. depois da troca, play, pause, volume e seek chegam ao player corrente', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');
  await player.load('aaaaaaaaaaa');

  const [first, second] = YT.players;
  const firstCallsBefore = first.calls.length;

  await player.play();
  player.setVolume(0.4);
  player.seek(30);
  player.pause();

  assert.ok(second.calls.includes('playVideo'), 'play virando no-op é o sintoma relatado');
  assert.ok(second.calls.includes('pauseVideo'));
  assert.equal(second.volume, 40);
  assert.deepEqual(
    second.calls.find((c) => Array.isArray(c) && c[0] === 'seekTo'),
    ['seekTo', 30, true],
  );
  assert.equal(first.calls.length, firstCallsBefore, 'nada pode chegar ao player já derrubado');
});

test('AC3. o volume atravessa a troca de faixa sem a UI reenviar', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  player.setVolume(0.35); // antes de existir player: guarda para aplicar no onReady
  await player.load('dQw4w9WgXcQ');
  assert.equal(YT.players[0].volume, 35);

  await player.load('aaaaaaaaaaa');
  assert.equal(YT.players[1].volume, 35, 'faixa nova nascendo a 100% é o volume "que parou de responder"');

  player.setVolume(2);
  assert.equal(YT.players[1].volume, 100);
  player.setVolume(-1);
  assert.equal(YT.players[1].volume, 0);
  player.setVolume('alto');
  assert.equal(YT.players[1].volume, 100);
});

test('AC3/D5. volume e intenção pedidos durante o carregamento valem quando o player fica pronto', async () => {
  const YT = fakeYT({ autoReady: false });
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  // Sem autoplay: a intenção chega depois, no meio da janela de carregamento.
  const pending = player.load('dQw4w9WgXcQ', { autoplay: false });
  await tick();
  assert.equal(player.loading, true);

  await player.play();
  player.setVolume(0.6);
  assert.equal(YT.players[0].calls.includes('playVideo'), false, 'ainda não está pronto para receber comando');

  YT.players[0].fireReady();
  assert.equal(await pending, true);

  assert.ok(YT.players[0].calls.includes('playVideo'), 'descartar a intenção devolve "o botão não faz nada"');
  assert.equal(YT.players[0].volume, 60);
  assert.equal(player.loading, false);
});

test('D5. a intenção mais recente vence o autoplay com que o load começou', async () => {
  const YT = fakeYT({ autoReady: false });
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  const pending = player.load('dQw4w9WgXcQ', { autoplay: true });
  await tick();
  player.pause(); // pausar 200ms depois de pular tem que valer

  YT.players[0].fireReady();
  await pending;

  assert.ok(YT.players[0].calls.includes('pauseVideo'));
  assert.ok(!YT.players[0].calls.includes('playVideo'));
});

test('AC4. stop deixa zero iframe e o envelope utilizável; destroy deixa zero iframe e inerte', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, host } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');

  player.stop();

  assert.equal(countIframes(host), 0, 'stopVideo deixando o iframe de pé é o áudio órfão de YouTube→arquivo');
  assert.equal(player.videoId, null);
  assert.equal(player.player, null);
  assert.equal(player.playing, false);

  assert.equal(await player.load('aaaaaaaaaaa'), true, 'stop não pode inutilizar o envelope');
  assert.equal(countIframes(host), 1);

  player.destroy();
  assert.equal(countIframes(host), 0);
  assert.equal(await player.load('bbbbbbbbbbb'), false, 'nada volta a tocar depois do destroy');
  assert.equal(YT.players.length, 2);
});

test('AC5. dois loads em sequência terminam com um player só, o da última chamada', async () => {
  const YT = fakeYT({ autoReady: false });
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, host } = makePlayer(YouTubeTrackPlayer);

  const first = player.load('dQw4w9WgXcQ');
  await tick();
  const second = player.load('aaaaaaaaaaa');
  await tick();

  assert.equal(YT.players.length, 2);
  assert.ok(YT.players[0].destroyed, 'o load novo derruba o anterior antes de qualquer espera');

  // O `onReady` atrasado do player já derrubado não pode liberar a espera do
  // load novo — soltar `true` cedo faria o hook publicar posição de um player
  // que ainda não existe.
  YT.players[0].fireReady();
  await tick();

  YT.players[1].fireReady();
  assert.equal(await second, true);
  assert.equal(await first, false, 'o load obsoleto devolve false');
  assert.equal(countIframes(host), 1);
  assert.equal(player.videoId, 'aaaaaaaaaaa');
});

test('AC6. ENDED e onError de um player já derrubado não avançam a faixa nova', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, events } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');
  const first = YT.players[0];
  await player.load('aaaaaaaaaaa');

  first.options.events.onStateChange({ data: YT.PlayerState.ENDED });
  first.options.events.onError({ data: 150 });

  assert.deepEqual(events.ended, [], 'o ENDED atrasado é o que pulava duas faixas de uma vez');
  assert.deepEqual(events.errors, []);

  // E depois do stop também não: a geração já mudou.
  player.stop();
  YT.players[1].options.events.onStateChange({ data: YT.PlayerState.ENDED });
  assert.deepEqual(events.ended, []);
});

test('AC7. loading é verdadeiro entre o load e o onReady, e falso depois', async () => {
  const YT = fakeYT({ autoReady: false });
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  assert.equal(player.loading, false);
  const pending = player.load('dQw4w9WgXcQ');
  await tick();
  assert.equal(player.loading, true);
  // Enquanto carrega, a posição responde 0 — e é por isso que o hook usa
  // `loading` em vez de `??` para decidir se publica.
  assert.equal(player.positionSec, 0);

  YT.players[0].fireReady();
  await pending;
  assert.equal(player.loading, false);
});

test('AC7. API bloqueada no meio do load não deixa loading preso', async () => {
  injected.length = 0;
  globalThis.window = {};
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  const pending = player.load('dQw4w9WgXcQ');
  await tick();
  injected[0].onerror();

  await assert.rejects(pending, /bloqueada/);
  assert.equal(player.loading, false, 'loading preso faz o dono parar de publicar posição para sempre');
});

test('AC8. destroy sobrevive a um iframe que já sumiu e ainda esvazia o host', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, host } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');
  YT.players[0].destroyThrows = true;

  assert.doesNotThrow(() => player.destroy());
  assert.equal(player.player, null);
  assert.equal(player.playing, false);
  assert.equal(countIframes(host), 0, 'o host varrido é a rede de segurança quando o destroy estoura');
});

test('AC1. o erro do player chega com o código e o vídeo, num objeto', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, events } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');

  YT.players[0].options.events.onError({ data: 150 });

  assert.deepEqual(events.errors, [{ reason: 'youtube-error', code: 150, videoId: 'dQw4w9WgXcQ' }]);
});

test('o fim do vídeo é anunciado para a fila seguir sozinha', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, events } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');

  YT.players[0].options.events.onStateChange({ data: YT.PlayerState.ENDED });

  assert.deepEqual(events.ended, ['dQw4w9WgXcQ']);
});

test('posição, duração e estados só falam depois de o player estar pronto', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  assert.equal(player.positionSec, 0);
  assert.equal(player.durationSec, null);
  assert.equal(player.playing, false);
  assert.equal(player.buffering, false);

  await player.load('dQw4w9WgXcQ');
  const inner = YT.players[0];
  inner.currentTime = 61.5;
  inner.state = YT.PlayerState.PLAYING;

  assert.equal(player.positionSec, 61.5);
  assert.equal(player.durationSec, 245);
  assert.equal(player.playing, true);
  assert.equal(player.buffering, false);

  inner.state = YT.PlayerState.BUFFERING;
  assert.equal(player.buffering, true, 'corrigir posição durante buffering só aumenta a deriva');
  assert.equal(player.playing, false);
});

test('seek nunca vai a negativo e ignora valor que não é número', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');
  const inner = YT.players[0];

  player.seek(42);
  assert.deepEqual(inner.calls.at(-1), ['seekTo', 42, true]);
  player.seek(-5);
  assert.deepEqual(inner.calls.at(-1), ['seekTo', 0, true]);

  const before = inner.calls.length;
  player.seek(Number.NaN);
  assert.equal(inner.calls.length, before);
});

test('quinze faixas seguidas deixam um iframe só e o último player respondendo', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, host } = makePlayer(YouTubeTrackPlayer);
  player.setVolume(0.5);

  // Ids sintéticos de 11 caracteres, o alfabeto que o envelope aceita.
  const ids = Array.from({ length: 15 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
  for (const id of ids) {
    assert.equal(await player.load(id, { autoplay: true }), true, `faixa ${id}`);
    assert.equal(countIframes(host), 1, `faixa ${id} deixou iframe órfão`);
    assert.equal(player.videoId, id);
  }

  const last = YT.players.at(-1);
  assert.equal(YT.players.length, 15);
  assert.equal(last.volume, 50, 'o volume não pode se perder no caminho');
  assert.ok(last.calls.includes('playVideo'));
  player.pause();
  assert.ok(last.calls.includes('pauseVideo'));
  assert.equal(YT.players.filter((p) => !p.destroyed).length, 1);
  assertNoReuse(YT);
});

// -------------------------------------------------------------------- oEmbed

/**
 * O título real do vídeo, e o combinado que vem com ele: a requisição sai só de
 * quem enfileira, nunca bloqueia o enfileiramento e não existe com a flag
 * desligada.
 *
 * Sobre `enabled`: `isYouTubeEnabled()` lê `import.meta.env`, que fora do Vite
 * responde sempre `true` — então o parâmetro é a costura que torna a guarda
 * testável aqui. O que estes casos provam é o **mecanismo** (com a guarda
 * fechada nenhuma requisição nasce), não a ligação com a variável de ambiente;
 * essa fica no valor padrão do próprio parâmetro (`= isYouTubeEnabled()`).
 */
test('AC9. oEmbed respondendo devolve o título do vídeo', async () => {
  const { fetchYouTubeTitle } = await freshModule();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push([url, options]);
    return { ok: true, json: async () => ({ title: '  Never Gonna Give You Up  ' }) };
  };

  const title = await fetchYouTubeTitle('dQw4w9WgXcQ', { fetchImpl });

  assert.equal(title, 'Never Gonna Give You Up');
  const [url, options] = seen[0];
  assert.ok(url.startsWith('https://www.youtube.com/oembed?'));
  assert.ok(url.includes(encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')));
  assert.ok(url.includes('format=json'));
  assert.equal(options.credentials, 'omit', 'sem cookie: o oEmbed é público');
  assert.equal(options.referrerPolicy, 'no-referrer', 'a Google não precisa saber de que sala veio');
});

test('AC10. rede caída, resposta não-ok, JSON inválido ou título vazio devolvem null', async () => {
  const { fetchYouTubeTitle } = await freshModule();

  const cases = {
    'rede caída': async () => {
      throw new TypeError('Failed to fetch');
    },
    'CORS/404': async () => ({ ok: false, json: async () => ({ title: 'não devia ser lido' }) }),
    'não é JSON': async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
    'título vazio': async () => ({ ok: true, json: async () => ({ title: '   ' }) }),
    'título que não é texto': async () => ({ ok: true, json: async () => ({ title: 42 }) }),
    'corpo vazio': async () => ({ ok: true, json: async () => null }),
  };

  for (const [label, fetchImpl] of Object.entries(cases)) {
    assert.equal(await fetchYouTubeTitle('dQw4w9WgXcQ', { fetchImpl }), null, label);
  }
});

test('AC10. cancelar pelo signal devolve null sem lançar', async () => {
  const { fetchYouTubeTitle } = await freshModule();
  const outer = new AbortController();
  // O prazo real é de 2,5s; abortar de fora exercita o mesmo caminho sem
  // segurar a suíte por esse tempo.
  const fetchImpl = (url, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('AbortError')));
    });

  const pending = fetchYouTubeTitle('dQw4w9WgXcQ', { fetchImpl, signal: outer.signal });
  outer.abort();

  assert.equal(await pending, null);
});

test('AC10. id fora do alfabeto do YouTube nem chega a virar requisição', async () => {
  const { fetchYouTubeTitle } = await freshModule();
  const fetchImpl = () => assert.fail('URL montada com lixo não pode sair daqui');

  for (const bad of ['', 'curto', 'longo-demais-mesmo', '../../etc/passwd', null, 42]) {
    assert.equal(await fetchYouTubeTitle(bad, { fetchImpl }), null, JSON.stringify(bad));
  }
});

test('AC12. com a origem YouTube desligada nenhuma requisição nasce', async () => {
  const { fetchYouTubeTitle } = await freshModule();
  const fetchImpl = () => assert.fail('nenhuma requisição à Google com a flag desligada');

  assert.equal(await fetchYouTubeTitle('dQw4w9WgXcQ', { enabled: false, fetchImpl }), null);
});

test('sem fetch no ambiente o título simplesmente não vem', async () => {
  const { fetchYouTubeTitle } = await freshModule();
  // Sem `fetchImpl` a função cai no `globalThis.fetch` — que **existe** neste
  // node e alcança a internet de verdade. Tirá-lo do caminho é o que mantém a
  // promessa do arquivo: nenhum caso desta suíte fala com a Google.
  const original = globalThis.fetch;
  delete globalThis.fetch;
  try {
    assert.equal(await fetchYouTubeTitle('dQw4w9WgXcQ', { enabled: true }), null);
  } finally {
    globalThis.fetch = original;
  }
});

// -------------------------------------- classificação do erro e política

/**
 * O que segue cobre a correção da WTK-MEET-13. O bug era de argumento
 * posicional: o envelope emitia `('youtube-error', 150)` e o handler declarava
 * `(code, entryId)` — o `150` passava pela guarda `typeof entryId === 'string'`
 * como "não é string", caía no fallback e **o código nunca era lido**. Todos os
 * erros do YouTube, do vídeo removido ao soluço momentâneo do player, recebiam o
 * mesmo tratamento: aviso genérico e faixa fora da fila da sala inteira.
 *
 * Por isso a decisão inteira — classificar, escolher entre retentar/pular/só
 * avisar, contar tentativa e conferir propriedade — é pura e vive no módulo:
 * `useMusicRoom.js` é um hook React, e este projeto roda `node --test` sem
 * renderer. Aqui é o único lugar onde "peer que não é dono nunca pula a faixa"
 * pode virar asserção em vez de leitura de código.
 */

/** Todos os códigos que interessam, mais o que a API não documenta. */
const ERROR_CODES = [2, 5, 100, 101, 150, 153, 999, null, undefined, '150', NaN];

test('AC2. só 5 e 153 são transitórios; o resto é sentença, inclusive o desconhecido', async () => {
  const { classifyYouTubeError } = await freshModule();

  assert.deepEqual(classifyYouTubeError(2), { code: 2, kind: 'invalid-id', transient: false });
  assert.deepEqual(classifyYouTubeError(5), { code: 5, kind: 'html5', transient: true });
  assert.deepEqual(classifyYouTubeError(100), { code: 100, kind: 'unavailable', transient: false });
  assert.deepEqual(classifyYouTubeError(101), { code: 101, kind: 'not-embeddable', transient: false });
  assert.deepEqual(classifyYouTubeError(150), { code: 150, kind: 'not-embeddable', transient: false });
  assert.deepEqual(classifyYouTubeError(153), { code: 153, kind: 'referrer', transient: true });

  // Sem evidência de que recarregar ajuda, o conservador é pular — e o código
  // cru sobrevive no retorno justamente para poder ser logado e reclassificado.
  for (const code of [999, null, undefined, '150', NaN, {}]) {
    const result = classifyYouTubeError(code);
    assert.equal(result.kind, 'unknown', JSON.stringify(code));
    assert.equal(result.transient, false, JSON.stringify(code));
  }

  const transientCodes = ERROR_CODES.filter((code) => classifyYouTubeError(code).transient);
  assert.deepEqual(transientCodes, [5, 153]);
});

test('AC3. código permanente com peer dono pula na hora, e a mensagem diz o que houve', async () => {
  const { planYouTubeError } = await freshModule();
  const base = { entryId: 'e1', title: 'Faixa X', isOwner: true, attempts: null };

  for (const code of [2, 100, 101, 150, 999, null]) {
    const plan = planYouTubeError({ ...base, code });
    assert.equal(plan.action, 'skip', `código ${code}`);
    assert.equal(plan.code, typeof code === 'number' ? code : null);
    assert.match(plan.notice, /Faixa X/);
  }

  assert.match(planYouTubeError({ ...base, code: 2 }).notice, /não é um vídeo válido/);
  assert.match(planYouTubeError({ ...base, code: 100 }).notice, /removido ou privado/);
  // 101/150 é o caso acionável: o vídeo existe e toca — só não fora do YouTube.
  for (const code of [101, 150]) {
    assert.match(planYouTubeError({ ...base, code }).notice, /fora do YouTube/, `código ${code}`);
  }
});

test('AC4. transitório com contador zerado tenta de novo e conta a tentativa', async () => {
  const { planYouTubeError } = await freshModule();

  for (const code of [5, 153]) {
    for (const attempts of [null, undefined, { entryId: 'outra', count: 1 }, { entryId: 'e1', count: 0 }]) {
      const plan = planYouTubeError({ code, entryId: 'e1', title: 'Faixa X', isOwner: true, attempts });
      assert.equal(plan.action, 'retry', `código ${code} / ${JSON.stringify(attempts)}`);
      assert.deepEqual(plan.attempts, { entryId: 'e1', count: 1 });
      assert.match(plan.notice, /Tentando de novo/);
    }
  }
});

test('AC5. a segunda falha na mesma faixa não retenta: pula (dono) ou só avisa', async () => {
  const { planYouTubeError } = await freshModule();

  for (const code of [5, 153]) {
    const asOwner = planYouTubeError({
      code,
      entryId: 'e1',
      title: 'Faixa X',
      isOwner: true,
      attempts: { entryId: 'e1', count: 1 },
    });
    assert.equal(asOwner.action, 'skip', `código ${code}`);
    assert.match(asOwner.notice, /Não consegui tocar/);

    const asPeer = planYouTubeError({
      code,
      entryId: 'e1',
      title: 'Faixa X',
      isOwner: false,
      attempts: { entryId: 'e1', count: 1 },
    });
    assert.equal(asPeer.action, 'notice-only', `código ${code}`);
  }
});

test('AC5. nenhuma combinação produz duas retentativas na mesma faixa — o laço não existe', async () => {
  const { planYouTubeError } = await freshModule();

  // Varredura fechada: qualquer contador já ≥ 1 na faixa corrente, qualquer
  // código, qualquer papel. Se algum caminho devolvesse 'retry' aqui, um vídeo
  // que erra sempre recarregaria para sempre — que é o que o card proíbe.
  for (const code of ERROR_CODES) {
    for (const count of [1, 2, 7]) {
      for (const isOwner of [true, false]) {
        const plan = planYouTubeError({
          code,
          entryId: 'e1',
          title: 'Faixa X',
          isOwner,
          attempts: { entryId: 'e1', count },
        });
        assert.notEqual(plan.action, 'retry', `código ${code}, count ${count}, dono ${isOwner}`);
        assert.equal(plan.attempts.count, count, 'o contador esgotado não volta atrás');
      }
    }
  }

  // E a retentativa que falha de novo entrega o contador que já estava lá: a
  // sequência real (erro → retry → erro) termina em pulo, nunca em novo retry.
  const first = planYouTubeError({ code: 5, entryId: 'e1', isOwner: true, attempts: null });
  const second = planYouTubeError({ code: 5, entryId: 'e1', isOwner: true, attempts: first.attempts });
  assert.deepEqual([first.action, second.action], ['retry', 'skip']);
});

test('AC6. sem ser dono, nenhuma combinação de código, contador e título gera pulo', async () => {
  const { planYouTubeError } = await freshModule();

  for (const code of ERROR_CODES) {
    for (const attempts of [null, { entryId: 'e1', count: 0 }, { entryId: 'e1', count: 1 }, { entryId: 'z', count: 3 }]) {
      for (const title of ['Faixa X', '', null, undefined, '   ']) {
        const plan = planYouTubeError({ code, entryId: 'e1', title, isOwner: false, attempts });
        assert.notEqual(
          plan.action,
          'skip',
          `código ${code}, ${JSON.stringify(attempts)}, título ${JSON.stringify(title)}`,
        );
        assert.ok(['retry', 'notice-only'].includes(plan.action));
      }
    }
  }
});

test('AC6. sem entryId a decisão é só avisar, e o contador da faixa corrente fica intacto', async () => {
  const { planYouTubeError } = await freshModule();
  const attempts = { entryId: 'e1', count: 1 };

  for (const entryId of [null, undefined, '', 42]) {
    const plan = planYouTubeError({ code: 5, entryId, title: 'Faixa X', isOwner: true, attempts });
    assert.equal(plan.action, 'notice-only', JSON.stringify(entryId));
    assert.deepEqual(plan.attempts, attempts, 'erro de faixa desconhecida não pode zerar o contador da corrente');
  }
});

test('AC7. trocar de faixa zera o contador: a nova ganha a retentativa dela', async () => {
  const { planYouTubeError } = await freshModule();

  const esgotada = planYouTubeError({ code: 5, entryId: 'e1', isOwner: true, attempts: { entryId: 'e1', count: 1 } });
  assert.equal(esgotada.action, 'skip');

  const outraFaixa = planYouTubeError({ code: 5, entryId: 'e2', isOwner: true, attempts: esgotada.attempts });
  assert.equal(outraFaixa.action, 'retry', 'o contador é por entryId — a faixa nova não herda a desistência');
  assert.deepEqual(outraFaixa.attempts, { entryId: 'e2', count: 1 });
});

test('AC8. cinco mensagens distintas em pt-BR, com o título quando ele existe', async () => {
  const { planYouTubeError } = await freshModule();
  const notice = (code, extra = {}) =>
    planYouTubeError({ code, entryId: 'e1', title: 'Faixa X', isOwner: true, ...extra }).notice;

  const esgotado = { attempts: { entryId: 'e1', count: 1 } };
  const textos = [
    notice(5),                 // retentativa
    notice(2),                 // link inválido
    notice(100),               // indisponível
    notice(150),               // sem incorporação
    notice(5, esgotado),       // esgotado / desconhecido
  ];
  assert.equal(new Set(textos).size, 5, 'aviso repetido não dá sinal nenhum de progresso ao usuário');
  for (const texto of textos) assert.match(texto, /Faixa X/);
  // O mesmo texto genérico serve para transitório esgotado e para desconhecido.
  assert.equal(notice(999), notice(5, esgotado));

  // Sem título o aviso continua legível, nunca com “undefined” na cara.
  for (const title of [null, undefined, '', '   ', 42]) {
    for (const code of [2, 5, 100, 150, 999]) {
      const texto = planYouTubeError({ code, entryId: 'e1', title, isOwner: true }).notice;
      assert.match(texto, /A faixa/, JSON.stringify([code, title]));
      assert.doesNotMatch(texto, /undefined|null|NaN/);
    }
  }
});

test('AC9. playerVars leva enablejsapi e a origem da página quando ela existe', async () => {
  const YT = fakeYT();
  globalThis.window = { YT, location: { origin: 'https://meet.exemplo.br' } };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  await player.load('dQw4w9WgXcQ', { startSeconds: 42 });

  const { playerVars } = YT.players[0].options;
  assert.equal(playerVars.enablejsapi, 1);
  assert.equal(playerVars.origin, 'https://meet.exemplo.br');
  assert.equal(playerVars.start, 42, 'o resto do playerVars segue igual');
  globalThis.window = {};
});

test('AC9. sem origem http(s) de verdade a chave origin nem entra — e nada estoura', async () => {
  // Um `origin` que não bate com a página faz a IFrame API recusar **todos** os
  // vídeos: trocaria um erro intermitente por uma quebra total. Daí a omissão
  // ser o caminho seguro, e não um valor inventado.
  const semLocation = () => ({ YT: fakeYT() });
  const casos = [
    ['sem location (o window dublê da suíte)', semLocation()],
    ['origin "null" de um contexto file://', { YT: fakeYT(), location: { origin: 'null' } }],
    ['origin vazio', { YT: fakeYT(), location: { origin: '' } }],
    ['origin que não é texto', { YT: fakeYT(), location: { origin: 42 } }],
    ['esquema não-http', { YT: fakeYT(), location: { origin: 'chrome-extension://abc' } }],
  ];

  for (const [label, fakeWindow] of casos) {
    globalThis.window = fakeWindow;
    const { YouTubeTrackPlayer } = await freshModule();
    const { player } = makePlayer(YouTubeTrackPlayer);

    await assert.doesNotReject(player.load('dQw4w9WgXcQ'), label);

    const { playerVars } = fakeWindow.YT.players[0].options;
    assert.equal(playerVars.enablejsapi, 1, label);
    assert.equal('origin' in playerVars, false, label);
  }
  globalThis.window = {};
});
