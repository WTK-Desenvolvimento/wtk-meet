/**
 * Parsing das origens de faixa. O que entra aqui vem de um campo de texto (ou de
 * outro navegador, pelo data channel), então o teste que importa é o das
 * entradas erradas — link de playlist sem vídeo, `javascript:`, id truncado.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MAX_SOURCE_REF,
  MAX_TITLE,
  formatDuration,
  looksLikeAudioUrl,
  parseFileSource,
  parseSource,
  parseYouTubeId,
  REFUSAL_BY_AVAILABILITY,
  resolveSourceMeta,
  SOURCE_ERRORS,
  titleFromFileName,
  titleFromUrl,
} = await import('../src/lib/musicSources.js');

import type {
  ParsedSource,
  ParsedSourceFail,
  ParsedSourceOk,
} from '../src/lib/musicSources.js';

/**
 * Estreitamento sem cast: cada caso sabe qual ramo do resultado está
 * exercitando, e o `throw` aqui é a mesma reprovação que a asserção daria — só
 * que dizendo qual ramo veio no lugar.
 */
function aceita(r: ParsedSource): ParsedSourceOk {
  if (!r.ok) throw new Error(`esperava origem aceita, veio recusa: ${r.reason}`);
  return r;
}

function recusa(r: ParsedSource): ParsedSourceFail {
  if (r.ok) throw new Error(`esperava recusa, veio origem aceita: ${r.title}`);
  return r;
}

test('parseYouTubeId aceita as formas de link que o YouTube usa hoje', () => {
  const id = 'dQw4w9WgXcQ';
  for (const input of [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PL123&index=2`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?t=42`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `  https://www.youtube.com/watch?v=${id}  `,
  ]) {
    assert.equal(parseYouTubeId(input), id, `deveria extrair o id de ${input}`);
  }
});

test('parseYouTubeId recusa o que não é um vídeo', () => {
  for (const input of [
    null,
    42,
    '',
    'dQw4w9WgXc', // 10 chars
    'dQw4w9WgXcQQ', // 12 chars
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@canal',
    'https://vimeo.com/12345678901',
    'javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ',
    'https://evil.example/watch?v=dQw4w9WgXcQ',
  ]) {
    assert.equal(parseYouTubeId(input), null, `deveria recusar ${input}`);
  }
});

