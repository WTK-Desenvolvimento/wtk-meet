const CF_API_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/**
 * Obtém ICE servers com credenciais efêmeras via Cloudflare TURN API.
 * Retorna null se as variáveis de ambiente não estiverem configuradas.
 * O array retornado está no formato RTCPeerConnection.iceServers pronto para uso.
 */
export async function fetchCloudflareIceServers() {
  const tokenId  = process.env.CF_TURN_TOKEN_ID;
  const apiToken = process.env.CF_TURN_API_TOKEN;
  const ttl      = Number(process.env.CF_TURN_TTL || 86400);

  if (!tokenId || !apiToken) return null;

  const res = await fetch(
    `${CF_API_URL}/${tokenId}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    },
  );

  if (!res.ok) throw new Error(`Cloudflare TURN API error: ${res.status}`);

  const { iceServers } = await res.json();
  return iceServers;
}
