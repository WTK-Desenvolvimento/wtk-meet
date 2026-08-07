import { attachEncryption, attachDecryption } from './e2ee.js';

/**
 * Full-mesh WebRTC: one RTCPeerConnection per remote peer, capped by the
 * room's MAX_PARTICIPANTS on the signaling side. Media never routes through
 * the signaling server — this class only uses it to relay SDP/ICE.
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
    this.peers = new Map(); // peerId -> RTCPeerConnection
  }

  async addPeer(peerId, { initiator }) {
    if (this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      encodedInsertableStreams: true,
    });
    this.peers.set(peerId, pc);

    for (const track of this.localStream.getTracks()) {
      const sender = pc.addTrack(track, this.localStream);
      attachEncryption(sender, this.getRoomKey);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendSignal(peerId, { type: 'ice-candidate', candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      attachDecryption(event.receiver, this.getRoomKey);
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

  async handleSignal(peerId, data) {
    let pc = this.peers.get(peerId);
    if (!pc) {
      // Offer from a peer we haven't set up yet — they beat our peer-joined
      // handler, or were already in the room when we were admitted.
      await this.addPeer(peerId, { initiator: false });
      pc = this.peers.get(peerId);
    }

    if (data.type === 'offer') {
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.sendSignal(peerId, { type: 'answer', sdp: answer });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data.sdp);
    } else if (data.type === 'ice-candidate' && data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch {
        // Benign when it arrives after the connection has already closed.
      }
    }
  }

  removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (!pc) return;
    pc.close();
    this.peers.delete(peerId);
    this.onRemoteStreamClosed?.(peerId);
  }

  closeAll() {
    for (const peerId of [...this.peers.keys()]) {
      this.removePeer(peerId);
    }
  }
}
