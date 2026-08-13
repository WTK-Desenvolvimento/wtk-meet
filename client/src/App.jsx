import { Navigate, Routes, Route } from 'react-router-dom';
import Home from './pages/Home.jsx';
import Room from './pages/Room.jsx';
import LegacyRoomRedirect from './pages/LegacyRoomRedirect.jsx';
import { ROUTE_TABLE } from './lib/roomRouting.js';

/**
 * A regra do endereço, inteira: **primeiro segmento reservado ⇒ tela do app;
 * qualquer outro ⇒ sala**.
 *
 * Os paths vêm de `ROUTE_TABLE` (`lib/roomRouting.js`) e aqui só se liga cada
 * `screen` ao seu elemento. A tabela mora lá porque `client/test/
 * roomRouting.test.mjs` roda o matcher de verdade do react-router sobre ela —
 * com as rotas escritas direto em JSX, o teste teria que importar a sala
 * inteira (e o `import.meta.env` do Vite) só para provar que `/app` ganha de
 * `/:roomSlug`.
 *
 * A precedência é do react-router, não da ordem da lista: estático (`/app`)
 * ganha de dinâmico (`/:roomSlug`), que ganha do splat (`*`).
 */
const SCREENS = {
  // A raiz continua sendo a porta de entrada — sala nenhuma mora em `/`.
  home: <Home />,
  // Namespace das telas da aplicação. Sem filha nesta entrega, mas reservado
  // desde já: sem ele, `/app/qualquer-coisa` viraria sala de alguém.
  'app-namespace': <Navigate to="/" replace />,
  'legacy-room': <LegacyRoomRedirect />,
  // Um segmento que não é rota da aplicação: é sala. A checagem de reservado
  // (`/assets` e companhia, que o nginx serve antes de o SPA existir) acontece
  // dentro de `Room`, que volta para a Home quando o path não é utilizável.
  room: <Room />,
  // Multi-segmento não é sala (ver `lib/roomRouting.js`).
  'not-found': <Navigate to="/" replace />,
};

export default function App() {
  return (
    <Routes>
      {ROUTE_TABLE.map(({ path, screen }) => (
        <Route key={path} path={path} element={SCREENS[screen]} />
      ))}
    </Routes>
  );
}
