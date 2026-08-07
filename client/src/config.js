export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'http://localhost:4000';

export const MAX_PARTICIPANTS = 6;

/**
 * Self-hosted STUN/TURN only — no reliance on third-party infrastructure
 * (no stun.l.google.com, no managed TURN provider). TURN credentials are
 * short-lived, minted per-session by the signaling server (see
 * server/src/turnCredentials.js), never a static secret baked into the
 * client bundle.
 */
export async function fetchIceServers() {
  const iceServers = [];
  try {
    const res = await fetch(`${SIGNALING_URL}/turn-credentials`);
    if (res.ok) {
      const { stunUrl, turn } = await res.json();
      if (stunUrl) iceServers.push({ urls: stunUrl });
      if (turn) {
        iceServers.push({
          urls: turn.urls,
          username: turn.username,
          credential: turn.credential,
        });
      }
    }
  } catch {
    // Signaling server unreachable for TURN provisioning — caller falls
    // back to whatever is in iceServers (possibly empty, direct-LAN only).
  }
  if (iceServers.length === 0) {
    iceServers.push({ urls: 'stun:localhost:3478' });
  }
  return iceServers;
}
