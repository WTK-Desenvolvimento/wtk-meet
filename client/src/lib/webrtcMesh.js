import { CHAT_CHANNEL_ID, CHAT_CHANNEL_LABEL, parseChannelPayload } from './chat.js';
import { isMusicMessage, snapshotMessage } from './musicProtocol.js';
import {
  getIceServers as defaultGetIceServers,
  getIceServersStatus,
  hasTurnServer,
} from './iceServers.js';

/**
 * Teto de banda do canal de música. O client roda com
 * `iceTransportPolicy: 'relay'`: **todo** o tráfego passa pelo TURN, e em mesh
 * quem toca sobe N−1 cópias. Com 6 pessoas são 5 × 96 kbps além das 5 cópias de
 * vídeo — sem teto explícito o Opus pode subir e disputar banda com o vídeo
 * exatamente quando a sala está cheia.
 */
const MUSIC_MAX_BITRATE = 96_000;

/**
 * Carência antes de reagir a `disconnected`.
 *
 * `disconnected` é frequentemente transitório — troca de rede, Wi-Fi oscilando,
 * um pacote de keepalive perdido — e o navegador volta sozinho na maioria das
 * vezes. Reiniciar o ICE em cima de uma recuperação natural é perda pura: gera
 * sinalização, descarta o progresso do ICE em andamento e ainda pode atrasar o
 * retorno que já estava a caminho.
 */
const DISCONNECTED_GRACE_MS = 5_000;

/**
 * Backoff das tentativas de recuperação, e o teto delas.
 *
 * O teto existe para que a desistência seja **explícita e logada**, em vez de o
 * par ficar tentando para sempre ou — como era antes — morrer na primeira
 * tentativa, em silêncio, para o resto da sessão.
 */
const RECOVERY_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * Quanto o lado polite espera antes de reiniciar o ICE por conta própria.
 *
 * O restart é do impolite por padrão: se os dois reiniciassem a cada queda de
 * rede, toda oscilação viraria duas offers — o dobro de sinalização exatamente
 * no momento em que a rede está pior. Mas se o impolite não voltar (aba fechada,
 * processo suspenso pelo SO, máquina dormindo), esperar por ele é esperar para
 * sempre. Daí a válvula: atrasada o bastante para não competir com o impolite
 * saudável, e o perfect negotiation resolve a colisão se os dois agirem.
 */
const POLITE_RESTART_VALVE_MS = 15_000;

/**
 * Espaçamento das verificações pós-negociação, e o teto delas.
 *
 * A primeira é curta porque é só para deixar a poeira baixar: quando a
 * negociação volta a `stable`, a segunda rodada automática da spec pode já estar
 * a caminho, e verificar antes dela veria um falso positivo. As seguintes são
 * mais espaçadas porque, se a primeira não resolveu, o problema não é de tempo.
 */
const VERIFY_DELAYS_MS = [750, 2_000, 5_000];

/**
 * Full-mesh WebRTC: one RTCPeerConnection per remote peer, capped by the
 * room's MAX_PARTICIPANTS on the signaling side. Media never routes through
 * the signaling server — this class only uses it to relay SDP/ICE.
 *
 * iceTransportPolicy:'relay' garante que todo tráfego passe pelo Cloudflare TURN.
 *
 * Três decisões carregam o resto do arquivo:
 *
 * 1. **Transceivers pré-criados, um canal de envio por finalidade.** Cada lado
 *    cria exatamente quatro transceivers `sendonly`, sempre na mesma ordem:
 *    áudio (mic), vídeo (câmera), vídeo (tela), áudio (música). Ligar/desligar
 *    câmera, entrar/sair de compartilhamento de tela e assumir a faixa que está
 *    tocando viram `replaceTrack()` num sender que já existe — sem renegociação
 *    de SDP.
 *
 *    A música tem canal próprio em vez de ser mixada no microfone, e isso não é
 *    preferência de estilo: `toggleMute` desliga o mic com `track.enabled =
 *    false`, então música mixada ali **silenciaria para a sala inteira** ao
 *    silenciar o microfone; o indicador de fala (que mede o stream do peer)
 *    ficaria permanentemente aceso no tile de quem toca; e ninguém conseguiria
 *    baixar a música sem baixar a voz junto.
 *
 *    O sentido inverso vem de quatro transceivers `recvonly` que o navegador cria
 *    ao aplicar a oferta do outro lado. Vale sublinhar por que não é um pareamento
 *    bidirecional: a spec só permite associar uma m-line remota a um transceiver
 *    local pré-existente quando ele foi criado por `addTrack()` — transceivers de
 *    `addTransceiver()` nunca são pareados implicitamente. Daí a classificação em
 *    `_classifyTransceiver`: identidade de objeto para os nossos, posição entre os
 *    remotos (que chegam na ordem das m-lines, ou seja, na ordem em que o outro
 *    lado os criou) para os deles.
 * 2. **Perfect negotiation.** Mesmo sem precisar renegociar no caminho feliz, a
 *    negociação inicial é simétrica (os dois lados disparam
 *    `onnegotiationneeded`) e qualquer renegociação futura pode colidir. O papel
 *    polite/impolite sai de uma comparação lexicográfica determinística dos
 *    socket ids, que dá resultados opostos nas duas pontas por construção.
 * 3. **Data channel negociado fora de banda.** `negotiated: true, id: 0`: os
 *    dois lados criam o canal com o mesmo id, então não há `ondatachannel` nem
 *    corrida sobre quem cria. É por ele que trafegam chat e estado de
 *    câmera/tela — nunca pelo servidor de sinalização.
 */
