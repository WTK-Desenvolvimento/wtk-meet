import { CHAT_CHANNEL_ID, CHAT_CHANNEL_LABEL, parseChannelPayload } from './chat.js';

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
 *    cria exatamente três transceivers `sendonly`, sempre na mesma ordem: áudio
 *    (mic), vídeo (câmera), vídeo (tela). Ligar/desligar câmera e entrar/sair
 *    de compartilhamento de tela viram `replaceTrack()` num sender que já
 *    existe — sem renegociação de SDP.
 *
 *    O sentido inverso vem de três transceivers `recvonly` que o navegador cria
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
  }) {
    this.signaling = signaling;
    this.iceServers = iceServers;
    this.getSelfId = getSelfId;
    this.getRoomKey = getRoomKey;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteScreen = onRemoteScreen;
    this.onRemotePeerState = onRemotePeerState;
    this.onChatMessage = onChatMessage;
    this.onRemoteStreamClosed = onRemoteStreamClosed;
    this.onPeerStateChange = onPeerStateChange;

    this.peers = new Map(); // peerId -> peer record (ver _createPeerRecord)
    this.closed = false;

    // Tracks locais correntes. São a fonte da verdade para qualquer peer que
    // entre depois — um peer novo já nasce com o estado atual aplicado.
    this.localAudioTrack = localStream?.getAudioTracks()[0] || null;
    this.localCameraTrack = localStream?.getVideoTracks()[0] || null;
    this.localScreenTrack = null;

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

  async addPeer(peerId, { initiator } = {}) {
    void initiator; // perfect negotiation dispensa papel de iniciador
    if (this.closed || this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
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
      hasScreenTrack: false,
      remoteScreenOn: false,
      channel: null,
    };
    this.peers.set(peerId, rec);

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

    await Promise.all([
      this._safeReplace(rec.audioT.sender, this.localAudioTrack),
      this._safeReplace(rec.camT.sender, this.localCameraTrack),
      this._safeReplace(rec.screenT.sender, this.localScreenTrack),
    ]);
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
   * Diz qual das três finalidades (mic / câmera / tela) um transceiver carrega.
   *
   * Os nossos são reconhecidos por identidade. Os do outro lado foram criados
   * pelo navegador ao aplicar a oferta remota, e o spec garante que eles são
   * anexados na ordem das m-lines — que é a ordem em que o peer os criou:
   * áudio, câmera, tela.
   */
  _classifyTransceiver(rec, transceiver) {
    if (transceiver === rec.audioT) return 'audio';
    if (transceiver === rec.camT) return 'camera';
    if (transceiver === rec.screenT) return 'screen';

    const ours = new Set([rec.audioT, rec.camT, rec.screenT]);
    const theirs = rec.pc.getTransceivers().filter((t) => !ours.has(t));
    const kind = ['audio', 'camera', 'screen'][theirs.indexOf(transceiver)];
    if (kind) return kind;

    // Layout inesperado (navegador que pareia bidirecionalmente, por exemplo):
    // cair no tipo da track ainda entrega áudio e vídeo, só sem a tela separada.
    return transceiver.receiver.track?.kind === 'audio' ? 'audio' : 'camera';
  }

  _handleTrack(rec, event) {
    const { track, transceiver } = event;
    const isScreen = this._classifyTransceiver(rec, transceiver) === 'screen';
    const target = isScreen ? rec.screenStream : rec.stream;

    if (!target.getTracks().includes(track)) target.addTrack(track);

    track.addEventListener('ended', () => {
      target.removeTrack(track);
    });

    if (isScreen) {
      // A track de tela chega já na negociação inicial (transceiver fixo), mas
      // vazia. Só vira tile quando o peer anuncia `screenOn` pelo data channel.
      rec.hasScreenTrack = true;
      if (rec.remoteScreenOn) this.onRemoteScreen?.(rec.peerId, rec.screenStream);
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

  _handleChannelMessage(rec, raw) {
    const payload = parseChannelPayload(raw);
    if (!payload) return;

    if (payload.type === 'chat') {
      this.onChatMessage?.(rec.peerId, payload.message);
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
    for (const stream of [rec.stream, rec.screenStream]) {
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
