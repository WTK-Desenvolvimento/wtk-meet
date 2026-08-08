/**
 * Normalizacao e tokenizacao de mensagens de chat.
 *
 * Regra de ouro do modulo: nada aqui produz HTML. A renderizacao usa
 * textContent / createElement, entao nao existe caminho de injecao. `escapeHtml`
 * existe apenas para contextos nao-DOM (logs, atributo title).
 */

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_NAME_LENGTH = 40;

// Controles ASCII (exceto \n e \t) e DEL. Removidos antes de qualquer uso.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/** Escapa os cinco caracteres perigosos em HTML. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Valida e normaliza o texto digitado.
 * @returns {{ok:boolean, text:string, reason?:string}}
 */
export function normalizeMessage(raw) {
  if (typeof raw !== 'string') return { ok: false, text: '', reason: 'tipo-invalido' };
  const cleaned = raw.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  if (cleaned.length === 0) return { ok: false, text: '', reason: 'vazia' };
  if (cleaned.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, text: cleaned.slice(0, MAX_MESSAGE_LENGTH), reason: 'muito-longa' };
  }
  return { ok: true, text: cleaned };
}

/** Nome de exibicao seguro: sem controle, sem quebras, com limite. */
export function normalizeName(raw, fallback = 'Convidado') {
  const cleaned = String(raw ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/**
 * Quebra o texto em tokens para renderizacao DOM. Somente http(s) vira link —
 * `javascript:`, `data:` e afins permanecem texto puro.
 * @returns {Array<{type:'text'|'link', value:string}>}
 */
export function tokenize(text) {
  const tokens = [];
  let cursor = 0;
  const source = String(text);
  for (const match of source.matchAll(URL_RE)) {
    const start = match.index;
    if (start > cursor) tokens.push({ type: 'text', value: source.slice(cursor, start) });
    // Pontuacao final costuma pertencer a frase, nao a URL.
    const trimmed = match[0].replace(/[.,;:!?)\]}]+$/, '');
    tokens.push({ type: 'link', value: trimmed });
    cursor = start + trimmed.length;
  }
  if (cursor < source.length) tokens.push({ type: 'text', value: source.slice(cursor) });
  return tokens.filter((t) => t.value.length > 0);
}

/** HH:MM no relogio local do receptor — nunca confiar no horario do remetente. */
export function formatClock(date) {
  const d = date instanceof Date ? date : new Date(date);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
