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

    pc.onnegotiationneeded = () => {
      this._enqueue(rec, async () => {
        try {
          rec.makingOffer = true;
          await pc.setLocalDescription();
          this.signaling.sendSignal(peerId, { type: 'description', sdp: pc.localDescription });
        } catch (err) {
          console.error('[mesh] negotiationneeded failed:', err);
        } finally {
          rec.makingOffer = false;
        }
      });
    };

    pc.ontrack = (event) => this._handleTrack(rec, event);

    pc.onconnectionstatechange = () => {
      this.onPeerStateChange?.(peerId, pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      // Recuperação barata de queda de rede: o impolite reinicia o ICE e o
      // perfect negotiation cuida do resto.
      if (pc.iceConnectionState === 'failed' && !rec.polite) {
        pc.restartIce();
      }
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
