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
  resolveSourceTitle,
  titleFromFileName,
  titleFromUrl,
} = await import('../src/lib/musicSources.js');

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
  assert.equal(parseSource('   ').reason, 'empty');
  assert.equal(parseSource('nem link nem nada').reason, 'unsupported');
  assert.equal(parseSource(`https://x.example/${'a'.repeat(MAX_SOURCE_REF)}`).reason, 'too-long');
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
test('resolveSourceTitle troca o fallback pelo título real do vídeo', async () => {
  const parsed = parseSource('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(parsed.title, 'YouTube · dQw4w9WgXcQ', 'sem rede, é só isto que dá para saber');

  const pedidos = [];
  const title = await resolveSourceTitle(parsed, {
    fetchTitle: async (videoId) => {
      pedidos.push(videoId);
      return 'Rick Astley - Never Gonna Give You Up';
    },
  });

  assert.equal(title, 'Rick Astley - Never Gonna Give You Up');
  assert.deepEqual(pedidos, ['dQw4w9WgXcQ'], 'o buscador recebe o id, não a URL colada');
});

test('resolveSourceTitle mantém o fallback quando o título não vem', async () => {
  const parsed = parseSource('https://youtu.be/dQw4w9WgXcQ');
  const fallback = 'YouTube · dQw4w9WgXcQ';

  const casos = {
    'buscador devolve null (rede caída, CORS, timeout)': async () => null,
    'buscador estoura': async () => {
      throw new Error('Failed to fetch');
    },
    'título vazio': async () => '   ',
    'título que não é texto': async () => ({ title: 'objeto' }),
    'buscador ausente': undefined,
  };

  for (const [label, fetchTitle] of Object.entries(casos)) {
    assert.equal(await resolveSourceTitle(parsed, { fetchTitle }), fallback, label);
  }
  assert.equal(await resolveSourceTitle(parsed), fallback, 'sem opções nenhuma');
});

test('resolveSourceTitle recorta título longo demais e o resultado ainda é uma entrada válida', async () => {
  const parsed = parseSource('https://youtu.be/dQw4w9WgXcQ');
  const enorme = `${'ção '.repeat(200)}fim`;

  const title = await resolveSourceTitle(parsed, { fetchTitle: async () => enorme });

  assert.equal(title.length, MAX_TITLE, 'o teto é o mesmo do resto do módulo');
  // O que interessa é o efeito: o título recortado sobrevive ao `sanitizeEntry`
  // do outro lado do canal, senão a faixa nem entraria na fila de quem recebe.
  const { sanitizeEntry } = await import('../src/lib/musicSession.js');
  const entry = sanitizeEntry(
    { id: 'e1', kind: 'youtube', sourceRef: parsed.sourceRef, title, addedByName: 'Ana', lamport: 1 },
    { addedBy: 'peer-a' },
  );
  assert.ok(entry, 'título recortado não pode invalidar a entrada');
  // O corte pode cair num espaço, e aí o `trim()` do `sanitizeEntry` devolve um
  // caractere a menos — o que importa é o teto valer dos dois lados do canal.
  assert.ok(entry.title.length <= MAX_TITLE);
  assert.equal(entry.title, title.trim());
});

test('resolveSourceTitle não busca nada para arquivo, URL ou origem recusada', async () => {
  const nunca = () => assert.fail('só YouTube tem título a descobrir fora da máquina');

  assert.equal(
    await resolveSourceTitle(parseSource('https://cdn.example.com/musica-boa.mp3'), { fetchTitle: nunca }),
    'musica-boa',
  );
  assert.equal(
    await resolveSourceTitle(parseFileSource({ name: 'demo.mp3', type: 'audio/mpeg' }), { fetchTitle: nunca }),
    'demo',
  );
  assert.equal(await resolveSourceTitle(parseSource('bagunça'), { fetchTitle: nunca }), 'Faixa');
  assert.equal(await resolveSourceTitle(null, { fetchTitle: nunca }), 'Faixa');
});

test('formatDuration cobre m:ss, h:mm:ss e desconhecido', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(125), '2:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(-1), '--:--');
});
