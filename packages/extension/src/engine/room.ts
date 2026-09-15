/**
 * A sala, do ponto de vista do motor: sinalização, mesh e o track de música.
 *
 * O motor entra numa sala wtk-meet **como um participante qualquer** e sobe o
 * áudio pelo quarto transceiver que já existe. Quem está no app ouve sem
 * instalar nada: o `RemoteMusicAudio` toca o canal de música de qualquer peer,
 * independentemente de votação e de painel aberto (o comentário em
 * `pages/Room.tsx` diz por quê). Ou seja: **para a sala ouvir, zero mensagem de
 * protocolo é necessária.**
 *
 * Quatro decisões que este arquivo carrega:
 *
 * 1. **Sem `getRoomKey` e sem passphrase** (`ARCHITECTURE.md` §11.2). A camada
 *    extra de E2EE está desligada no `Room` do app, e com `getRoomKey` ausente
 *    os transforms de `e2ee.ts` fazem passthrough dos dois lados. O tráfego
 *    continua protegido por DTLS-SRTP, como o de qualquer participante hoje.
 *    **Armadilha registrada:** `makeDecryptTransform` *descarta* o quadro quando
 *    a decifragem falha — no dia em que o app religar a E2EE, o áudio da
 *    extensão some para todo mundo sem um erro sequer. O comentário-âncora em
 *    `pages/Room.tsx`, ao lado das linhas comentadas, aponta para cá.
 * 2. **Sem `localStream`.** O motor não chama `getUserMedia`: entra com os
 *    quatro senders, três deles vazios. Quem fala, fala no app ou no Meet.
 * 3. **`setMusicTrack` uma vez, e `null` só no desligamento.** No app o canal de
 *    música tem dois donos (player e soundboard mixam no mesmo destination) e
 *    por isso cada ramo que "desliga o canal" precisa perguntar antes se o
 *    soundboard está com ele. Aqui o motor é um broadcaster dedicado: manter o
 *    sender atado o tempo todo **apaga a classe inteira de bug** em vez de
 *    reimplementar a pergunta. Custo: um Opus transmitindo silêncio enquanto
 *    nada toca, com teto de 96 kbps e DTX.
 * 4. **Ouve só o canal de música dos outros.** `onRemoteStream` e
 *    `onRemoteScreen` ficam de fora: um documento invisível, sem entrada na
 *    barra de abas e sem controle de volume, reproduzindo a voz de uma sala é
 *    algo que o usuário não vê e não controla — e a conversa acontece no Meet,
 *    então trazer a mesma voz por um segundo caminho é eco garantido.
 */

import { configureIceServers, getIceServers } from '../../../client/src/lib/iceServers.js';
import { WebRTCMesh } from '../../../client/src/lib/webrtcMesh.js';
import { sanitizeMusicMessage } from '../../../client/src/lib/musicProtocol.js';
import type { MusicMessage } from '../../../client/src/lib/musicProtocol.js';

import { createSignalingClient } from '../lib/signaling.js';
import type { SignalingClient } from '../lib/signaling.js';
import type { EnginePeer, EnginePendingJoin, EngineStatus } from '../lib/protocol.js';
import type { RoomSide } from './core.js';

export interface RoomEvents {
  onStatus(status: EngineStatus, detail?: string | null): void;
  onPeers(peers: EnginePeer[]): void;
  onPendingJoins(pending: EnginePendingJoin[]): void;
  /** O canal de música de outro peer — o motor só toca isto, e nada mais. */
  onRemoteMusic(peerId: string, stream: MediaStream): void;
}

/** O motivo da recusa, traduzido. `room-full` precisa citar a vaga da extensão. */
const DENY_REASONS: Record<string, string> = {
  'room-full':
    'A sala está cheia (o limite é 6, e o motor da extensão ocupa uma das vagas).',
  denied: 'Alguém na sala recusou a entrada do motor.',
};

export class ExtensionRoom implements RoomSide {
  private signaling: SignalingClient | null = null;
  private mesh: WebRTCMesh | null = null;
  private peers = new Map<string, string>();
  private pending = new Map<string, string>();
  private selfId = '';
  private events: RoomEvents;
  private signalingUrl: string;
  /** O track de música, atado uma vez (decisão 3 do cabeçalho). */
  private getMusicTrack: () => MediaStreamTrack | null;

  constructor({
    events,
    signalingUrl,
    getMusicTrack,
  }: {
    events: RoomEvents;
    signalingUrl: string;
    getMusicTrack: () => MediaStreamTrack | null;
  }) {
    this.events = events;
    this.signalingUrl = signalingUrl;
    this.getMusicTrack = getMusicTrack;
  }

