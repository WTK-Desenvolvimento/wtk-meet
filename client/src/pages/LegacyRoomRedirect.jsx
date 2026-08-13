import { Navigate, useLocation, useParams } from 'react-router-dom';
import { legacyRoomRedirect } from '../lib/roomRouting.js';

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
  return <Navigate to={legacyRoomRedirect(roomId, hash)} replace />;
}