export class WebRTCMesh {
  constructor({
    signaling,
    iceServers,
    localStream,
    getSelfId,
    getRoomKey,
    onRemoteStream,
    onRemoteScreen,
    onRemotePeerState,
    onChatMessage,
    onRemoteStreamClosed,
    onPeerStateChange,
    onRemoteMusic,
    onMusicMessage,
    getMusicSnapshot,
    // Opcional e com default de módulo **de propósito**: `pages/Room.jsx` está
    // fora do alcance desta entrega (é da task irmã, noutra worktree), então
    // nada aqui pode passar a exigir um parâmetro novo de quem constrói o mesh.
    // Quem injeta é só o teste, com um dublê.
    getIceServers = defaultGetIceServers,
  }) {
    this.signaling = signaling;
    // Semente, não fonte da verdade: é a lista que o `Room.jsx` buscou no setup
    // da sala e que, numa aba aberta há horas, já está velha. Serve como último
    // valor conhecido se uma renovação falhar (ver `_currentIceServers`).
    this.iceServers = iceServers;
    this.getIceServers = getIceServers;
    this.getSelfId = getSelfId;
    this.getRoomKey = getRoomKey;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteScreen = onRemoteScreen;
    this.onRemotePeerState = onRemotePeerState;
    this.onChatMessage = onChatMessage;
    this.onRemoteStreamClosed = onRemoteStreamClosed;
    this.onPeerStateChange = onPeerStateChange;
    this.onRemoteMusic = onRemoteMusic;
    this.onMusicMessage = onMusicMessage;
    this.getMusicSnapshot = getMusicSnapshot;

    this.peers = new Map(); // peerId -> peer record (ver _createPeerRecord)
    // Pares em construção. Existe porque `addPeer` passou a esperar rede antes
    // de registrar o par — ver a nota grande em `addPeer`.
    this.pendingPeers = new Map(); // peerId -> Promise
    this.abandonedPeers = new Set(); // removePeer chamado durante a construção
    this.closed = false;

    // Tracks locais correntes. São a fonte da verdade para qualquer peer que
    // entre depois — um peer novo já nasce com o estado atual aplicado.
    this.localAudioTrack = localStream?.getAudioTracks()[0] || null;
    this.localCameraTrack = localStream?.getVideoTracks()[0] || null;
    this.localScreenTrack = null;
    this.localMusicTrack = null;

    // Estado anunciado aos peers pelo data channel (nunca pelo servidor).
    this.localState = {
      displayName: '',
      cameraOff: !this.localCameraTrack,
      micOff: false,
      screenOn: false,
    };
  }

  setLocalState(patch) {
    this.localState = { ...this.localState, ...patch };
    this.broadcast({ type: 'state', ...this.localState });
  }

  _selfId() {
    return this.getSelfId?.() || this.signaling?.socket?.id || '';
  }

  /**
   * Polite/impolite por comparação lexicográfica dos ids. Os ids são únicos e
   * a comparação é total, então exatamente um lado é polite — sem sorteio, sem
   * round-trip extra e estável entre reconexões.
   */
  _isPolite(peerId) {
    const selfId = this._selfId();
    if (!selfId) return true; // sem id ainda: assumir polite (cede em caso de dúvida)
    return selfId < peerId;
  }

  /**
   * Lista de ICE servers para uma conexão que está prestes a nascer.
   *
   * Renovar aqui, e não uma vez por sessão, é o coração desta correção: a
   * credencial que o `Room.jsx` buscou no setup da sala pode ter vencido faz
   * horas, e sob `relay` uma credencial vencida não degrada a conexão — impede
   * que ela exista.
   *
   * Se a renovação falhar, cai para o último valor conhecido (a semente do
   * construtor ou a última lista boa). É melhor tentar com credencial talvez
   * velha do que não tentar: velha pode ainda estar válida, vazia nunca está.
   */
  async _currentIceServers({ force = false } = {}) {
    let servers = [];
    try {
      servers = (await this.getIceServers?.({ force })) || [];
    } catch (err) {
      // O provedor da aplicação nunca rejeita; um dublê de teste pode.
      console.error('[mesh] falha ao obter ICE servers:', err);
    }

    if (hasTurnServer(servers)) {
      this.iceServers = servers;
      return servers;
    }
    if (hasTurnServer(this.iceServers)) return this.iceServers;
    return servers;
  }

