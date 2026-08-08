/**
 * Ondas e particulas ao redor do tile de quem fala.
 *
 * Nao tem loop proprio: e desenhado pelo mesmo tick do medidor de audio. Um rAF
 * so na aplicacao inteira. Quando o nivel zera, limpa o canvas uma vez e para.
 *
 * `prefers-reduced-motion` troca a animacao por um contorno estatico cuja
 * opacidade ainda acompanha o volume — a informacao continua la, o movimento
 * nao.
 */

const AZUL = '59, 130, 246';
const WAVE_INTERVAL_MS = 320;
const WAVE_LIFE_MS = 1100;
const PARTICLE_COUNT = 14;

const prefersReducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createSpeakingRing(canvas) {
  const ctx = canvas.getContext('2d');
  /** @type {Array<{born:number, strength:number}>} */
  let waves = [];
  let lastWaveAt = 0;
  let dirty = false;
  let width = 0;
  let height = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function roundRect(inset, radius) {
    ctx.beginPath();
    const r = Math.max(0, radius);
    if (ctx.roundRect) {
      ctx.roundRect(inset, inset, width - inset * 2, height - inset * 2, r);
    } else {
      ctx.rect(inset, inset, width - inset * 2, height - inset * 2);
    }
  }

  function drawStatic(level) {
    ctx.clearRect(0, 0, width, height);
    if (level <= 0.01) return;
    ctx.lineWidth = 2 + level * 3;
    ctx.strokeStyle = `rgba(${AZUL}, ${0.25 + level * 0.6})`;
    roundRect(3, 12);
    ctx.stroke();
  }

  function drawAnimated(level, speaking, now) {
    ctx.clearRect(0, 0, width, height);

    if (speaking && now - lastWaveAt > WAVE_INTERVAL_MS - level * 140) {
      waves.push({ born: now, strength: Math.max(level, 0.15) });
      lastWaveAt = now;
    }
    waves = waves.filter((w) => now - w.born < WAVE_LIFE_MS);

    // Ondas: contornos que crescem para dentro e desvanecem.
    for (const wave of waves) {
      const t = (now - wave.born) / WAVE_LIFE_MS;
      const alpha = (1 - t) * 0.5 * wave.strength;
      if (alpha <= 0.01) continue;
      ctx.lineWidth = 1 + wave.strength * 2.5;
      ctx.strokeStyle = `rgba(${AZUL}, ${alpha})`;
      roundRect(2 + t * (10 + wave.strength * 16), 12 + t * 8);
      ctx.stroke();
    }

    // Particulas: percorrem o perimetro; quantidade e brilho seguem o volume.
    const visible = Math.round(PARTICLE_COUNT * level);
    if (visible > 0) {
      const perimeter = (width + height) * 2;
      const drift = (now / 22) % perimeter;
      for (let i = 0; i < visible; i += 1) {
        const pos = (drift + (perimeter / PARTICLE_COUNT) * i) % perimeter;
        const { x, y } = pointOnPerimeter(pos);
        const radius = 1 + level * 2.4 + Math.sin(now / 180 + i) * 0.6;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.4, radius), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${AZUL}, ${0.35 + level * 0.5})`;
        ctx.fill();
      }
    }
  }

  function pointOnPerimeter(pos) {
    if (pos < width) return { x: pos, y: 2 };
    if (pos < width + height) return { x: width - 2, y: pos - width };
    if (pos < width * 2 + height) return { x: width - (pos - width - height), y: height - 2 };
    return { x: 2, y: height - (pos - width * 2 - height) };
  }

  return {
    /** @param {{level:number, speaking:boolean}} state */
    render(state) {
      const level = state?.level ?? 0;
      const speaking = Boolean(state?.speaking);

      if (level <= 0.01 && !speaking) {
        if (dirty) {
          if (width) ctx.clearRect(0, 0, width, height);
          waves = [];
          dirty = false;
        }
        return; // silencio: nada a desenhar, nada a gastar
      }

      if (!resize()) return;
      dirty = true;
      if (prefersReducedMotion) drawStatic(level);
      else drawAnimated(level, speaking, performance.now());
    },

    clear() {
      waves = [];
      if (width) ctx.clearRect(0, 0, width, height);
      dirty = false;
    },
  };
}

export const REDUCED_MOTION = prefersReducedMotion;