test('parseSource classifica YouTube, URL direta e lixo', () => {
  const yt = parseSource('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(yt.ok, true);
  assert.equal(yt.kind, 'youtube');
  assert.equal(yt.sourceRef, 'dQw4w9WgXcQ');

  const url = parseSource('https://cdn.example.com/musica/faixa%20boa.mp3');
  assert.equal(url.ok, true);
  assert.equal(url.kind, 'url');
  assert.equal(url.title, 'faixa boa');
  assert.equal(url.warning, null);

  const sem = parseSource('https://stream.example.com/radio');
  assert.equal(sem.ok, true);
  assert.equal(sem.warning, 'unknown-extension');
});

test('parseSource recusa esquema que não seja http(s)', () => {
  for (const bad of ['javascript:alert(1)', 'data:audio/mp3;base64,AAAA', 'file:///etc/passwd']) {
    const result = parseSource(bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported-scheme', `esquema de ${bad}`);
  }
  assert.equal(recusa(parseSource('   ')).reason, 'empty');
  assert.equal(recusa(parseSource('nem link nem nada')).reason, 'unsupported');
  assert.equal(recusa(parseSource(`https://x.example/${'a'.repeat(MAX_SOURCE_REF)}`)).reason, 'too-long');
});

test('parseSource respeita a flag que desliga a origem YouTube', () => {
  const result = parseSource('https://youtu.be/dQw4w9WgXcQ', { allowYouTube: false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'youtube-disabled');
});

test('parseFileSource aceita áudio e recusa o resto', () => {
  const ok = parseFileSource({ name: 'minha_musica.mp3', type: 'audio/mpeg' });
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, 'file');
  assert.equal(ok.title, 'minha musica');
  // O arquivo nunca sai da máquina de quem adicionou: não há referência a
  // transportar, então `sourceRef` é vazio por contrato.
  assert.equal(ok.sourceRef, '');

  assert.equal(parseFileSource({ name: 'planilha.xlsx', type: 'application/vnd.ms-excel' }).ok, false);
  assert.equal(parseFileSource(null).ok, false);
  // Sem `type` (alguns sistemas não preenchem), aceita e deixa o decoder decidir.
  assert.equal(parseFileSource({ name: 'sem-tipo.ogg', type: '' }).ok, true);
});

test('looksLikeAudioUrl reconhece as extensões de áudio', () => {
  assert.equal(looksLikeAudioUrl('https://x.example/a.mp3'), true);
  assert.equal(looksLikeAudioUrl('https://x.example/a.ogg?token=1'), true);
  assert.equal(looksLikeAudioUrl('https://x.example/a.html'), false);
  assert.equal(looksLikeAudioUrl('bagunça'), false);
});

test('títulos são derivados sem baixar nada e ficam limitados', () => {
  assert.equal(titleFromUrl('https://x.example/'), 'x.example');
  assert.equal(titleFromFileName(`${'z'.repeat(300)}.mp3`).length, 120);
  assert.equal(titleFromFileName(''), 'Arquivo local');
});

/**
 * O título de verdade do vídeo, sem que este módulo deixe de ser puro.
 *
 * `parseSource` continua síncrono e sem rede — ele valida entrada hostil vinda
 * do data channel, e é por isso que vive em `node:test`. Quem sabe o nome do
 * vídeo é a Google, então o buscador entra **por injeção**: a chamada de rede
 * mora em `youtubePlayer.js`, o arquivo onde a dependência do terceiro está
 * confinada e que a `VITE_ENABLE_YOUTUBE` desliga inteiro.
 *
 * A regra que atravessa os casos abaixo: **enfileirar não pode depender de um
 * nome bonito**. Qualquer coisa que dê errado mantém o `YouTube · <id>` que o
 * `parseSource` já devolveu.
 */
test('resolveSourceMeta troca o fallback pelo título real do vídeo', async () => {
  const parsed = parseSource('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(aceita(parsed).title, 'YouTube · dQw4w9WgXcQ', 'sem rede, é só isto que dá para saber');

  const pedidos: string[] = [];
  const meta = await resolveSourceMeta(parsed, {
    fetchMeta: async (videoId: string) => {
      pedidos.push(videoId);
      return { title: 'Rick Astley - Never Gonna Give You Up', availability: 'ok', status: 200 };
    },
  });

  assert.deepEqual(meta, { title: 'Rick Astley - Never Gonna Give You Up', availability: 'ok' });
  assert.deepEqual(pedidos, ['dQw4w9WgXcQ'], 'o buscador recebe o id, não a URL colada');
});

test('resolveSourceMeta mantém o fallback quando o título não vem', async () => {
  const parsed = parseSource('https://youtu.be/dQw4w9WgXcQ');
  const fallback = 'YouTube · dQw4w9WgXcQ';

  const casos = {
    'buscador devolve null (rede caída, CORS, timeout)': async () => null,
    'sem título, veredito desconhecido': async () => ({ title: null, availability: 'unknown' }),
    'buscador estoura': async () => {
      throw new Error('Failed to fetch');
    },
    'título vazio': async () => ({ title: '   ', availability: 'ok' }),
    'título que não é texto': async () => ({ title: 42, availability: 'ok' }),
    'buscador ausente': undefined,
  };

  for (const [label, fetchMeta] of Object.entries(casos)) {
    assert.equal((await resolveSourceMeta(parsed, { fetchMeta })).title, fallback, label);
  }
  assert.equal((await resolveSourceMeta(parsed)).title, fallback, 'sem opções nenhuma');
});

/**
 * O veredito é **transportado, nunca inventado**. Quem sabe se o vídeo toca é o
 * status HTTP do oEmbed, lá em `youtubePlayer.js`; aqui a única regra é não
 * deixar passar um valor que não seja um dos quatro combinados — o que chega
 * pelo buscador é, em última instância, resposta de terceiro.
 */
test('resolveSourceMeta propaga o veredito e cai em unknown para tudo que não é um deles', async () => {
  const parsed = parseSource('https://youtu.be/dQw4w9WgXcQ');
  const meta = // `unknown`: metade dos casos abaixo alimenta lixo de propósito — é o que prova o fallback.
  (availability: unknown) => resolveSourceMeta(parsed, { fetchMeta: async () => ({ title: 'x', availability }) });

  for (const veredito of ['ok', 'embed-blocked', 'not-found', 'unknown']) {
    assert.equal((await meta(veredito)).availability, veredito, veredito);
  }
  for (const lixo of [undefined, null, '', 'OK', 'blocked', 404, {}]) {
    assert.equal((await meta(lixo)).availability, 'unknown', JSON.stringify(lixo));
  }
  assert.equal(
    (await resolveSourceMeta(parsed, {
      fetchMeta: async () => {
        throw new Error('Failed to fetch');
      },
    })).availability,
    'unknown',
    'buscador que estoura não prova nada sobre o vídeo',
  );
});

/**
 * Risco 7.2 do documento: título e veredito são independentes. Um 200 sem título
 * legível é vídeo **tocável** sem nome bonito — derivar "sem título, logo
 * indisponível" reintroduziria, do outro lado, o colapso de informação que esta
 * task existe para desfazer.
 */
test('resolveSourceMeta não confunde "sem título" com "indisponível"', async () => {
  const parsed = parseSource('https://youtu.be/dQw4w9WgXcQ');

  const meta = await resolveSourceMeta(parsed, { fetchMeta: async () => ({ title: null, availability: 'ok' }) });

  assert.deepEqual(meta, { title: 'YouTube · dQw4w9WgXcQ', availability: 'ok' });
  assert.equal(REFUSAL_BY_AVAILABILITY[meta.availability], undefined, 'e isto não recusa nada');
});

test('resolveSourceMeta recorta título longo demais e o resultado ainda é uma entrada válida', async () => {
  const parsed = parseSource('https://youtu.be/dQw4w9WgXcQ');
  const enorme = `${'ção '.repeat(200)}fim`;

  const { title } = await resolveSourceMeta(parsed, { fetchMeta: async () => ({ title: enorme, availability: 'ok' }) });

  assert.equal(title.length, MAX_TITLE, 'o teto é o mesmo do resto do módulo');
  // O que interessa é o efeito: o título recortado sobrevive ao `sanitizeEntry`
  // do outro lado do canal, senão a faixa nem entraria na fila de quem recebe.
  const { sanitizeEntry } = await import('../src/lib/musicSession.js');
  const entry = sanitizeEntry(
    { id: 'e1', kind: 'youtube', sourceRef: aceita(parsed).sourceRef, title, addedByName: 'Ana', lamport: 1 },
    { addedBy: 'peer-a' },
  );
  assert.ok(entry, 'título recortado não pode invalidar a entrada');
  // O corte pode cair num espaço, e aí o `trim()` do `sanitizeEntry` devolve um
  // caractere a menos — o que importa é o teto valer dos dois lados do canal.
  assert.ok(entry.title.length <= MAX_TITLE);
  assert.equal(entry.title, title.trim());
});

test('resolveSourceMeta não busca nada para arquivo, URL ou origem recusada', async () => {
  const nunca = () => assert.fail('só YouTube tem o que descobrir fora da máquina');

  const casos: [ParsedSource | null, string][] = [
    [parseSource('https://cdn.example.com/musica-boa.mp3'), 'musica-boa'],
    [parseFileSource({ name: 'demo.mp3', type: 'audio/mpeg' }), 'demo'],
    [parseSource('bagunça'), 'Faixa'],
    [null, 'Faixa'],
  ];

  for (const [parsed, title] of casos) {
    // `unknown` e não `ok`: o veredito nunca foi consultado, e afirmar
    // disponibilidade sem prova é tão errado quanto negá-la. O que importa é que
    // nenhum dos dois recusa.
    assert.deepEqual(await resolveSourceMeta(parsed, { fetchMeta: nunca }), { title, availability: 'unknown' });
  }
});

/**
 * A tabela que decide o que é recusável, e o motivo de ela morar aqui: as duas
 * saídas do usuário são diferentes — no vídeo removido há o que corrigir, no
 * bloqueado pelo dono não adianta insistir —, então as mensagens são duas.
 */
test('só os dois vereditos de prova recusam, e cada um com sua mensagem', () => {
  assert.deepEqual(Object.keys(REFUSAL_BY_AVAILABILITY).sort(), ['embed-blocked', 'not-found']);
  assert.equal(REFUSAL_BY_AVAILABILITY.ok, undefined, 'vídeo tocável entra na fila');
  assert.equal(REFUSAL_BY_AVAILABILITY.unknown, undefined, 'fail-open: sem prova, entra na fila');

  const removido = SOURCE_ERRORS[REFUSAL_BY_AVAILABILITY['not-found']!];
  const bloqueado = SOURCE_ERRORS[REFUSAL_BY_AVAILABILITY['embed-blocked']!];
  assert.ok(removido && bloqueado, 'toda recusa tem texto em SOURCE_ERRORS');
  assert.notEqual(removido, bloqueado, 'a mesma mensagem para os dois casos devolveria a ambiguidade ao usuário');
  assert.match(bloqueado, /YouTube/, 'o caminho de saída é dizer onde o vídeo toca');
});

/**
 * A pureza deste módulo é a razão de ele existir separado: é ele que precisa
 * valer para entrada hostil vinda do data channel, e entrada hostil se testa em
 * `node:test`. Um `import` de `youtubePlayer.js` arrastaria a dependência do
 * terceiro para cá mesmo sem ninguém chamá-la.
 *
 * O teste lê o arquivo em vez de exercitá-lo porque a ausência de rede não é
 * observável por chamada: o `fetch` que não deve existir só apareceria em
 * produção. Comentários saem antes da varredura — o que está sob exame é o
 * código, e a prosa do arquivo fala de `fetchYouTubeOEmbed` de propósito.
 */
test('musicSources.js continua puro: sem rede, sem DOM, sem import de youtubePlayer.js', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/lib/musicSources.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  assert.equal(/\bimport\b/.test(code), false, 'o módulo não importa nada — nem estático, nem dinâmico');
  for (const proibido of [/\bfetch\b/, /XMLHttpRequest/, /\bdocument\b/, /\bwindow\b/, /navigator/, /localStorage/]) {
    assert.equal(proibido.test(code), false, String(proibido));
  }
});

test('formatDuration cobre m:ss, h:mm:ss e desconhecido', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(125), '2:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(-1), '--:--');
});
