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
 * `loadYouTubeApi` guarda a promessa num módulo, então cada caso que exercita o
 * carregamento importa uma instância nova do módulo (o `?n=` no specifier).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const API_SRC = 'https://www.youtube.com/iframe_api';

// ------------------------------------------------------------- dublês do DOM

const injected = [];

globalThis.document = {
  head: { appendChild: (node) => injected.push(node) },
  createElement: () => ({ src: '', async: false, onerror: null }),
  querySelector: (selector) => injected.find((node) => selector.includes(node.src)) || null,
};
globalThis.window = {};

function fakeYT() {
  const YT = { PlayerState: { ENDED: 0, PLAYING: 1, BUFFERING: 3 }, players: [] };
  YT.Player = class FakePlayer {
    constructor(container, options) {
      this.container = container;
      this.options = options;
      this.calls = [];
      this.state = 2; // pausado
      this.duration = 245;
      this.title = 'Faixa do YouTube';
      this.currentTime = 0;
      this.volume = 100;
      this.destroyThrows = false;
      YT.players.push(this);
      // O player real avisa o `onReady` de forma assíncrona; fazer isso de
      // dentro do construtor deixaria `this.player` ainda nulo no envelope.
      setTimeout(() => options.events.onReady?.({ target: this }), 0);
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
      if (this.destroyThrows) throw new Error('iframe já removido');
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
  const events = { ended: [], errors: [], durations: [], titles: [] };
  const player = new Ctor({
    container: { id: 'yt-host' },
    onEnded: (videoId) => events.ended.push(videoId),
    onError: (reason, code) => events.errors.push([reason, code]),
    onDurationKnown: (videoId, value) => events.durations.push([videoId, value]),
    onTitle: (videoId, title) => events.titles.push([videoId, title]),
  });
  return { player, events };
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
  const { player, events } = makePlayer(YouTubeTrackPlayer);

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
});

test('com autoplay a faixa começa assim que o player fica pronto', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  await player.load('dQw4w9WgXcQ', { startSeconds: 0, autoplay: true });

  assert.ok(YT.players[0].calls.includes('playVideo'));
});

test('a faixa seguinte reaproveita o mesmo iframe, sem construir outro player', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');

  assert.equal(await player.load('aaaaaaaaaaa', { startSeconds: 12 }), true);

  assert.equal(YT.players.length, 1);
  assert.deepEqual(YT.players[0].calls.at(-2), ['loadVideoById', 'aaaaaaaaaaa', 12]);
  assert.equal(player.videoId, 'aaaaaaaaaaa');
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

test('volume é local e traduzido para a escala do YouTube, com clamp', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);

  player.setVolume(0.35); // antes de existir player: guarda para aplicar no onReady
  await player.load('dQw4w9WgXcQ');
  assert.equal(YT.players[0].volume, 35);

  player.setVolume(2);
  assert.equal(YT.players[0].volume, 100);
  player.setVolume(-1);
  assert.equal(YT.players[0].volume, 0);
  player.setVolume('alto');
  assert.equal(YT.players[0].volume, 100);
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

test('destroy sobrevive a um iframe que já sumiu e deixa o envelope inerte', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');
  YT.players[0].destroyThrows = true;

  assert.doesNotThrow(() => player.destroy());
  assert.equal(player.player, null);
  assert.equal(player.playing, false);
  assert.equal(await player.load('aaaaaaaaaaa'), false, 'nada volta a tocar depois do destroy');
  assert.equal(YT.players.length, 1);
});

test('parar a faixa larga o vídeo corrente sem derrubar o player', async () => {
  const YT = fakeYT();
  globalThis.window = { YT };
  const { YouTubeTrackPlayer } = await freshModule();
  const { player } = makePlayer(YouTubeTrackPlayer);
  await player.load('dQw4w9WgXcQ');

  player.stop();

  assert.ok(YT.players[0].calls.includes('stopVideo'));
  assert.equal(player.videoId, null);
  assert.equal(player.player, YT.players[0]);
});
