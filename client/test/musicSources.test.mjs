/**
 * Parsing das origens de faixa. O que entra aqui vem de um campo de texto (ou de
 * outro navegador, pelo data channel), então o teste que importa é o das
 * entradas erradas — link de playlist sem vídeo, `javascript:`, id truncado.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MAX_SOURCE_REF,
  formatDuration,
  looksLikeAudioUrl,
  parseFileSource,
  parseSource,
  parseYouTubeId,
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

test('formatDuration cobre m:ss, h:mm:ss e desconhecido', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(125), '2:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(-1), '--:--');
});
