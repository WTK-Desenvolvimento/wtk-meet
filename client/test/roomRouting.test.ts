/**
 * Quem é sala e quem é aplicação, provado com o matcher de verdade do
 * react-router (`matchRoutes` sobre o mesmo `ROUTE_TABLE` que `App.jsx`
 * consome) mais as funções puras que a sala e a Home usam.
 *
 * O que este arquivo protege é uma classe de bug silenciosa: com a sala na
 * raiz, qualquer rota nova de aplicação passa a disputar espaço com o endereço
 * de alguém. Se `/app` deixar de ganhar de `/:roomSlug`, ninguém vê erro — a
 * Home some e no lugar aparece uma sala chamada "app".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { matchRoutes } from 'react-router-dom';

import {
  BLOCKED_SEGMENTS,
  RESERVED_SEGMENTS,
  ROUTE_TABLE,
  isReservedPath,
  isRoomPath,
  legacyRoomRedirect,
  parseInviteLink,
  roomPathFromLocation,
} from '../src/lib/roomRouting.js';

/** Nome da tela que o react-router escolheria para um path. */
const screenFor = (pathname: string) => {
  const matches = matchRoutes([...ROUTE_TABLE], pathname);
  return matches?.[matches.length - 1]?.route.screen ?? null;
};

test('a raiz continua sendo a Home', () => {
  assert.equal(screenFor('/'), 'home');
});

test('as telas da aplicação vivem sob /app', () => {
  assert.equal(screenFor('/app'), 'home');
  assert.equal(screenFor('/app/qualquer-tela-futura'), 'app-namespace');
});

test('qualquer path de um segmento que não seja rota da app é sala', () => {
  assert.equal(screenFor('/uma-sala-so-minha'), 'room');
  assert.equal(screenFor('/k7m2xq9tp'), 'room');
  assert.equal(screenFor('/daily'), 'room');
});

test('/app ganha de /:roomSlug — estático vence dinâmico', () => {
  // Sem esta precedência a Home vira uma sala chamada "app".
  assert.notEqual(screenFor('/app'), 'room');
  assert.equal(screenFor('/room/3f2b7c1e-9a41-4d0b-8e77-2c5b9d1a4f60'), 'legacy-room');
});

test('multi-segmento não é sala', () => {
  // `/a/b` casa o splat, nunca `/:roomSlug`: com hierarquia, reservar
  // namespace no futuro roubaria a sala de alguém.
  assert.equal(screenFor('/time/daily'), 'not-found');
  assert.equal(screenFor('/a/b/c'), 'not-found');
});

test('a lista de reservados cobre rotas da app e paths da camada estática', () => {
  for (const segmento of ['app', 'room', 'api', 'health', 'turn-credentials']) {
    assert.ok(RESERVED_SEGMENTS.includes(segmento), `${segmento} saiu dos reservados`);
    assert.ok(isReservedPath(segmento));
  }
  // `assets` é diretório real em produção: `try_files $uri/` casa antes do
  // fallback do SPA, então esse path nunca chegaria ao React.
  for (const segmento of ['assets', 'static', 'public', 'favicon-ico', 'robots-txt']) {
    assert.ok(BLOCKED_SEGMENTS.includes(segmento), `${segmento} saiu da blocklist`);
    assert.ok(isReservedPath(segmento));
  }
  assert.ok(!isReservedPath('daily'));
  assert.ok(!isRoomPath('assets'));
  assert.ok(isRoomPath('daily'));
});

test('roomPathFromLocation devolve o path canônico e só ele', () => {
  assert.equal(roomPathFromLocation('/daily'), 'daily');
  assert.equal(roomPathFromLocation('/Daily'), 'daily');
  assert.equal(roomPathFromLocation('/daily/'), 'daily');
  assert.equal(roomPathFromLocation('/uma-sala-so-minha'), 'uma-sala-so-minha');

  // Tudo que não é sala sai como '' — quem chama redireciona para a Home.
  assert.equal(roomPathFromLocation('/'), '');
  assert.equal(roomPathFromLocation('/app'), '');
  assert.equal(roomPathFromLocation('/assets'), '');
  assert.equal(roomPathFromLocation('/a/b'), '');
  assert.equal(roomPathFromLocation('/!!!'), '');
  assert.equal(roomPathFromLocation(undefined), '');
});

test('links antigos /room/<id>#chave caem em /<id>#chave com o fragmento intacto', () => {
  const uuid = '3f2b7c1e-9a41-4d0b-8e77-2c5b9d1a4f60';
  const chave = 'kJ8sQ2-nZ_1aBcDeFgHiJk';
  // O fragmento **é** a chave: perdê-lo aqui transformaria um convite válido
  // numa sala nova e vazia.
  assert.equal(legacyRoomRedirect(uuid, `#${chave}`), `/${uuid}#${chave}`);
  // O UUID legado atravessa a normalização sem mudar — mesma sala, não só
  // mesma página.
  assert.equal(legacyRoomRedirect(uuid, `#${chave}`).slice(1).split('#')[0], uuid);
});

test('o redirect legado normaliza e cai na Home quando não sobra sala', () => {
  assert.equal(legacyRoomRedirect('Daily', '#k'), '/daily#k');
  assert.equal(legacyRoomRedirect('daily', ''), '/daily');
  assert.equal(legacyRoomRedirect('!!!', '#k'), '/');
  assert.equal(legacyRoomRedirect('app', '#k'), '/');
});

test('parseInviteLink aceita os formatos que circulam de verdade', () => {
  const esperado = { path: 'daily', passphrase: 'k7' };
  assert.deepEqual(parseInviteLink('https://meet.exemplo.com/daily#k7'), esperado);
  assert.deepEqual(parseInviteLink('  https://meet.exemplo.com/daily#k7  '), esperado);
  // Sem esquema e path puro: `new URL()` sozinho lançaria nos dois.
  assert.deepEqual(parseInviteLink('meet.exemplo.com/daily#k7'), esperado);
  assert.deepEqual(parseInviteLink('/daily#k7'), esperado);
  // Formato legado.
  assert.deepEqual(parseInviteLink('https://meet.exemplo.com/room/daily#k7'), esperado);
  assert.deepEqual(parseInviteLink('/room/daily#k7'), esperado);
  // Normaliza o que veio torto.
  assert.deepEqual(parseInviteLink('https://meet.exemplo.com/Daily?utm=x#k7'), esperado);
});

test('parseInviteLink devolve null em vez de lançar', () => {
  assert.equal(parseInviteLink('https://meet.exemplo.com/daily'), null, 'sem chave não é convite');
  assert.equal(parseInviteLink('https://meet.exemplo.com/daily#'), null);
  assert.equal(parseInviteLink('https://meet.exemplo.com/#k7'), null, 'sem sala não é convite');
  assert.equal(parseInviteLink('https://meet.exemplo.com/a/b#k7'), null);
  assert.equal(parseInviteLink('/app#k7'), null, 'rota reservada não é sala');
  assert.equal(parseInviteLink('não é link nenhum'), null);
  assert.equal(parseInviteLink(''), null);
  assert.equal(parseInviteLink(null), null);
});
