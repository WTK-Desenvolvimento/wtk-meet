/**
 * Full-mesh WebRTC: one RTCPeerConnection per remote peer, capped by the
 * room's MAX_PARTICIPANTS on the signaling side. Media never routes through
 * the signaling server — this class only uses it to relay SDP/ICE.
 *
 * iceTransportPolicy:'relay' garante que todo tráfego passe pelo Cloudflare TURN.
 */
export class WebRTCMesh {
  constructor({ signaling, iceServers, localStream, getRoomKey, onRemoteStream, onRemoteStreamClosed, onPeerStateChange }) {
    this.signaling = signaling;
    this.iceServers = iceServers;
    this.localStream = localStream;
    this.getRoomKey = getRoomKey;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteStreamClosed = onRemoteStreamClosed;
    this.onPeerStateChange = onPeerStateChange;
    this.peers = new Map();             // peerId -> RTCPeerConnection
    this.iceCandidateQueue = new Map(); // peerId -> RTCIceCandidate[] (buffered antes do remoteDescription)
  }

  async addPeer(peerId, { initiator }) {
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: 'relay',
    });
    this.peers.set(peerId, pc);
    this.iceCandidateQueue.set(peerId, []);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendSignal(peerId, { type: 'ice-candidate', candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      this.onRemoteStream?.(peerId, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      this.onPeerStateChange?.(peerId, pc.connectionState);
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.sendSignal(peerId, { type: 'offer', sdp: offer });
    }
  }

  async _flushCandidateQueue(peerId, pc) {
    const queued = this.iceCandidateQueue.get(peerId) || [];
    this.iceCandidateQueue.set(peerId, []);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // candidato stale — ignorar
      }
    }
  }

  async handleSignal(peerId, data) {
    let pc = this.peers.get(peerId);
    if (!pc) {
      await this.addPeer(peerId, { initiator: false });
      pc = this.peers.get(peerId);
    }

    if (data.type === 'offer') {
      await pc.setRemoteDescription(data.sdp);
      await this._flushCandidateQueue(peerId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.sendSignal(peerId, { type: 'answer', sdp: answer });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data.sdp);
      await this._flushCandidateQueue(peerId, pc);
    } else if (data.type === 'ice-candidate' && data.candidate) {
      if (pc.remoteDescription) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch {
          // benign
        }
      } else {
        const queue = this.iceCandidateQueue.get(peerId) || [];
        queue.push(data.candidate);
        this.iceCandidateQueue.set(peerId, queue);
      }
    }
  }

  removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (!pc) return;
    pc.close();
    this.peers.delete(peerId);
    this.iceCandidateQueue.delete(peerId);
    this.onRemoteStreamClosed?.(peerId);
  }

  closeAll() {
    for (const peerId of [...this.peers.keys()]) {
      this.removePeer(peerId);
    }
  }
}
