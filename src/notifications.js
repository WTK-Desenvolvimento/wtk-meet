/**
 * Avisos de entrada e saida: modal (entrada), toast (saida) e sons curtos.
 *
 * Os sons sao sintetizados com WebAudio — dois osciladores com envelope. Sem
 * arquivo de audio para baixar, sem 404 de asset, e o volume fica sob controle.
 *
 * A preferencia de silenciar e persistida; e a unica coisa que este app guarda
 * no navegador.
 */

const PREF_KEY = 'wtk-meet:sons';
const TOAST_MS = 4200;
const MAX_TOASTS = 4;

export function createNotifier({ toastContainer, modalRoot, modalTitle, modalBody, modalOk }) {
  let audioCtx = null;
  let enabled = readPref();
  /** @type {Array<{title:string, body:string}>} */
  const modalQueue = [];
  let modalOpen = false;
  let lastFocused = null;

  function readPref() {
    try {
      return localStorage.getItem(PREF_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  function setEnabled(next) {
    enabled = next;
    try {
      localStorage.setItem(PREF_KEY, next ? 'on' : 'off');
    } catch {
      /* modo privado sem storage: a preferencia vale so nesta sessao */
    }
  }

  /** @param {'join'|'leave'} kind */
  function playSound(kind) {
    if (!enabled) return;
    try {
      audioCtx ??= new (window.AudioContext ?? window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const now = audioCtx.currentTime;
      // Entrada sobe (440 -> 660), saida desce (520 -> 330).
      const [from, to] = kind === 'join' ? [440, 660] : [520, 330];
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(from, now);
      osc.frequency.exponentialRampToValueAtTime(to, now + 0.16);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.32);
    } catch {
      /* audio bloqueado pelo navegador: o aviso visual ja cumpre o papel */
    }
  }

  function toast(text, variant = 'info') {
    const el = document.createElement('div');
    el.className = `toast${variant === 'warn' ? ' warn' : ''}`;
    el.textContent = text;
    toastContainer.appendChild(el);
    // Empilhamento limitado: rajada nao pode cobrir a chamada.
    while (toastContainer.children.length > MAX_TOASTS) {
      toastContainer.firstElementChild.remove();
    }
    setTimeout(() => el.remove(), TOAST_MS);
  }

  function showModal(title, body) {
    modalQueue.push({ title, body });
    if (!modalOpen) drainModal();
  }

  function drainModal() {
    const next = modalQueue.shift();
    if (!next) {
      modalOpen = false;
      modalRoot.hidden = true;
      lastFocused?.focus?.();
      return;
    }
    modalOpen = true;
    modalTitle.textContent = next.title;
    modalBody.textContent = next.body;
    if (!modalRoot.hidden) return;
    lastFocused = document.activeElement;
    modalRoot.hidden = false;
    modalOk.focus();
  }

  modalOk.addEventListener('click', drainModal);
  modalRoot.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') drainModal();
  });

  return {
    toast,
    showModal,
    playSound,
    setEnabled,
    get enabled() {
      return enabled;
    },
    /** Libera o AudioContext no primeiro gesto do usuario. */
    unlock() {
      try {
        audioCtx ??= new (window.AudioContext ?? window.webkitAudioContext)();
        audioCtx.resume().catch(() => {});
      } catch {
        /* sem audio disponivel */
      }
    },
  };
}
