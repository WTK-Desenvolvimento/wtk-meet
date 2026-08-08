import { MAX_MESSAGE_LENGTH, formatClock, normalizeMessage, tokenize } from './lib/text.js';

/**
 * Chat efemero da sala.
 *
 * Efemero de verdade: o historico vive neste array e em nenhum outro lugar.
 * Sem localStorage, sem backend, sem replay para quem chega depois. Sair da
 * sala apaga tudo.
 *
 * Toda mensagem entra no DOM como texto (`textContent`) ou como <a> com href
 * validado. Nao existe uma unica atribuicao de innerHTML neste arquivo — e por
 * isso que nao ha caminho de injecao.
 */

export function createChat({ panel, log, form, input, counter, badge, toggleButton, closeButton, onSend }) {
  /** @type {Array<object>} historico em memoria, descartado ao sair */
  const history = [];
  let unread = 0;
  let open = false;

  function isOpen() {
    return open;
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !next;
    toggleButton.setAttribute('aria-expanded', String(next));
    if (next) {
      unread = 0;
      renderBadge();
      input.focus();
      scrollToEnd();
    }
  }

  function renderBadge() {
    if (unread === 0) {
      badge.hidden = true;
      badge.textContent = '';
      return;
    }
    badge.hidden = false;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.setAttribute('aria-label', `${unread} mensagens não lidas`);
  }

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  /** @param {{from:{id:string,name:string}, text:string, system?:boolean}} msg */
  function append(msg, { mine = false, system = false } = {}) {
    const stick = atBottom();
    const item = document.createElement('li');
    item.className = `msg${mine ? ' mine' : ''}${system ? ' system' : ''}`;

    if (!system) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = `${msg.from.name} · ${formatClock(new Date())}`;
      item.appendChild(meta);
    }

    const body = document.createElement('div');
    body.className = 'msg-text';
    for (const token of tokenize(msg.text)) {
      if (token.type === 'link') {
        const anchor = document.createElement('a');
        anchor.href = token.value; // tokenize so devolve http(s)
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer nofollow';
        anchor.textContent = token.value;
        body.appendChild(anchor);
      } else {
        body.appendChild(document.createTextNode(token.value));
      }
    }
    item.appendChild(body);
    log.appendChild(item);
    history.push(msg);

    if (stick || mine) scrollToEnd();
    if (!open && !system) {
      unread += 1;
      renderBadge();
    }
  }

  function system(text) {
    append({ from: { id: 'sistema', name: 'sistema' }, text }, { system: true });
  }

  function updateCounter() {
    const length = input.value.length;
    counter.textContent = `${length}/${MAX_MESSAGE_LENGTH}`;
    counter.classList.toggle('over', length >= MAX_MESSAGE_LENGTH);
  }

  function submit() {
    const result = normalizeMessage(input.value);
    if (!result.ok) {
      if (result.reason === 'muito-longa') system(`Mensagem cortada em ${MAX_MESSAGE_LENGTH} caracteres.`);
      return;
    }
    onSend(result.text);
    input.value = '';
    updateCounter();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  // Enter envia, Shift+Enter quebra linha.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  input.addEventListener('input', updateCounter);
  toggleButton.addEventListener('click', () => setOpen(!open));
  closeButton.addEventListener('click', () => setOpen(false));
  updateCounter();
  renderBadge();

  return {
    append,
    system,
    setOpen,
    isOpen,
    get unread() {
      return unread;
    },
    /** Descarte explicito ao sair da sala. */
    destroy() {
      history.length = 0;
      log.replaceChildren();
      unread = 0;
      renderBadge();
      setOpen(false);
    },
  };
}
