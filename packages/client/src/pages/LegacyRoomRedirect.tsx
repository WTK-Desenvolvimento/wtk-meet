import { useEffect } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { legacyRoomRedirect } from '../lib/roomRouting.js';
import { trackPageView } from '../lib/telemetry.js';

/**
 * `/room/:roomId#chave` → `/:roomId#chave`.
 *
 * Existe por causa dos links que já estavam circulando quando o prefixo caiu.
 * Não é só "não dar 404": o UUID antigo atravessa o slugify sem mudar (já é
 * minúsculo, alfanumérico e com hífen), então quem abre o link velho entra na
 * **mesma** sala de sinalização que quem abre o novo — e o fragmento, que
 * carrega a passphrase, é repassado intacto.
 *
 * `replace` porque a URL antiga não deve sobrar no histórico: um Voltar que
 * caísse nela só refaria o mesmo redirecionamento.
 */
export default function LegacyRoomRedirect() {
  const { roomId } = useParams();
  const { hash } = useLocation();
  // Mede se os links antigos ainda circulam — a única pergunta que justifica a
  // existência deste componente, e a que decide quando ele pode ser removido.
  // O beacon leva `route: 'legacy'` e nada mais: nem o `roomId` do link velho,
  // nem o fragmento, que carrega a passphrase.
  useEffect(() => trackPageView('legacy'), []);
  return <Navigate to={legacyRoomRedirect(roomId, hash)} replace />;
}
