export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'http://localhost:4000';

export const MAX_PARTICIPANTS = 6;

let cachedIceServers = null;

/**
 * Obtém ICE servers com credenciais efêmeras do servidor de sinalização,
 * que por sua vez as busca na Cloudflare TURN API. As credenciais nunca
 * ficam baked no bundle do client. Resultado cacheado na sessão.
 */
export async function fetchIceServers() {
  if (cachedIceServers) return cachedIceServers;
  try {
    const res = await fetch(`${SIGNALING_URL}/turn-credentials`);
    if (res.ok) {
      const { iceServers } = await res.json();
      if (Array.isArray(iceServers) && iceServers.length > 0) {
        cachedIceServers = iceServers;
        return cachedIceServers;
      }
    }
  } catch {
    // Servidor inacessível — cair no fallback
  }
  // Fallback: STUN público da Cloudflare (funciona sem credenciais)
  return [{ urls: 'stun:stun.cloudflare.com:3478' }];
}
