/**
 * Origem YouTube — a única parte do player que depende de um terceiro, confinada
 * de propósito num arquivo só, que dá para desligar inteiro por flag
 * (`VITE_ENABLE_YOUTUBE`).
 *
 * **Por que YouTube toca em modo `local` e não retransmitido:** o player roda num
 * iframe cross-origin. Não existe API que dê acesso ao áudio dele — nem
 * `MediaElementSource`, nem captura de elemento, nada. As duas formas de
 * "retransmitir" seriam extrair o stream (viola os Termos de Serviço e exigiria
 * componente de servidor, que o escopo proíbe) ou capturar o áudio da aba, que
 * levaria junto a voz dos outros participantes e criaria realimentação. Então
 * cada client carrega o vídeo e a sincronização é por posição.
 *
 * **Consequência de privacidade, dita com todas as letras:** nesse modo o
 * navegador de *cada* participante fala com a Google, que passa a ver o IP de
 * todo mundo na sala e o que a sala está ouvindo. Isso contradiz a promessa de
 * "nenhuma dependência de terceiros" do `ARCHITECTURE.md` §1 — daí a flag e daí
 * o aviso explícito na UI ao adicionar a primeira faixa de YouTube da sessão.
 * Arquivo local e URL direta entregam o recurso sem nenhum terceiro envolvido.
 */

const API_SRC = 'https://www.youtube.com/iframe_api';
/**
 * oEmbed público, sem chave e sem cookie. **Serve a dois propósitos com uma
 * requisição só:** o corpo dá o título (enfeite) e o status dá o veredito de
 * disponibilidade (decisão de recusar o link no ato). Ver
 * `fetchYouTubeOEmbed`.
 */
const OEMBED_SRC = 'https://www.youtube.com/oembed';
/**
 * O título é enfeite; a faixa entra na fila com ou sem ele. Uma espera longa
 * atrasaria o enfileiramento para a sala inteira por causa de um nome.
 */
const OEMBED_TIMEOUT_MS = 2_500;
/** Mesmo alfabeto de `musicSources.js` — aqui só para não montar URL com lixo. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

let apiPromise = null;

/** A origem YouTube está ligada nesta instalação? */
export function isYouTubeEnabled() {
  const flag = import.meta.env?.VITE_ENABLE_YOUTUBE;
  return flag === undefined || flag === '' || flag === 'true' || flag === true;
}

/**
 * Carrega a IFrame Player API **sob demanda** — nada de script de terceiro no
 * bundle nem no `index.html`: quem nunca adiciona uma faixa de YouTube nunca
 * fala com a Google.
 */
