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
export function createChatMessage({ author, text }) {
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
export function sanitizeIncomingMessage(raw, { fallbackAuthor } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
  if (!text) return null;
  const author =
    (typeof raw.author === 'string' && raw.author.trim().slice(0, 40)) ||
    fallbackAuthor ||
    'Participante';
  const sentAt = Number.isFinite(raw.sentAt) ? raw.sentAt : Date.now();
  return { id: randomId(), author, text, sentAt };
}

/** Desserializa o payload bruto do data channel. Nunca lança. */
export function parseChannelPayload(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

export function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Acrescenta ao histórico respeitando o teto de memória. */
export function appendMessage(history, message) {
  const next = [...history, message];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}