  connect({ roomPath, displayName }: { roomPath: string; displayName: string }): void {
    this.disconnect();

    // O endpoint de TURN é o do servidor configurado. `iceServers.ts` é puro (não
    // lê `import.meta.env`), e é por isso que ele pode ser configurado daqui em
    // vez de vir com a configuração do app embutida.
    configureIceServers({ endpoint: `${this.signalingUrl.replace(/\/$/, '')}/turn-credentials` });

    const signaling = createSignalingClient(this.signalingUrl);
    this.signaling = signaling;

    const mesh = new WebRTCMesh({
      signaling,
      getSelfId: () => this.selfId || signaling.socket.id || '',
      // **Sem `getRoomKey` e sem `localStream`** — ver decisões 1 e 2.
      onRemoteMusic: (peerId, stream) => this.events.onRemoteMusic(peerId, stream),
      onMusicMessage: (peerId, payload) => this.dropMusicMessage(peerId, payload),
      // A extensão não é co-autora da sessão: quem pede snapshot não recebe um.
      getMusicSnapshot: () => null,
      getIceServers: (opts) => getIceServers(opts),
    });
    this.mesh = mesh;
    mesh.localState = { displayName, cameraOff: true, micOff: true, screenOn: false };

    signaling.socket.on('connect', () => {
      this.events.onStatus('waiting-approval');
      signaling.requestJoin(roomPath, displayName);
    });

    signaling.socket.on('join-approved', ({ selfId, members }: { selfId: string; members: { id: string; displayName: string }[] }) => {
      this.selfId = selfId;
      this.peers = new Map(members.map((member) => [member.id, member.displayName]));
      this.events.onPeers(this.peerList());
      this.events.onStatus('connected', null);
      for (const member of members) void mesh.addPeer(member.id);
      // O track vai uma vez, aqui. Ver decisão 3.
      void this.attachMusic();
    });

    signaling.socket.on('join-denied', ({ reason }: { reason: string }) => {
      this.events.onStatus('denied', DENY_REASONS[reason] ?? `Entrada recusada (${reason}).`);
    });

    // Chegou pedido de entrada: o motor **guarda** e espera decisão humana.
    signaling.socket.on('join-request', ({ requesterId, displayName: name }: { requesterId: string; displayName: string }) => {
      this.pending.set(requesterId, name);
      this.events.onPendingJoins(this.pendingList());
    });

    signaling.socket.on('join-request-cancelled', ({ requesterId }: { requesterId: string }) => {
      this.pending.delete(requesterId);
      this.events.onPendingJoins(this.pendingList());
    });

    signaling.socket.on('peer-joined', ({ peerId, displayName: name }: { peerId: string; displayName: string }) => {
      this.pending.delete(peerId);
      this.peers.set(peerId, name);
      this.events.onPendingJoins(this.pendingList());
      this.events.onPeers(this.peerList());
      void mesh.addPeer(peerId);
    });

    signaling.socket.on('peer-left', ({ peerId }: { peerId: string }) => {
      this.peers.delete(peerId);
      mesh.removePeer(peerId);
      this.events.onPeers(this.peerList());
    });

    signaling.socket.on('signal', ({ from, data }: { from: string; data: unknown }) => {
      mesh.handleSignal(from, data as never);
    });

    signaling.socket.on('disconnect', () => {
      this.events.onStatus('idle', null);
    });

    signaling.socket.on('connect_error', (err: Error) => {
      this.events.onStatus('error', `Não consegui falar com o servidor de sinalização (${err.message}).`);
    });

    this.events.onStatus('connecting');
    signaling.connect();
  }

  /**
   * Ata o track de música. Chamado **uma vez**, logo depois de entrar na sala —
   * e um retry curto porque o grafo de áudio pode ainda não existir no instante
   * da aprovação (ele nasce no primeiro `ensureOutput`).
   */
  private async attachMusic(): Promise<void> {
    const track = this.getMusicTrack();
    if (!track) return;
    await this.mesh?.setMusicTrack(track);
  }

  /** Um peer novo chegou depois de o track existir? Reatar é idempotente. */
  refreshMusicTrack(): void {
    void this.attachMusic();
  }

  disconnect(): void {
    // `setMusicTrack(null)` só aqui, no desligamento — em nenhum outro lugar.
    void this.mesh?.setMusicTrack(null);
    this.mesh?.closeAll();
    this.mesh = null;
    this.signaling?.leaveRoom();
    this.signaling?.disconnect();
    this.signaling = null;
    this.peers.clear();
    this.pending.clear();
    this.selfId = '';
  }

  decideJoin(requesterId: string, approve: boolean): void {
    if (approve) this.signaling?.approveJoin(requesterId);
    else this.signaling?.denyJoin(requesterId);
    this.pending.delete(requesterId);
    this.events.onPendingJoins(this.pendingList());
  }

  announce(message: MusicMessage): void {
    this.mesh?.sendMusicMessage(message);
  }

  /**
   * Mensagem `music-*` de outro peer: **sanitizada e descartada**.
   *
   * Descartar sem sanitizar seria aceitar forma desconhecida — e sanitizar sem
   * descartar seria começar a participar do protocolo colaborativo, que é
   * exatamente o que a extensão não faz (§11.5). O `void` documenta a intenção:
   * o valor é calculado e jogado fora de propósito.
   */
  private dropMusicMessage(peerId: string, payload: MusicMessage): void {
    void sanitizeMusicMessage(payload, { fromPeerId: peerId });
  }

  private peerList(): EnginePeer[] {
    return [...this.peers].map(([id, displayName]) => ({ id, displayName }));
  }

  private pendingList(): EnginePendingJoin[] {
    return [...this.pending].map(([requesterId, displayName]) => ({ requesterId, displayName }));
  }
}
