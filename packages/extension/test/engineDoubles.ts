/**
 * Dublês do motor: uma porta, um lado de áudio e um lado de sala.
 *
 * Não é mock de biblioteca — é a implementação mínima das interfaces que o
 * `EngineCore` declara, com efeitos de verdade que o teste pode olhar. É o mesmo
 * padrão dos testes de hook do client (`musicRoomPlayerError.test.mjs`): o que
 * se troca é o mundo externo, não a lógica sob teste.
 */

import type { AudioSide, RoomSide, SoundHandle } from '../src/engine/core.ts';
import type { PortLike } from '../src/lib/hub.ts';
import type { EngineState } from '../src/lib/protocol.ts';
import type { Favorite, PreferenceStorage } from '../../client/src/lib/soundboard.ts';
import type { QueueEntry } from '../../client/src/lib/musicSession.ts';
import type { MusicMessage } from '../../client/src/lib/musicProtocol.ts';

/** Uma aba: recebe o que o motor empurra e guarda para o teste conferir. */
export class FakePort implements PortLike {
  name = 'wtk-engine';
  mensagens: { target: string; type: string; [key: string]: unknown }[] = [];
  /** Vira `true` quando o "popup fecha" — daí em diante `postMessage` lança. */
  morta = false;

  rotulo: string;

  // Nada de parameter property (`constructor(public rotulo)`): o type stripping
  // do Node não a suporta, e o `erasableSyntaxOnly` do `tsconfig.base.json`
  // existe justamente para que isso falhe no `typecheck`, e não no teste.
  constructor(rotulo: string) {
    this.rotulo = rotulo;
  }

  postMessage(message: unknown): void {
    if (this.morta) throw new Error('Attempting to use a disconnected port object');
    this.mensagens.push(message as { target: string; type: string });
  }

  /** O estado que **esta aba** tem na tela: snapshot inicial + deltas. */
  get estado(): Partial<EngineState> {
    let visao: Partial<EngineState> = {};
    for (const message of this.mensagens) {
      if (message.type === 'state') visao = { ...(message.state as EngineState) };
      if (message.type === 'patch') visao = { ...visao, ...(message.patch as Partial<EngineState>) };
    }
    return visao;
  }

  get avisos(): string[] {
    return this.mensagens.filter((m) => m.type === 'notice').map((m) => String(m.text));
  }
}

/** Storage em memória com a mesma forma síncrona que `soundboard.ts` espera. */
export class MemoryStorage implements PreferenceStorage {
  private dados = new Map<string, string>();

  getItem(key: string): string | null {
    return this.dados.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.dados.set(key, value);
  }
}

export class FakeAudio implements AudioSide {
  /** Cada disparo que efetivamente tocou. É o que prova "uma reprodução". */
  disparos: string[] = [];
  faixasCarregadas: string[] = [];
  contextos = 1;
  volume = 1;
  tocando = false;
  posicao = 0;
  /** Quando `false`, `probe` recusa — é o caminho do "sem CORS". */
  corsOk = true;
  /** Razão para `loadSound` rejeitar, quando o teste quer a recusa. */
  erroDeEfeito: string | null = null;

  audioContextCount(): number {
    return this.contextos;
  }

  setMonitorVolume(value: number): void {
    this.volume = value;
  }

  async probe(): Promise<boolean> {
    return this.corsOk;
  }

  async loadTrack(entry: QueueEntry): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.faixasCarregadas.push(entry.title);
    return { ok: true };
  }

  async play(): Promise<boolean> {
    this.tocando = true;
    return true;
  }

  pause(): void {
    this.tocando = false;
  }

  seek(positionSec: number): void {
    this.posicao = positionSec;
  }

  stopTrack(): void {
    this.tocando = false;
    this.posicao = 0;
  }

  positionSec(): number {
    return this.posicao;
  }

  durationSec(): number | null {
    return 120;
  }

  isPlaying(): boolean {
    return this.tocando;
  }

  async loadSound(favorite: Favorite): Promise<SoundHandle> {
    if (this.erroDeEfeito) throw Object.assign(new Error(this.erroDeEfeito), { reason: this.erroDeEfeito });
    return { durationMs: 1200, titulo: favorite.title } as SoundHandle;
  }

  startSound(handle: SoundHandle): { durationMs: number } {
    this.disparos.push(String((handle as SoundHandle & { titulo?: string }).titulo ?? ''));
    return { durationMs: handle.durationMs };
  }
}

export class FakeRoom implements RoomSide {
  conexoes: { roomPath: string; displayName: string }[] = [];
  anuncios: MusicMessage[] = [];
  decisoes: { requesterId: string; approve: boolean }[] = [];
  desconexoes = 0;

  connect(options: { roomPath: string; displayName: string }): void {
    this.conexoes.push(options);
  }

  disconnect(): void {
    this.desconexoes += 1;
  }

  decideJoin(requesterId: string, approve: boolean): void {
    this.decisoes.push({ requesterId, approve });
  }

  announce(message: MusicMessage): void {
    this.anuncios.push(message);
  }
}

/** Relógio de mentira: o rate limit recebe o tempo, nunca o consulta. */
export function relogio(inicio = 0): { agora: () => number; avancar: (ms: number) => void } {
  let t = inicio;
  return { agora: () => t, avancar: (ms: number) => { t += ms; } };
}
