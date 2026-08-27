/**
 * A gramática do endereço da sala, que é a coisa mais barata de quebrar e a
 * mais cara de descobrir quebrada: o path é a chave da sala no servidor **e** o
 * salt do PBKDF2. Normalizar diferente em dois lugares não dá erro — dá duas
 * salas vazias, uma para cada participante.
 *
 * Lógica pura, sem DOM: roda no `node --test` do projeto sem navegador.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ROOM_PATH_LENGTH,
  ROOM_PATH_PATTERN,
  ROOM_SLUG_ALPHABET,
  ROOM_SLUG_LENGTH,
  buildRoomUrl,
  generatePassphrase,
  generateRoomSlug,
  isValidRoomPath,
  normalizeRoomPath,
  normalizeRoomPathInput,
} from '../src/lib/roomSlug.js';

test('o slug gerado tem o tamanho alvo e cabe na folga de 9 caracteres', () => {
  assert.equal(ROOM_SLUG_LENGTH, 9);
  for (let i = 0; i < 200; i += 1) {
    const slug = generateRoomSlug();
    assert.equal(slug.length, ROOM_SLUG_LENGTH);
    assert.ok(slug.length <= 9, `slug longo demais: ${slug}`);
  }
});

test('o slug só usa o alfabeto base32 sem ambiguidade', () => {
  assert.equal(ROOM_SLUG_ALPHABET.length, 32, 'o alfabeto precisa ter potência de 2 símbolos');
  assert.equal(new Set(ROOM_SLUG_ALPHABET).size, 32, 'símbolo repetido enviesaria o sorteio');
  for (let i = 0; i < 500; i += 1) {
    for (const char of generateRoomSlug()) {
      assert.ok(ROOM_SLUG_ALPHABET.includes(char), `caractere fora do alfabeto: ${char}`);
    }
  }
});

test('nenhum caractere confundível ao ditar entra no slug', () => {
  // `0`/`o`, `1`/`l`/`i` são os pares que quebram o ditado por telefone; o `u`
  // sai junto e leva a palavra feia mais comum.
  for (const banido of ['i', 'l', 'o', 'u']) {
    assert.ok(!ROOM_SLUG_ALPHABET.includes(banido), `alfabeto contém ${banido}`);
  }
  const amostra = Array.from({ length: 300 }, generateRoomSlug).join('');
  assert.match(amostra, /^[0-9abcdefghjkmnpqrstvwxyz]+$/);
});

test('o sorteio cobre os 32 símbolos — sem viés de módulo', () => {
  // 256 é múltiplo de 32, então `byte % 32` é uniforme. Se alguém trocar o
  // alfabeto por um tamanho que não seja potência de 2, símbolos somem daqui.
  const vistos = new Set();
  for (let i = 0; i < 4000; i += 1) for (const c of generateRoomSlug()) vistos.add(c);
  assert.equal(vistos.size, 32, `só apareceram ${vistos.size} símbolos`);
});

test('duas criações consecutivas não colidem', () => {
  const slugs = new Set(Array.from({ length: 1000 }, generateRoomSlug));
  assert.equal(slugs.size, 1000);
});

test('a passphrase tem 128 bits e vive fora do path', () => {
  const chave = generatePassphrase();
  assert.equal(chave.length, 22); // 16 bytes em base64url, sem padding
  assert.match(chave, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(chave, generatePassphrase());
});

test('endereço escrito por gente vira slug: maiúscula, acento e pontuação', () => {
  assert.equal(normalizeRoomPath('Sala do Nícolas!'), 'sala-do-nicolas');
  assert.equal(normalizeRoomPath('DAILY'), 'daily');
  assert.equal(normalizeRoomPath('Reunião de Segunda'), 'reuniao-de-segunda');
  assert.equal(normalizeRoomPath('café_com_código'), 'cafe-com-codigo');
});

test('espaços e underscore viram hífen, repetidos colapsam, pontas caem', () => {
  assert.equal(normalizeRoomPath('  uma   sala   '), 'uma-sala');
  assert.equal(normalizeRoomPath('a__b'), 'a-b');
  assert.equal(normalizeRoomPath('a---b'), 'a-b');
  assert.equal(normalizeRoomPath('---daily---'), 'daily');
});

test('ponto e barra somem — nginx e roteador dependem disso', () => {
  // `/minha.sala.js` casaria o bloco de cache do nginx (sem `try_files`) e
  // devolveria 404; `/a/b` viraria multi-segmento e o namespace de rotas.
  assert.equal(normalizeRoomPath('minha.sala.js'), 'minha-sala-js');
  assert.equal(normalizeRoomPath('/daily/'), 'daily');
  assert.equal(normalizeRoomPath('time/daily'), 'time-daily');
});

test('entrada sem nada aproveitável devolve string vazia, nunca lança', () => {
  assert.equal(normalizeRoomPath('!!!'), '');
  assert.equal(normalizeRoomPath('   '), '');
  assert.equal(normalizeRoomPath(''), '');
  assert.equal(normalizeRoomPath(null), '');
  assert.equal(normalizeRoomPath(undefined), '');
  assert.equal(normalizeRoomPath(42), '');
});

test('normalizar é idempotente', () => {
  for (const entrada of ['Sala do Nícolas!', '--a__b--', 'time/daily', 'ÁÉÍÓÚ']) {
    const uma = normalizeRoomPath(entrada);
    assert.equal(normalizeRoomPath(uma), uma, `não idempotente para "${entrada}"`);
  }
});

test('endereço acima do teto é recusado, nunca truncado', () => {
  // Truncar silenciosamente colocaria a pessoa numa sala **diferente** da que
  // ela pediu, e o link que ela dita para o time apontaria para outro lugar.
  const longo = 'a'.repeat(MAX_ROOM_PATH_LENGTH + 40);
  assert.equal(normalizeRoomPath(longo).length, MAX_ROOM_PATH_LENGTH + 40, 'não pode cortar');
  assert.ok(!isValidRoomPath(normalizeRoomPath(longo)), 'quem recusa é a validação');
  assert.ok(isValidRoomPath(normalizeRoomPath('a'.repeat(MAX_ROOM_PATH_LENGTH))));
});

test('a normalização de digitação segura o hífen da ponta, mas só ela', () => {
  // Sem isso o espaço apagaria a si mesmo a cada tecla e "uma sala" sairia
  // "umasala".
  assert.equal(normalizeRoomPathInput('uma '), 'uma-');
  assert.equal(normalizeRoomPathInput('uma sala'), 'uma-sala');
  assert.equal(normalizeRoomPathInput('uma_'), 'uma-');
  assert.equal(normalizeRoomPathInput('uma'), 'uma');
  assert.equal(normalizeRoomPathInput('!!!'), '');
  // O valor que vira endereço de verdade passa por `normalizeRoomPath`, que
  // apara a ponta.
  assert.equal(normalizeRoomPath(normalizeRoomPathInput('uma ')), 'uma');
});

test('o charset final é o do contrato', () => {
  assert.equal(String(ROOM_PATH_PATTERN), String(/^[a-z0-9][a-z0-9-]{0,63}$/));
  assert.ok(isValidRoomPath('daily'));
  assert.ok(isValidRoomPath('uma-sala-so-minha'));
  assert.ok(isValidRoomPath('7'));
  assert.ok(isValidRoomPath('a'.repeat(64)));

  assert.ok(!isValidRoomPath(''));
  assert.ok(!isValidRoomPath('-comeca-com-hifen'));
  assert.ok(!isValidRoomPath('Maiúscula'));
  assert.ok(!isValidRoomPath('com espaço'));
  assert.ok(!isValidRoomPath('com/barra'));
  assert.ok(!isValidRoomPath('com.ponto'));
  assert.ok(!isValidRoomPath('a'.repeat(65)));
  assert.ok(!isValidRoomPath(null));
});

test('todo slug gerado passa na validação de path', () => {
  for (let i = 0; i < 200; i += 1) {
    const slug = generateRoomSlug();
    assert.ok(isValidRoomPath(slug), `slug inválido: ${slug}`);
    assert.equal(normalizeRoomPath(slug), slug, 'slug gerado não pode mudar ao normalizar');
  }
});

test('o link de convite carrega a chave no fragmento', () => {
  assert.equal(buildRoomUrl('https://meet.exemplo.com', 'daily', 'k7'), 'https://meet.exemplo.com/daily#k7');
});