  /**
   * Grita quando não há TURN, em vez de esperar o ICE desistir sozinho.
   *
   * Sob `iceTransportPolicy: 'relay'` sem nenhum servidor TURN o desfecho é
   * **determinístico**: zero candidatos, zero conexões. Esperar o timeout do ICE
   * custa dezenas de segundos de tile mudo antes de o produto admitir o óbvio.
   *
   * `'failed'` é valor legítimo de `RTCPeerConnectionState`, então a assinatura
   * `(peerId, connectionState)` continua exatamente a de hoje — quem consome o
   * callback não precisa saber que esta verificação existe.
   */
  _reportMissingTurn(peerId, iceServers) {
    if (hasTurnServer(iceServers)) return false;
    console.error(
      `[mesh] sem servidor TURN utilizável (provedor: ${getIceServersStatus()}) — ` +
        `com iceTransportPolicy:'relay' a conexão com ${peerId} não tem como fechar.`,
    );
    this.onPeerStateChange?.(peerId, 'failed');
    return true;
  }

  /**
   * Cria a conexão com um par, renovando a credencial antes.
   *
   * **A reentrância aqui é armadilha real, não teórica.** Antes desta entrega o
   * caminho entre a guarda `this.peers.has(peerId)` e o `this.peers.set(...)`
   * era inteiramente síncrono, então a guarda bastava. O `await` da renovação
   * abre uma janela no meio — e ela é atingida no cenário mais comum que existe:
   * o `Room.jsx` chama `addPeer` ao receber `peer-joined` enquanto o primeiro
   * sinal daquele mesmo par já está chegando, e `handleSignal` chama `addPeer`
   * também. Sem a reserva, seriam duas `RTCPeerConnection` para o mesmo par: a
   * segunda sobrescreve o mapa e a primeira fica órfã, viva, com transceivers e
   * tracks, sem nenhuma referência que permita fechá-la. O sintoma disso é
   * *exatamente* o que esta task investiga — mídia que não chega,
   * intermitentemente, num par específico.
   *
   * Daí o mapa de em-voo: chamadas concorrentes recebem **a mesma promise**.
   */
  async addPeer(peerId, { initiator } = {}) {
    void initiator; // perfect negotiation dispensa papel de iniciador
    if (this.closed || this.peers.has(peerId)) return;

    const emVoo = this.pendingPeers.get(peerId);
    if (emVoo) return emVoo;

    const promise = this._createPeer(peerId);
    this.pendingPeers.set(peerId, promise);
    try {
      return await promise;
    } finally {
      this.pendingPeers.delete(peerId);
      this.abandonedPeers.delete(peerId);
    }
  }