export function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  if (typeof window === 'undefined') return Promise.reject(new Error('sem window'));

  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const timer = setTimeout(() => reject(new Error('IFrame API não carregou')), 15_000);
    // A API chama este hook global quando termina de carregar. Encadeamos com o
    // que já estiver lá para não pisar em outro consumidor.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      previous?.();
      resolve(window.YT);
    };
    if (!document.querySelector(`script[src="${API_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = API_SRC;
      script.async = true;
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error('IFrame API bloqueada'));
      };
      document.head.appendChild(script);
    }
  }).catch((err) => {
    apiPromise = null; // deixa uma tentativa futura acontecer
    throw err;
  });

  return apiPromise;
}

/**
 * Mapa de status do oEmbed para veredito de disponibilidade — **lista explícita,
 * e só ela recusa**.
 *
 * Trocar isto por `!response.ok` é a armadilha que o desenho evita: 429 é
 * resposta comum de rate-limit numa sala movimentada e 5xx acontece, e os dois
 * viram "ninguém consegue adicionar música" — um sintoma que ninguém rastreia
 * até aqui. Tudo que não está nesta lista é `unknown`, e `unknown` enfileira.
 */
const AVAILABILITY_BY_STATUS = new Map([
  [401, 'embed-blocked'], // o dono desabilitou a incorporação
  [403, 'embed-blocked'],
  [404, 'not-found'], // removido, privado, ou id que nunca existiu
]);

/** Nada foi provado sobre o vídeo: quem chama segue como seguia antes. */
function unknownMeta() {
  return { title: null, availability: 'unknown', status: null };
}

/**
 * O oEmbed público — sem chave de API, sem cookie, e só para quem **enfileira**
 * a faixa (os outros participantes recebem o nome pelo data channel, sem falar
 * com a Google).
 *
 * **Uma requisição, duas respostas.** O corpo traz o título, que é enfeite; o
 * status traz o veredito de disponibilidade, que é decisão — 401/403 dizem que o
 * dono desabilitou a incorporação, 404 diz que o vídeo foi removido, é privado
 * ou nunca existiu. Os dois saem da mesma resposta de propósito: sondar de novo
 * dobraria a exposição do IP do usuário à Google e criaria a chance de as duas
 * respostas discordarem.
 *
 * **Os dois campos são independentes.** Um 200 sem título legível é
 * `{ title: null, availability: 'ok' }` — vídeo tocável sem nome bonito, não
 * vídeo indisponível.
 *
 * Nunca lança: rede caída, CORS, corpo que não é JSON ou estouro do prazo
 * devolvem `unknown`, e `unknown` deixa a faixa entrar na fila. Um oEmbed fora
 * do ar não pode virar "ninguém na sala consegue adicionar música".
 *
 * A guarda de `isYouTubeEnabled()` é redundante com a de `parseSource` **de
 * propósito**: a promessa "nenhuma requisição à Google" tem que valer no ponto
 * onde a requisição nasceria, não só no chamador de hoje.
 */
export async function fetchYouTubeOEmbed(videoId, { signal, fetchImpl, enabled = isYouTubeEnabled() } = {}) {
  // `enabled` é a flag, e é parâmetro só porque `import.meta.env` não existe em
  // `node:test`: sem essa costura, "com a flag desligada nenhuma requisição
  // nasce" só seria verificável no navegador. O padrão continua sendo a flag.
  if (!enabled) return unknownMeta();
  if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) return unknownMeta();

  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) return unknownMeta();

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), OEMBED_TIMEOUT_MS) : null;
  const abort = () => controller?.abort();
  signal?.addEventListener?.('abort', abort);

  try {
    const watch = `https://www.youtube.com/watch?v=${videoId}`;
    const url = `${OEMBED_SRC}?url=${encodeURIComponent(watch)}&format=json`;
    const response = await doFetch(url, {
      signal: controller?.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const status = typeof response?.status === 'number' ? response.status : null;
    if (!response?.ok) {
      return { title: null, availability: AVAILABILITY_BY_STATUS.get(status) || 'unknown', status };
    }
    const data = await response.json();
    const title = typeof data?.title === 'string' ? data.title.trim() : '';
    return { title: title || null, availability: 'ok', status };
  } catch {
    // Rede, CORS, abort, JSON inválido: não houve prova nenhuma sobre o vídeo, e
    // o que não é prova não recusa.
    return unknownMeta();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

/**
 * Só o título, para quem só quer o título.
 *
 * Envelope fino sobre `fetchYouTubeOEmbed`, e não uma função substituída: o
 * contrato `string | null` que nunca lança já é consumido e testado, e mantê-lo
 * evita obrigar todo chamador futuro a desembrulhar um objeto para pegar um
 * nome. Um título bonito continua não valendo bloquear o enfileiramento.
 */
export async function fetchYouTubeTitle(videoId, options) {
  const { title } = await fetchYouTubeOEmbed(videoId, options);
  return title;
}

/**
 * Envelope fino sobre o player do YouTube, com a mesma superfície do
 * `MusicEngine` (`play`/`pause`/`seek`/`positionSec`), para o `Room` tratar as
 * três origens pelo mesmo caminho.
 *
 * **Cada faixa constrói um `YT.Player` novo e derruba o anterior.** Não existe
 * caminho de reuso, e a ausência dele é a correção: o único instante em que a
 * IFrame API garante um estado íntegro é o `onReady` da construção, que **não**
 * dispara de novo em `loadVideoById`. Reusar obriga o envelope a manter à mão um
 * espelho de um estado que a API não reexpõe — e foi esse espelho divergindo que
 * deixava play/pause e volume mudos depois de pular uma faixa. Recriar faz de
 * "faixa nova" o mesmo caminho de código que "a primeira faixa".
 *
 * Duas consequências que o resto da classe existe para sustentar:
 *
 * - **O envelope é dono do nó de mount, não do host.** `YT.Player` *substitui* o
 *   elemento que recebe por um `<iframe>`, e `destroy()` remove esse iframe: um
 *   container fixo capturado na construção não sobreviveria ao segundo `load()`.
 *   O React cuida do host; de tudo que estiver dentro dele, cuidamos nós.
 * - **Toda troca tem uma janela em que o player não está pronto.** `play`,
 *   `pause` e o volume pedidos nessa janela ficam guardados em `desiredPlaying`/
 *   `volume` e são aplicados no `onReady` — descartá-los devolveria, em outra
 *   forma, o mesmo sintoma de "o botão não faz nada".
 *
 * A `generation` é o que impede o evento de um iframe já derrubado de agir sobre
 * a faixa nova: um `ENDED` atrasado chamaria `onEnded` com a faixa **corrente**
 * e a fila pularia duas de uma vez, de forma intermitente.
 */
export class YouTubeTrackPlayer {
  constructor({ host, onEnded, onError, onDurationKnown, onTitle } = {}) {
    this.host = host;
    this.onEnded = onEnded;
    this.onError = onError;
    this.onDurationKnown = onDurationKnown;
    this.onTitle = onTitle;
    this.player = null;
    this.mount = null;
    this.videoId = null;
    this.ready = false;
    this.destroyed = false;
    this.volume = 1;
    /** Intenção de reprodução, viva também enquanto o player carrega. */
    this.desiredPlaying = false;
    /** Incrementa a cada `load`/`stop`/`destroy`: identifica a faixa vigente. */
    this.generation = 0;
    this._loading = false;
    /** `{ generation, resolve }` do `load` que espera o `onReady`. */
    this._pendingReady = null;
  }

  /** Verdadeiro entre o início do `load()` e o `onReady` da faixa corrente. */
  get loading() {
    return this._loading;
  }

  async load(videoId, { startSeconds = 0, autoplay = false } = {}) {
    if (this.destroyed || !this.host) return false;

    const generation = (this.generation += 1);
    // Derruba a faixa anterior **antes** de qualquer espera: um iframe vivo
    // enquanto o próximo carrega é o áudio órfão que o usuário relatou.
    this._teardown();
    this.videoId = videoId;
    this.desiredPlaying = !!autoplay;
    this._loading = true;

    let YT;
    try {
      YT = await loadYouTubeApi();
    } catch (err) {
      // API bloqueada: sem player, mas `loading` não pode ficar preso — ele é o
      // que faz o dono deixar de publicar posição.
      if (this.generation === generation) this._loading = false;
      throw err;
    }
    if (this._stale(generation)) return false;

    const mount = document.createElement('div');
    this.host.appendChild(mount);
    this.mount = mount;

    let instance = null;
    let readyFired = false;

    instance = new YT.Player(mount, {
      videoId,
      // `playsinline` evita o player em tela cheia no iOS; `rel: 0` corta a
      // enxurrada de sugestões no fim do vídeo.
      playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, start: Math.floor(startSeconds) },
      events: {
        onReady: (event) => {
          readyFired = true;
          // A API real avisa de forma assíncrona, mas um `onReady` disparado de
          // dentro do construtor deixaria `instance` ainda por atribuir: o
          // `event.target` é o mesmo player e resolve os dois casos.
          const player = instance || event?.target || null;
          if (player && this.generation === generation && !this.destroyed) {
            this.player = player;
            this.ready = true;
            this._loading = false;
            player.setVolume?.(Math.round(this.volume * 100));
            this._announceMetadata(videoId);
            // A intenção mais recente vence o `autoplay` com que o load começou.
            if (this.desiredPlaying) player.playVideo?.();
            else player.pauseVideo?.();
          }
          this._settleReady(generation);
        },
        onStateChange: (event) => {
          if (this._obsolete(generation, instance)) return;
          if (event.data === YT.PlayerState.ENDED) this.onEnded?.(videoId);
          if (event.data === YT.PlayerState.PLAYING) this._announceMetadata(videoId);
        },
        // Vídeo removido, privado ou com incorporação bloqueada. Vira "faixa
        // pulada com aviso" — nunca um player travado sem explicação.
        onError: (event) => {
          if (this._obsolete(generation, instance)) return;
          this.onError?.('youtube-error', event?.data);
        },
      },
    });
    // Guardado já: um `load` mais novo precisa poder derrubar este player mesmo
    // que o `onReady` dele nunca chegue.
    if (!this._stale(generation)) this.player = instance;

    if (!readyFired) {
      await new Promise((resolve) => {
        this._pendingReady = { generation, resolve };
      });
    }

    if (this._stale(generation)) {
      // Outro `load` assumiu enquanto este subia. Ele já derrubou este player no
      // `_teardown`; o `if` cobre o caso improvável de a ordem se inverter.
      if (this.player === instance) this._teardown();
      return false;
    }
    return true;
  }

  /** O `load` desta geração ainda manda? (usado depois de cada espera) */
  _stale(generation) {
    return this.destroyed || this.generation !== generation;
  }

  /** Evento chegando de um player que já não é o vigente. */
  _obsolete(generation, instance) {
    return this.destroyed || this.generation !== generation || this.player !== instance;
  }

  /**
   * Libera o `load` que espera o `onReady` — **só o da geração que o emitiu**.
   * Sem essa conferência, o `onReady` atrasado de um player já derrubado faria o
   * `load` novo devolver `true` antes de o player dele estar pronto.
   */
  _settleReady(generation) {
    const pending = this._pendingReady;
    if (!pending) return;
    if (generation !== undefined && pending.generation !== generation) return;
    this._pendingReady = null;
    pending.resolve();
  }

  _announceMetadata(videoId) {
    if (!this.ready || !this.player) return;
    const duration = this.player.getDuration?.();
    if (Number.isFinite(duration) && duration > 0) this.onDurationKnown?.(videoId, duration);
    const title = this.player.getVideoData?.()?.title;
    if (title) this.onTitle?.(videoId, title);
  }

  /**
   * Desmonta o player corrente e devolve o host vazio. Não mexe em `generation`
   * nem em `destroyed`: quem chama decide se isto é uma troca de faixa, um
   * `stop()` ou o fim do envelope.
   */
  _teardown() {
    const player = this.player;
    this.player = null;
    this.ready = false;
    this._loading = false;
    try {
      player?.destroy?.();
    } catch {
      // iframe já removido
    }
    this.mount = null;
    // `destroy()` remove o iframe que substituiu o mount; o que sobrar é lixo
    // nosso, e o host precisa voltar vazio para o próximo `load`.
    const host = this.host;
    while (host?.firstChild) host.removeChild(host.firstChild);
    // Um `load` esperando o `onReady` deste player não pode ficar pendurado.
    this._settleReady();
  }

  play() {
    // Registrada mesmo durante o carregamento: o `onReady` aplica a mais recente.
    this.desiredPlaying = true;
    if (this.ready) this.player?.playVideo?.();
    return Promise.resolve(true);
  }

  pause() {
    this.desiredPlaying = false;
    if (this.ready) this.player?.pauseVideo?.();
  }

  seek(positionSec) {
    if (this.ready && Number.isFinite(positionSec)) {
      this.player?.seekTo?.(Math.max(0, positionSec), true);
    }
  }

  /** Volume é local, como em todo o resto do player (0–1 aqui, 0–100 no YT). */
  setVolume(value) {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
    if (this.ready) this.player?.setVolume?.(Math.round(this.volume * 100));
  }

  get positionSec() {
    return (this.ready && this.player?.getCurrentTime?.()) || 0;
  }

  get durationSec() {
    const value = this.ready && this.player?.getDuration?.();
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  get playing() {
    return this.ready && this.player?.getPlayerState?.() === 1;
  }

  get buffering() {
    return this.ready && this.player?.getPlayerState?.() === 3;
  }

  /**
   * Larga a faixa corrente: zero iframe no DOM, zero áudio — e o envelope
   * continua utilizável. Um `stopVideo()` que deixasse o iframe de pé é
   * exatamente o que produzia áudio órfão na transição YouTube→arquivo/URL.
   */
  stop() {
    this.generation += 1;
    this._teardown();
    this.videoId = null;
    this.desiredPlaying = false;
  }

  /** Como `stop()`, e o envelope não aceita mais nenhum `load()`. */
  destroy() {
    this.destroyed = true;
    this.generation += 1;
    this._teardown();
    this.videoId = null;
    this.desiredPlaying = false;
  }
}
