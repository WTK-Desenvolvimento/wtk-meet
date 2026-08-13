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
    onError: (reason, code) => events.errors.push([reason, code]),
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

test('vídeo privado, removido ou com incorporação bloqueada vira aviso, não travamento', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player, events } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');

  YT.players[0].options.events.onError({ data: 150 });

  assert.deepEqual(events.errors, [['youtube-error', 150]]);
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
