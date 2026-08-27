/**
 * Acessor único do `AudioContext` da sala.
 *
 * `ARCHITECTURE.md` §6.4 fixa **um** `AudioContext` para a sala inteira, e a
 * razão deixou de ser só custo de CPU quando a música entrou: nós de contextos
 * diferentes **não podem ser conectados**. O grafo do player (`musicEngine.js`)
 * precisa do mesmo contexto do indicador de fala (`audioLevels.js`), então o
 * contexto não pode pertencer a nenhum dos dois — ele mora aqui, e o `Room`
 * é quem cria e fecha.
 *
 * Antes, o dono era o `AudioLevelMonitor`: `monitor.close()` fechava o contexto.
 * Se o motor de música usasse esse mesmo contexto, fechar o monitor mataria a
 * música em silêncio, sem erro nenhum no console.
 */

let ctx: AudioContext | null = null;

/**
 * Devolve o contexto compartilhado, criando-o se preciso. O contexto nasce
 * suspenso até um gesto do usuário (política de autoplay); o `resume` é
 * tentado a cada chamada e reintentado por `resumeAudioContextOnGesture`.
 */
export function getAudioContext(): AudioContext | null {
  const Ctor =
    typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;

  if (!ctx || ctx.state === 'closed') {
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {
      // sem gesto ainda — o hook de gesto tenta de novo
    });
  }
  return ctx;
}

/** O contexto atual, sem criar nenhum. `null` se ainda não existe ou já fechou. */
export function peekAudioContext(): AudioContext | null {
  return ctx && ctx.state !== 'closed' ? ctx : null;
}

/** Retenta o `resume` no primeiro gesto do usuário. Devolve um desregistrador. */
export function resumeAudioContextOnGesture(): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => {
    getAudioContext();
  };
  const events = ['click', 'keydown', 'touchstart'];
  for (const evt of events) window.addEventListener(evt, handler, { passive: true });
  return () => {
    for (const evt of events) window.removeEventListener(evt, handler);
  };
}

/** Fecha o contexto compartilhado. Só a limpeza do `Room` chama isto. */
export function closeAudioContext(): void {
  const current = ctx;
  ctx = null;
  if (!current || current.state === 'closed') return;
  current.close().catch(() => {
    // já fechado
  });
}
