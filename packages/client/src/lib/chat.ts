/**
 * Chat de texto da sala.
 *
 * Tudo aqui é P2P: as mensagens viajam pelo `RTCDataChannel` de cada conexão do
 * mesh (ver `webrtcMesh.js`), nunca pelo servidor de sinalização — não existe
 * nenhum evento Socket.IO de chat, nem no client nem no servidor.
 *
 * Tudo aqui também é efêmero: o histórico vive apenas no estado do React. Não
 * há `localStorage`, `sessionStorage`, IndexedDB nem servidor. Recarregar a
 * página ou sair da sala apaga a conversa por completo — é o comportamento
 * pretendido, não uma limitação.
 */

/**
 * Canal negociado fora de banda: os dois lados criam com o mesmo id, então não
 * existe `ondatachannel` nem corrida sobre quem cria o canal primeiro.
 */
export const CHAT_CHANNEL_LABEL = 'wtk-chat';
export const CHAT_CHANNEL_ID = 0;

export const MAX_MESSAGE_LENGTH = 2000;

/** Teto de mensagens em memória — a conversa não pode crescer sem limite. */
export const MAX_HISTORY = 300;

function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Monta a mensagem que será serializada no data channel. `sentAt` é o relógio
 * de quem enviou: sem servidor não há relógio autoritativo, e para exibir a
 * hora ao lado do nome isso basta.
 */
/** Uma linha da conversa, já normalizada. */
export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  sentAt: number;
  /**
   * Marcado só no eco local (`Room` acrescenta ao ecoar a própria mensagem).
   * Nunca trafega: `createChatMessage` não o produz e `sanitizeIncomingMessage`
   * não o lê.
   */
  mine?: boolean;
}

export function createChatMessage({
  author,
  text,
}: {
  author?: unknown;
  text?: unknown;
}): ChatMessage | null {
  const trimmed = String(text ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!trimmed) return null;
  return {
    id: randomId(),
    author: String(author ?? '').slice(0, 40) || 'Participante',
    text: trimmed,
    sentAt: Date.now(),
  };
}

/**
 * Normaliza uma mensagem recebida de um peer. O conteúdo vem de outro browser,
 * então nada é confiável: tipos, tamanhos e a própria forma são checados aqui,
 * e o `id` é regerado localmente para um peer não conseguir colidir com o id de
 * outro e sobrescrever uma linha da conversa.
 */
export function sanitizeIncomingMessage(
  raw: unknown,
  { fallbackAuthor }: { fallbackAuthor?: string } = {},
): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  // O conteúdo vem de outro browser: nem a forma do objeto é confiável, então
  // ele é lido campo a campo e nada é assumido.
  const bruto = raw as { text?: unknown; author?: unknown; sentAt?: unknown };
  const text = typeof bruto.text === 'string' ? bruto.text.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
  if (!text) return null;
  const author =
    (typeof bruto.author === 'string' && bruto.author.trim().slice(0, 40)) ||
    fallbackAuthor ||
    'Participante';
  const sentAt = typeof bruto.sentAt === 'number' && Number.isFinite(bruto.sentAt) ? bruto.sentAt : Date.now();
  return { id: randomId(), author, text, sentAt };
}

/**
 * Qualquer mensagem do data channel. O único campo garantido é `type`; quem
 * consome faz a discriminação — chat, estado de câmera/tela e música compartilham
 * este canal.
 */
export interface ChannelPayload {
  type: string;
  [campo: string]: unknown;
}

/** Desserializa o payload bruto do data channel. Nunca lança. */
export function parseChannelPayload(raw: unknown): ChannelPayload | null {
  if (typeof raw !== 'string') return null;
  try {
    const payload: unknown = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || typeof (payload as { type?: unknown }).type !== 'string') {
      return null;
    }
    return payload as ChannelPayload;
  } catch {
    return null;
  }
}

export function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Acrescenta ao histórico respeitando o teto de memória. */
export function appendMessage(history: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const next = [...history, message];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}
