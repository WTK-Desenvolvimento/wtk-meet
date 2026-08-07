import crypto from 'node:crypto';

const TTL_SECONDS = Number(process.env.TURN_CREDENTIAL_TTL || 3600);

/**
 * Ephemeral TURN credentials via the coturn "TURN REST API" convention:
 * username = "<expiry-unix-ts>:<label>", credential = base64(HMAC-SHA1(sharedSecret, username)).
 * coturn is configured with the same shared secret (`use-auth-secret` /
 * `static-auth-secret`) so it can verify credentials without either side
 * persisting a per-user record — nothing here is ever stored.
 */
export function issueTurnCredentials({ label = 'wtk-meet' } = {}) {
  const sharedSecret = process.env.TURN_SHARED_SECRET;
  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  if (!sharedSecret || turnUrls.length === 0) {
    return null; // no self-hosted TURN configured — client falls back to STUN-only
  }

  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const username = `${expiresAt}:${label}`;
  const credential = crypto
    .createHmac('sha1', sharedSecret)
    .update(username)
    .digest('base64');

  return {
    username,
    credential,
    urls: turnUrls,
    ttl: TTL_SECONDS,
  };
}
