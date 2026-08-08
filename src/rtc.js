/**
 * Malha (mesh) de RTCPeerConnection.
 *
 * Decisao estrutural que simplifica tudo o que vem depois:
 * cada conexao nasce com TRES transceivers fixos, sempre nesta ordem —
 *
 *   slot 0: audio    slot 1: video da camera    slot 2: video da tela
 *
 * Consequencias:
 *  - Ligar/desligar camera ou tela e apenas `sender.replaceTrack(track|null)`.
 *    Nao ha renegociacao no meio da chamada, portanto nao ha glare.
 *  - O receptor identifica o que chegou pelo indice do transceiver, sem
 *    precisar de convencoes de id de stream.
 *
 * Quem estava na sala antes envia a oferta; quem chegou responde. Regra unica,
 * nao ha decisao a tomar em tempo de execucao.
 */

export const SLOT = { AUDIO: 0, CAMERA: 1, SCREEN: 2 };

const RTC_CONFIG = {
  // STUN publico cobre a maioria das NATs domesticas. Para redes corporativas
  // um TURN e obrigatorio — ver docs/ARQUITETURA-MIDIA.md.
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

export function createPeerHub({ signaling, getLocalTracks, onRemoteTrack, onConnectionState }) {
  /** @type {Map<string, {pc:RTCPeerConnection, pending:RTCIceCandidateInit[]}>} */
  const peers = new Map();

  function slots(pc) {
    const list = pc.getTransceivers();
    return { audio: list[SLOT.AUDIO], camera: list[SLOT.CAMERA], screen: list[SLOT.SCREEN] };
  }

  async function applyLocalTracks(pc) {
    const { micTrack, camTrack, screenTrack } = getLocalTracks();
    const s = slots(pc);
    if (!s.audio) return;
    await Promise.all([
      s.audio.sender.replaceTrack(micTrack ?? null),
      s.camera.sender.replaceTrack(camTrack ?? null),
      s.screen.sender.replaceTrack(screenTrack ?? null),
    ]);
  }

  function createConnection(peerId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry = { pc, pending: [] };
    peers.set(peerId, entry);

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        signaling.send({ t: 'signal', to: peerId, data: { candidate: event.candidate.toJSON() } });
      }
    });

    pc.addEventListener('track', (event) => {
      const index = pc.getTransceivers().indexOf(event.transceiver);
      onRemoteTrack(peerId, index, event.track);
    });

    pc.addEventListener('connectionstatechange', () => {
      onConnectionState?.(peerId, pc.connectionState);
    });

    return entry;
  }

  /** Chamado por quem ja estava na sala quando alguem entra. */
  async function offerTo(peerId) {
    const { pc } = createConnection(peerId);
    // A ordem destas tres chamadas DEFINE o contrato de slots. Nao reordenar.
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });

    // Tela: nitidez importa mais que taxa de quadros.
    const screenSender = slots(pc).screen.sender;
    const params = screenSender.getParameters();
    params.degradationPreference = 'maintain-resolution';
    await screenSender.setParameters(params).catch(() => {});

    await applyLocalTracks(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.send({ t: 'signal', to: peerId, data: { description: pc.localDescription } });
  }

  async function handleSignal(peerId, data) {
    let entry = peers.get(peerId);

    if (data.description) {
      if (data.description.type === 'offer') {
        if (!entry) entry = createConnection(peerId);
        await entry.pc.setRemoteDescription(data.description);

        // Transceivers criados a partir de uma oferta remota nascem
        // "recvonly". Sem promover para sendrecv agora, o `replaceTrack`
        // posterior nao envia nada e o outro lado ve tela preta.
        for (const transceiver of entry.pc.getTransceivers()) {
          transceiver.direction = 'sendrecv';
        }
        await applyLocalTracks(entry.pc);

        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        signaling.send({ t: 'signal', to: peerId, data: { description: entry.pc.localDescription } });
      } else if (entry) {
        await entry.pc.setRemoteDescription(data.description);
      }

      // Candidatos que chegaram antes da descricao remota.
      if (entry) {
        for (const candidate of entry.pending.splice(0)) {
          await entry.pc.addIceCandidate(candidate).catch(() => {});
        }
      }
      return;
    }

    if (data.candidate && entry) {
      if (entry.pc.remoteDescription) {
        await entry.pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        entry.pending.push(data.candidate);
      }
    }
  }

  /** Reaplica os tracks locais em todas as conexoes (cam on/off, tela on/off). */
  async function republish() {
    await Promise.all([...peers.values()].map(({ pc }) => applyLocalTracks(pc)));
  }

  function close(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    entry.pc.getSenders().forEach((sender) => sender.replaceTrack(null).catch(() => {}));
    entry.pc.close();
    peers.delete(peerId);
  }

  function closeAll() {
    for (const peerId of [...peers.keys()]) close(peerId);
  }

  return { offerTo, handleSignal, republish, close, closeAll, get size() { return peers.size; } };
}