  async _createPeer(peerId) {
    const iceServers = await this._currentIceServers();

    // Depois do await, o mundo pode ter mudado: a sala fechou, o par saiu (e o
    // `removePeer` não achou nada para remover, porque ainda não havia), ou
    // outro caminho já registrou este par. Registrar assim mesmo criaria um par
    // fantasma — conexão viva para quem não está mais na sala.
    if (this.closed || this.peers.has(peerId) || this.abandonedPeers.has(peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'relay',
    });

    const rec = {
      pc,
      peerId,
      polite: this._isPolite(peerId),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswerPending: false,
      negotiationQueued: false,
      // Recuperação: um flag e um timer, compartilhados pelos quatro gatilhos
      // (connectionState/iceConnectionState × failed/disconnected). É o que
      // impede que quatro gatilhos virem quatro recuperações concorrentes.
      recovering: false,
      recoveryTimer: null,
      recoveryDelay: Infinity,
      recoveryAttempts: 0,
      recoveryExhausted: false,
      politeValveTimer: null,
      verifyTimer: null,
      verifyAttempts: 0,
      candidateQueue: [],
      // Serializa o tratamento de sinais: setRemoteDescription/setLocalDescription
      // não podem interleavar, ou o signalingState visto pelo perfect negotiation
      // deixa de refletir a realidade.
      tasks: Promise.resolve(),
      stream: new MediaStream(),       // mic + câmera do peer
      screenStream: new MediaStream(), // compartilhamento de tela do peer
      musicStream: new MediaStream(),  // música que o peer está transmitindo
      hasMusicTrack: false,
      hasScreenTrack: false,
      remoteScreenOn: false,
      channel: null,
    };
    this.peers.set(peerId, rec);

    // Reportado **depois** do registro, para que o par exista quando a UI
    // reagir; e sem abortar a construção, porque se a credencial voltar a
    // recuperação (`_scheduleRecovery`) resgata esta mesma conexão sem precisar
    // reconstruir nada.
    this._reportMissingTurn(peerId, iceServers);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signaling.sendSignal(peerId, { type: 'ice-candidate', candidate });
      }
    };

    pc.onnegotiationneeded = () => this._queueNegotiation(rec);

    pc.ontrack = (event) => this._handleTrack(rec, event);

    pc.onconnectionstatechange = () => {
      this.onPeerStateChange?.(peerId, pc.connectionState);
      this._onConnectivityChange(rec);
    };

    pc.oniceconnectionstatechange = () => this._onConnectivityChange(rec);

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable') this._scheduleVerifyNegotiation(rec);
    };

    // Canal de dados negociado fora de banda — mesmo id nos dois lados.
    rec.channel = pc.createDataChannel(CHAT_CHANNEL_LABEL, {
      negotiated: true,
      id: CHAT_CHANNEL_ID,
      ordered: true,
    });
    rec.channel.onopen = () => {
      // Ao abrir, cada lado anuncia seu estado atual para o outro não começar
      // com uma grade desatualizada (ex.: alguém já compartilhando tela).
      this._send(rec, { type: 'state', ...this.localState });
      // …e o estado musical inteiro, que é o que faz quem entra no meio de uma
      // faixa ver a mesma fila e entrar na música em andamento, não do começo.
      const snapshot = this.getMusicSnapshot?.();
      if (snapshot) this._send(rec, snapshotMessage(snapshot));
    };
    rec.channel.onmessage = (event) => this._handleChannelMessage(rec, event.data);
    rec.channel.onerror = (event) => {
      // 'close' durante o teardown vira erro em alguns navegadores — ruído.
      if (!this.closed) console.warn('[mesh] data channel error:', event?.error || event);
    };

    // Ordem fixa — é o contrato que permite ao outro lado classificar as
    // m-lines que chegam (ver _classifyTransceiver).
    rec.audioT = pc.addTransceiver('audio', { direction: 'sendonly' });
    rec.camT = pc.addTransceiver('video', { direction: 'sendonly' });
    rec.screenT = pc.addTransceiver('video', { direction: 'sendonly' });
    // Música **depois** da tela: a ordem de criação é a ordem das m-lines, e a
    // ordem das m-lines é o que o outro lado usa para classificar. Inserir este
    // aqui no meio (por ser áudio, "perto do mic") embaralharia câmera com tela.
    rec.musicT = pc.addTransceiver('audio', { direction: 'sendonly' });

    await Promise.all([
      this._safeReplace(rec.audioT.sender, this.localAudioTrack),
      this._safeReplace(rec.camT.sender, this.localCameraTrack),
      this._safeReplace(rec.screenT.sender, this.localScreenTrack),
      this._safeReplace(rec.musicT.sender, this.localMusicTrack),
    ]);
    if (this.localMusicTrack) this._applyMusicEncoding(rec);
  }

  // ------------------------------------------------------------- recuperação

  /**
   * O único ponto de entrada da recuperação, alimentado pelos quatro gatilhos.
   *
   * Antes desta entrega existia meia recuperação: `restartIce()` no primeiro
   * `iceConnectionState === 'failed'`, só do lado impolite, sem segunda
   * tentativa, sem log e sem UI. `connectionState` — que agrega o DTLS e é o
   * estado que a interface mostra — era ignorado para fins de recuperação, e
   * `disconnected` não era olhado por ninguém.
   *
   * E o que existia não conseguia consertar o modo de falha mais provável:
   * `restartIce()` **reusa a configuração congelada no construtor da
   * `RTCPeerConnection`**. Contra credencial vencida ele gera uma geração nova de
   * ICE com exatamente a mesma credencial morta e falha de novo, idêntico. Por
   * isso recuperar aqui é, obrigatoriamente e nesta ordem: **renovar →
   * `setConfiguration` → `restartIce`**.
   */
  _onConnectivityChange(rec) {
    const { pc } = rec;

    if (pc.connectionState === 'connected') {
      this._onPeerRecovered(rec);
      return;
    }

    if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
      this._scheduleRecovery(rec, `failed (${pc.connectionState}/${pc.iceConnectionState})`, 0);
      return;
    }

    if (pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected') {
      this._scheduleRecovery(rec, 'disconnected', DISCONNECTED_GRACE_MS);
    }
  }

  /**
   * Agenda uma recuperação, desduplicando os gatilhos e respeitando o backoff.
   *
   * O `Math.max` com o backoff é o que impede a tempestade: depois da primeira
   * tentativa, o `failed` que o próprio `restartIce()` produz ao não dar certo
   * volta por aqui pedindo recuperação **imediata** — e sem esse piso ele
   * furaria o backoff e viraria um laço apertado de restarts.
   */
  _scheduleRecovery(rec, reason, requestedDelayMs) {
    if (this.closed || !this.peers.has(rec.peerId) || rec.pc.signalingState === 'closed') return;
    if (rec.recovering) return;

    const backoff =
      rec.recoveryAttempts > 0
        ? RECOVERY_BACKOFF_MS[Math.min(rec.recoveryAttempts - 1, RECOVERY_BACKOFF_MS.length - 1)]
        : 0;
    const delay = Math.max(requestedDelayMs, backoff);

    // Já há algo agendado para igual ou mais cedo: o gatilho novo não acrescenta
    // nada. É assim que `disconnected` seguido de `failed` continua sendo UMA
    // recuperação — e é assim que um `failed` promove uma carência pendente.
    if (rec.recoveryTimer) {
      if (delay >= rec.recoveryDelay) return;
      clearTimeout(rec.recoveryTimer);
    }

    rec.recoveryDelay = delay;
    rec.recoveryTimer = setTimeout(() => {
      rec.recoveryTimer = null;
      rec.recoveryDelay = Infinity;
      // Pela fila do par: recuperação e negociação nunca correm em paralelo.
      this._enqueue(rec, () => this._recoverPeer(rec, reason));
    }, delay);
  }

  async _recoverPeer(rec, reason) {
    const { pc } = rec;
    // Tudo o que segue um `setTimeout` reconfere o mundo: o par pode ter saído
    // da sala, e ressuscitar uma conexão para quem já foi embora é o modo mais
    // fácil de criar um par fantasma.
    if (this.closed || !this.peers.has(rec.peerId) || pc.signalingState === 'closed') return;
    if (pc.connectionState === 'connected') return; // voltou sozinho no meio do caminho

    if (rec.recoveryAttempts >= RECOVERY_BACKOFF_MS.length) {
      if (!rec.recoveryExhausted) {
        rec.recoveryExhausted = true;
        console.error(
          `[mesh] recuperação esgotada para ${rec.peerId} após ${rec.recoveryAttempts} tentativas ` +
            `(${reason}). O par permanece reportado como 'failed'.`,
        );
        this.onPeerStateChange?.(rec.peerId, 'failed');
      }
      return;
    }

    rec.recovering = true;
    rec.recoveryAttempts += 1;
    try {
      const iceServers = await this._currentIceServers({ force: true });
      if (this.closed || !this.peers.has(rec.peerId) || pc.signalingState === 'closed') return;

      if (this._reportMissingTurn(rec.peerId, iceServers)) {
        // Reiniciar o ICE sem credencial é o no-op caro descrito acima: mesma
        // configuração, mesma falha. Espera-se a credencial voltar.
        return;
      }

      try {
        // Configuração **completa**, com os mesmos campos do construtor: a spec
        // proíbe alterar alguns campos depois de a conexão existir, e omiti-los
        // pode ser lido como tentativa de reset conforme a implementação.
        pc.setConfiguration({ iceServers, iceTransportPolicy: 'relay' });
      } catch (err) {
        // Melhor um restart com credencial velha do que nenhuma tentativa — e a
        // exceção não pode subir para o `_enqueue`, que a transformaria num
        // console.error e mataria o agendamento do backoff junto.
        console.warn('[mesh] setConfiguration falhou; seguindo para o restartIce:', err);
      }

      if (rec.polite) {
        this._armPoliteValve(rec);
      } else {
        // Não criamos offer aqui: `restartIce()` faz o navegador disparar
        // `negotiationneeded`, e é de lá que a offer sai. Criar uma agora seriam
        // duas offers para o mesmo restart.
        pc.restartIce();
      }
    } finally {
      rec.recovering = false;
      // Reavaliação com backoff: se o restart funcionou, `connected` cancela
      // isto antes de disparar.
      this._scheduleRecovery(rec, 'reavaliação', 0);
    }
  }

  /**
   * Válvula do lado polite: se o impolite não voltou, o polite reinicia também.
   */
  _armPoliteValve(rec) {
    if (rec.politeValveTimer) return;
    rec.politeValveTimer = setTimeout(() => {
      rec.politeValveTimer = null;
      if (this.closed || !this.peers.has(rec.peerId)) return;
      if (rec.pc.signalingState === 'closed') return;
      if (rec.pc.connectionState === 'connected') return;
      console.warn(`[mesh] o lado impolite não voltou para ${rec.peerId}; reiniciando o ICE daqui.`);
      rec.pc.restartIce();
    }, POLITE_RESTART_VALVE_MS);
  }

  /** Voltou a `connected`: zera o orçamento de tentativas e desarma tudo. */
  _onPeerRecovered(rec) {
    this._clearPeerTimers(rec);
    rec.recoveryAttempts = 0;
    rec.recoveryExhausted = false;
  }

  _clearPeerTimers(rec) {
    clearTimeout(rec.recoveryTimer);
    clearTimeout(rec.politeValveTimer);
    clearTimeout(rec.verifyTimer);
    rec.recoveryTimer = null;
    rec.politeValveTimer = null;
    rec.verifyTimer = null;
    rec.recoveryDelay = Infinity;
  }

  // ------------------------------------------- verificação da segunda rodada

  /**
   * Confere que a negociação terminou o serviço, em vez de assumir que sim.
   *
   * O contexto: quando alguém entra, os dois lados chamam `addPeer` quase
   * juntos, os dois criam quatro transceivers `sendonly` e os dois disparam
   * `negotiationneeded` — **glare em toda entrada, sempre**. O perfect
   * negotiation resolve a colisão, mas uma answer só espelha as m-lines da
   * offer, e transceivers de `addTransceiver()` nunca são pareados
   * implicitamente com m-lines remotas (só os de `addTrack()`). Quem perde o
   * glare fica, depois da primeira rodada, com os quatro `sendonly` sem `mid` —
   * e só passa a transmitir depois de uma segunda offer/answer.
   *
   * A boa notícia é que **a spec faz essa segunda rodada disparar sozinha**: o
   * algoritmo de negotiation-needed do JSEP retorna verdadeiro exatamente quando
   * há transceiver não associado, então o navegador dispara o evento de novo
   * assim que o lado perdedor volta a `stable`. Não é sorte, é comportamento
   * especificado — e a checagem A2 do E2E, que exige quatro canais por sentido
   * com três participantes, passa consistentemente, o que seria impossível se
   * metade das entradas ficasse pela metade.
   *
   * Daí esta função ser **rede de segurança e não correção**: ela só age com
   * evidência (`mid === null`, o mesmo critério que a spec usa), e como o
   * vencedor do glare nunca tem transceiver sem `mid`, ela é auto-limitante por
   * construção — só o perdedor pode renegociar, que é o comportamento correto.
   */
  _scheduleVerifyNegotiation(rec) {
    if (this.closed || !this.peers.has(rec.peerId)) return;
    if (rec.verifyTimer) return;
    if (rec.verifyAttempts >= VERIFY_DELAYS_MS.length) return;

    rec.verifyTimer = setTimeout(() => {
      rec.verifyTimer = null;
      this._verifyNegotiation(rec);
    }, VERIFY_DELAYS_MS[rec.verifyAttempts]);
  }

  _verifyNegotiation(rec) {
    if (this.closed || !this.peers.has(rec.peerId)) return;

    const { pc } = rec;
    if (pc.signalingState !== 'stable') return; // há negociação em curso: nada a concluir ainda

    const nossos = [rec.audioT, rec.camT, rec.screenT, rec.musicT].filter(Boolean);
    const orfaos = nossos.filter((t) => t.mid === null || t.mid === undefined);
    // Sem evidência não há ação: disparar aqui dobraria a negociação em toda
    // entrada, inclusive quando a segunda rodada automática já resolveu.
    if (orfaos.length === 0) return;

    rec.verifyAttempts += 1;
    console.warn(
      `[mesh] ${orfaos.length} transceiver(s) local(is) sem mid para ${rec.peerId} ` +
        `depois da negociação (tentativa ${rec.verifyAttempts}/${VERIFY_DELAYS_MS.length}); ` +
        'disparando nova rodada.',
    );
    if (rec.verifyAttempts >= VERIFY_DELAYS_MS.length) {
      console.error(
        `[mesh] metade da mídia de ${rec.peerId} pode não estar sendo transmitida: ` +
          'a segunda rodada de negociação não associou os transceivers locais.',
      );
    }
    // Pela mesma porta de sempre: se a recuperação já enfileirou uma offer neste
    // instante — e as duas condições acontecem juntas, por construção — as duas
    // colapsam numa só.
    this._queueNegotiation(rec);
  }

  /**
   * **O único lugar do arquivo que cria uma offer.**
   *
   * Ter uma porta só importa porque há mais de um motivo para renegociar (o
   * evento do navegador e a verificação de `_verifyNegotiation`), eles são
   * vizinhos no tempo, e duas offers concorrentes para o mesmo par produzem
   * glare artificial — no pior caso um laço em que cada rodada gera a próxima.
   *
   * As duas guardas de saída não são defensivas por hábito: fora de `stable`
   * existe uma negociação em andamento, e `setLocalDescription` ali é erro
   * garantido (o `_enqueue` engoliria num `console.error` e a fila seguiria como
   * se nada fosse).
   */
  async _negotiate(rec) {
    const { pc } = rec;
    if (this.closed || pc.signalingState === 'closed') return;
    if (pc.signalingState !== 'stable') return;

    try {
      rec.makingOffer = true;
      await pc.setLocalDescription();
      this.signaling.sendSignal(rec.peerId, { type: 'description', sdp: pc.localDescription });
    } catch (err) {
      console.error('[mesh] negotiationneeded failed:', err);
    } finally {
      rec.makingOffer = false;
    }
  }

  /**
   * Enfileira uma rodada de negociação, coalescendo pedidos redundantes.
   *
   * Um SDP é um retrato completo do estado, não um delta: dois motivos para
   * renegociar chegando juntos são atendidos por **uma** offer. A flag existe
   * para que "a conexão recuperou" e "faltou associar um transceiver" — que
   * acontecem no mesmo instante, por construção — não virem duas.
   */
  _queueNegotiation(rec) {
    if (rec.negotiationQueued) return;
    rec.negotiationQueued = true;
    return this._enqueue(rec, async () => {
      rec.negotiationQueued = false;
      await this._negotiate(rec);
    });
  }

  _enqueue(rec, fn) {
    rec.tasks = rec.tasks.then(fn).catch((err) => {
      console.error('[mesh] task failed:', err);
    });
    return rec.tasks;
  }

  async _safeReplace(sender, track) {
    try {
      await sender.replaceTrack(track || null);
    } catch (err) {
      console.warn('[mesh] replaceTrack failed:', err);
    }
  }

  /**
   * Diz qual das quatro finalidades (mic / câmera / tela / música) um
   * transceiver carrega.
   *
   * Os nossos são reconhecidos por identidade. Os do outro lado foram criados
   * pelo navegador ao aplicar a oferta remota, e o spec garante que eles são
   * anexados na ordem das m-lines — que é a ordem em que o peer os criou:
   * áudio, câmera, tela, música.
   *
   * Este array e a ordem de `addTransceiver` acima são **o mesmo contrato**
   * escrito duas vezes: esquecer de estender um dos dois faz a música cair no
   * `rec.stream` de voz, onde ela acende o anel de "falando" no tile de quem
   * toca e deixa de ter volume próprio — e tudo isso *parece* funcionar.
   */
  _classifyTransceiver(rec, transceiver) {
    if (transceiver === rec.audioT) return 'audio';
    if (transceiver === rec.camT) return 'camera';
    if (transceiver === rec.screenT) return 'screen';
    if (transceiver === rec.musicT) return 'music';

    const ours = new Set([rec.audioT, rec.camT, rec.screenT, rec.musicT]);
    const theirs = rec.pc.getTransceivers().filter((t) => !ours.has(t));
    const kind = ['audio', 'camera', 'screen', 'music'][theirs.indexOf(transceiver)];
    if (kind) return kind;

    // Layout inesperado (navegador que pareia bidirecionalmente, por exemplo):
    // cair no tipo da track ainda entrega áudio e vídeo, só sem a tela separada.
    return transceiver.receiver.track?.kind === 'audio' ? 'audio' : 'camera';
  }

  _handleTrack(rec, event) {
    const { track, transceiver } = event;
    const kind = this._classifyTransceiver(rec, transceiver);
    const target =
      kind === 'screen' ? rec.screenStream : kind === 'music' ? rec.musicStream : rec.stream;

    if (!target.getTracks().includes(track)) target.addTrack(track);

    track.addEventListener('ended', () => {
      target.removeTrack(track);
    });

    if (kind === 'screen') {
      // A track de tela chega já na negociação inicial (transceiver fixo), mas
      // vazia. Só vira tile quando o peer anuncia `screenOn` pelo data channel.
      rec.hasScreenTrack = true;
      if (rec.remoteScreenOn) this.onRemoteScreen?.(rec.peerId, rec.screenStream);
    } else if (kind === 'music') {
      // Idem: a track de música existe desde a negociação e fica silenciosa até
      // o peer virar dono de uma faixa em modo `stream`. O `<audio>` oculto é
      // anexado assim mesmo — se ele só aparecesse quando a música começa, a
      // política de autoplay pegaria o elemento no pior momento possível.
      rec.hasMusicTrack = true;
      this.onRemoteMusic?.(rec.peerId, rec.musicStream);
    } else {
      this.onRemoteStream?.(rec.peerId, rec.stream);
    }
  }

  // ---------------------------------------------------------------- sinalização

  async handleSignal(peerId, data) {
    if (this.closed) return;
    if (!this.peers.has(peerId)) {
      await this.addPeer(peerId);
    }
    const rec = this.peers.get(peerId);
    if (!rec) return;
    return this._enqueue(rec, () => this._applySignal(rec, data));
  }

  async _applySignal(rec, data) {
    const { pc } = rec;
    if (pc.signalingState === 'closed') return;

    // Offer e answer chegam ambos como `{ type:'description', sdp }`; o tipo
    // real está dentro do próprio SDP, que é o que o perfect negotiation lê.
    const description = data.sdp || null;

    if (description) {
      const readyForOffer =
        !rec.makingOffer && (pc.signalingState === 'stable' || rec.settingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;

      rec.ignoreOffer = !rec.polite && offerCollision;
      if (rec.ignoreOffer) return; // impolite ignora: o outro lado vai ceder

      try {
        rec.settingRemoteAnswerPending = description.type === 'answer';
        // O polite em colisão faz rollback implícito aqui (setRemoteDescription
        // com um offer em have-local-offer), conforme o padrão do WebRTC.
        await pc.setRemoteDescription(description);
      } finally {
        rec.settingRemoteAnswerPending = false;
      }

      await this._flushCandidateQueue(rec);

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.signaling.sendSignal(rec.peerId, { type: 'description', sdp: pc.localDescription });
      }
      return;
    }

    if (data.type === 'ice-candidate' && data.candidate) {
      if (!pc.remoteDescription) {
        rec.candidateQueue.push(data.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        // Candidato de um offer que ignoramos (glare) é esperado ser inválido.
        if (!rec.ignoreOffer) console.warn('[mesh] addIceCandidate failed:', err);
      }
    }
  }

  async _flushCandidateQueue(rec) {
    const queued = rec.candidateQueue;
    rec.candidateQueue = [];
    for (const candidate of queued) {
      try {
        await rec.pc.addIceCandidate(candidate);
      } catch {
        // candidato stale — ignorar
      }
    }
  }

  // ------------------------------------------------------------------ mídia

  /**
   * Aplica um novo track de câmera (ou `null` para "câmera desligada") a todos
   * os senders de vídeo de câmera do mesh. `replaceTrack` num transceiver já
   * negociado não dispara `negotiationneeded`: não há SDP novo, e o áudio nem
   * é tocado.
   */
  async setCameraTrack(track) {
    this.localCameraTrack = track || null;
    await Promise.all(
      [...this.peers.values()].map((rec) => this._safeReplace(rec.camT.sender, this.localCameraTrack)),
    );
  }

  async setScreenTrack(track) {
    this.localScreenTrack = track || null;
    if (this.localScreenTrack) {
      // Tela é conteúdo de detalhe: prioriza nitidez sobre framerate quando a
      // banda aperta, em vez de borrar texto.
      try {
        this.localScreenTrack.contentHint = 'detail';
      } catch {
        // contentHint é opcional — ignorar se o navegador não expõe
      }
    }
    await Promise.all(
      [...this.peers.values()].map((rec) => this._safeReplace(rec.screenT.sender, this.localScreenTrack)),
    );
  }

  async setAudioTrack(track) {
    this.localAudioTrack = track || null;
    await Promise.all(
      [...this.peers.values()].map((rec) => this._safeReplace(rec.audioT.sender, this.localAudioTrack)),
    );
  }

  /**
   * Assume (ou larga) a transmissão da faixa corrente. `null` devolve o canal ao
   * silêncio sem derrubar nada — o transceiver continua lá, negociado.
   *
   * Não confundir com o track do microfone: `toggleMute` mexe em
   * `localAudioTrack`, e é justamente por serem canais diferentes que silenciar
   * o mic durante a música não silencia a música para a sala.
   */
  async setMusicTrack(track) {
    this.localMusicTrack = track || null;
    if (this.localMusicTrack) {
      try {
        // Desliga as heurísticas de fala do encoder: a Opus para voz derruba
        // agudos que, em música, são a diferença entre "toca" e "toca bem".
        this.localMusicTrack.contentHint = 'music';
      } catch {
        // contentHint é opcional — ignorar se o navegador não expõe
      }
    }
    await Promise.all(
      [...this.peers.values()].map(async (rec) => {
        await this._safeReplace(rec.musicT.sender, this.localMusicTrack);
        if (this.localMusicTrack) this._applyMusicEncoding(rec);
      }),
    );
  }

  /**
   * Teto de banda do canal de música, aplicado por conexão. Sem ele, quem toca
   * numa sala cheia sobe N−1 fluxos de Opus sem limite pelo TURN, disputando
   * banda com o vídeo exatamente quando há mais gente para degradar.
   */
  _applyMusicEncoding(rec) {
    const sender = rec.musicT?.sender;
    if (!sender?.getParameters) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = MUSIC_MAX_BITRATE;
      sender.setParameters(params).catch(() => {
        // navegador que não aceita o parâmetro: tocar sem teto é melhor que não tocar
      });
    } catch {
      // idem
    }
  }

  // ------------------------------------------------------------- data channel

  _send(rec, payload) {
    if (rec.channel?.readyState !== 'open') return false;
    try {
      rec.channel.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn('[mesh] data channel send failed:', err);
      return false;
    }
  }

  /** Envia para todos os peers com canal aberto. Retorna quantos receberam. */
  broadcast(payload) {
    let delivered = 0;
    for (const rec of this.peers.values()) {
      if (this._send(rec, payload)) delivered += 1;
    }
    return delivered;
  }

  sendChatMessage(message) {
    return this.broadcast({ type: 'chat', message });
  }

  /** Qualquer mensagem `music-*` (ver `lib/musicProtocol.js`). */
  sendMusicMessage(payload) {
    return this.broadcast(payload);
  }

  _handleChannelMessage(rec, raw) {
    const payload = parseChannelPayload(raw);
    if (!payload) return;

    if (payload.type === 'chat') {
      this.onChatMessage?.(rec.peerId, payload.message);
      return;
    }

    // Autoria é a conexão, não o payload: `rec.peerId` é o único id confiável
    // aqui (ver a regra de identidade em `lib/musicProtocol.js`).
    if (isMusicMessage(payload)) {
      this.onMusicMessage?.(rec.peerId, payload);
      return;
    }

    if (payload.type === 'state') {
      const screenOn = !!payload.screenOn;
      rec.remoteScreenOn = screenOn;
      this.onRemotePeerState?.(rec.peerId, {
        cameraOff: !!payload.cameraOff,
        micOff: !!payload.micOff,
        screenOn,
        displayName: payload.displayName,
      });
      // A track de tela existe desde a negociação inicial (transceiver fixo);
      // é o estado anunciado que diz se há imagem nela.
      this.onRemoteScreen?.(rec.peerId, screenOn && rec.hasScreenTrack ? rec.screenStream : null);
    }
  }

  // ---------------------------------------------------------------- teardown

  removePeer(peerId) {
    // "Saiu antes de terminar de entrar": a construção do par espera a
    // renovação da credencial, e quem sai nessa janela não está no mapa ainda —
    // um `removePeer` mudo aqui deixaria a construção registrar, depois, uma
    // conexão para alguém que já não está na sala.
    if (this.pendingPeers.has(peerId)) this.abandonedPeers.add(peerId);

    const rec = this.peers.get(peerId);
    if (!rec) return;

    // Antes de qualquer outra coisa: um timer sobrevivente dispara depois numa
    // PC fechada, e o de backoff vive até 30s — tempo de sobra para alguém sair
    // da sala e ser ressuscitado por um `setTimeout`.
    this._clearPeerTimers(rec);

    try {
      rec.channel?.close();
    } catch {
      // já fechado
    }
    rec.pc.onicecandidate = null;
    rec.pc.onnegotiationneeded = null;
    rec.pc.ontrack = null;
    rec.pc.onconnectionstatechange = null;
    rec.pc.oniceconnectionstatechange = null;
    rec.pc.onsignalingstatechange = null;
    // Tracks recebidas são de propriedade do receiver; pará-las evita que o
    // decoder continue vivo se algum <video> ainda referenciar o stream.
    for (const stream of [rec.stream, rec.screenStream, rec.musicStream]) {
      for (const track of stream.getTracks()) {
        track.stop();
        stream.removeTrack(track);
      }
    }
    rec.pc.close();

    this.peers.delete(peerId);
    this.onRemoteStreamClosed?.(peerId);
  }

  closeAll() {
    this.closed = true;
    for (const peerId of [...this.peers.keys()]) {
      this.removePeer(peerId);
    }
  }
}
