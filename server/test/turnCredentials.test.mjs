/**
 * O caminho da credencial de TURN, das duas pontas do servidor.
 *
 * O que está sob teste não é "a Cloudflare responde": é a **distinção entre os
 * três desfechos**. O endpoint respondia `200 {"iceServers": []}` para credencial
 * obtida, credencial não configurada e erro de upstream — os três iguais. Como o
 * client roda `iceTransportPolicy: 'relay'`, lista vazia significa zero
 * candidato e nenhuma conexão; anunciá-la com 200 fazia um deploy sem variáveis
 * de ambiente parecer uma sala saudável para todo mundo no caminho.
 *
 * Metade dos testes é unitária (TTL, timeout, redação de segredo) e metade sobe
 * o `index.js` de verdade num processo filho, com a Cloudflare dublada por
 * `--import`: o mapeamento status↔desfecho e o aviso de boot só existem lá, e
 * testá-los por dentro exigiria abrir um seam no código de produção.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL,
  MAX_TTL,
  MIN_TTL,
  fetchCloudflareIceServers,
  isTurnConfigured,
  resolveTimeoutMs,
  resolveTurnTtl,
} from '../src/turnCredentials.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');

function collectWarnings() {
  const lines = [];
  return { warn: (...args) => lines.push(args.join(' ')), lines };
}

// --------------------------------------------------------------- TTL (A6)

test('CF_TURN_TTL ausente ou vazio cai no default de 1h, sem aviso', () => {
  for (const env of [{}, { CF_TURN_TTL: '' }, { CF_TURN_TTL: '   ' }]) {
    const { warn, lines } = collectWarnings();
    assert.equal(resolveTurnTtl(env, warn), DEFAULT_TTL);
    assert.equal(DEFAULT_TTL, 3600);
    assert.deepEqual(lines, [], 'o default documentado não é motivo de aviso');
  }
});

test('CF_TURN_TTL inválido cai no default COM aviso', () => {
  for (const raw of ['0', '-1', 'abc', 'NaN', 'Infinity']) {
    const { warn, lines } = collectWarnings();
    assert.equal(resolveTurnTtl({ CF_TURN_TTL: raw }, warn), DEFAULT_TTL, `raw=${raw}`);
    assert.equal(lines.length, 1, `raw=${raw} precisa avisar`);
    assert.match(lines[0], /inválido/);
  }
});

test('CF_TURN_TTL sofre clamp nas duas pontas, com aviso', () => {
  const baixo = collectWarnings();
  assert.equal(resolveTurnTtl({ CF_TURN_TTL: '100' }, baixo.warn), MIN_TTL);
  assert.equal(MIN_TTL, 600);
  assert.match(baixo.lines[0], /abaixo do mínimo/);

  const alto = collectWarnings();
  assert.equal(resolveTurnTtl({ CF_TURN_TTL: '999999' }, alto.warn), MAX_TTL);
  assert.equal(MAX_TTL, 86400);
  assert.match(alto.lines[0], /acima do máximo/);
});

test('CF_TURN_TTL válido passa inteiro, sem aviso', () => {
  const { warn, lines } = collectWarnings();
  assert.equal(resolveTurnTtl({ CF_TURN_TTL: '900' }, warn), 900);
  assert.deepEqual(lines, []);
});

test('CF_TURN_TIMEOUT_MS: default 5000, inválido avisa e cai no default', () => {
  assert.equal(resolveTimeoutMs({}, () => {}), DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 5000);
  assert.equal(resolveTimeoutMs({ CF_TURN_TIMEOUT_MS: '250' }, () => {}), 250);

  const { warn, lines } = collectWarnings();
  assert.equal(resolveTimeoutMs({ CF_TURN_TIMEOUT_MS: 'x' }, warn), DEFAULT_TIMEOUT_MS);
  assert.equal(lines.length, 1);
});

// ------------------------------------------------- fetchCloudflareIceServers

test('sem as variáveis de ambiente devolve null — e não lança nem chama a rede', async () => {
  let chamou = false;
  const fetchImpl = async () => {
    chamou = true;
  };
  assert.equal(await fetchCloudflareIceServers({ env: {}, fetchImpl }), null);
  assert.equal(await fetchCloudflareIceServers({ env: { CF_TURN_TOKEN_ID: 'a' }, fetchImpl }), null);
  assert.equal(await fetchCloudflareIceServers({ env: { CF_TURN_API_TOKEN: 'b' }, fetchImpl }), null);
  assert.equal(chamou, false, 'sem credencial não há motivo para falar com a Cloudflare');
});

test('sucesso devolve { iceServers, ttl, expiresAt } coerentes entre si (A1)', async () => {
  const env = { CF_TURN_TOKEN_ID: 'tok-id', CF_TURN_API_TOKEN: 'tok-secret', CF_TURN_TTL: '900' };
  let corpoEnviado = null;
  const fetchImpl = async (_url, options) => {
    corpoEnviado = JSON.parse(options.body);
    return { ok: true, json: async () => ({ iceServers: [{ urls: ['turn:x:3478'] }] }) };
  };

  const antes = Date.now();
  const out = await fetchCloudflareIceServers({ env, fetchImpl });
  const depois = Date.now();

  assert.equal(corpoEnviado.ttl, 900, 'o TTL resolvido é o que vai para a Cloudflare');
  assert.equal(out.ttl, 900);
  assert.deepEqual(out.iceServers, [{ urls: ['turn:x:3478'] }]);

  const expira = Date.parse(out.expiresAt);
  assert.ok(Number.isFinite(expira), 'expiresAt é ISO-8601 parseável');
  assert.ok(expira >= antes + 900_000 && expira <= depois + 900_000, 'expiresAt = agora + ttl');
});

test('CF_TURN_TTL ausente manda 3600 para a Cloudflare (A6)', async () => {
  let ttlEnviado = null;
  await fetchCloudflareIceServers({
    env: { CF_TURN_TOKEN_ID: 'a', CF_TURN_API_TOKEN: 'b' },
    fetchImpl: async (_url, options) => {
      ttlEnviado = JSON.parse(options.body).ttl;
      return { ok: true, json: async () => ({ iceServers: [{ urls: 'turn:x' }] }) };
    },
  });
  assert.equal(ttlEnviado, 3600);
});

test('resposta não-OK, corpo ilegível e lista vazia lançam (viram 502)', async () => {
  const env = { CF_TURN_TOKEN_ID: 'a', CF_TURN_API_TOKEN: 'b' };

  await assert.rejects(
    fetchCloudflareIceServers({ env, fetchImpl: async () => ({ ok: false, status: 401 }) }),
    /401/,
  );

  await assert.rejects(
    fetchCloudflareIceServers({
      env,
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new Error('Unexpected token');
        },
      }),
    }),
    /ilegível/,
  );

  // Lista vazia é erro de upstream, não sucesso magro: sob `relay` ela não
  // conecta ninguém, e devolvê-la com 200 recriaria o bug.
  await assert.rejects(
    fetchCloudflareIceServers({
      env,
      fetchImpl: async () => ({ ok: true, json: async () => ({ iceServers: [] }) }),
    }),
    /vazio/,
  );
});

test('upstream que não responde é cortado pelo timeout, em tempo limitado (A3)', async () => {
  const env = {
    CF_TURN_TOKEN_ID: 'a',
    CF_TURN_API_TOKEN: 'b',
    CF_TURN_TIMEOUT_MS: '60',
  };
  const fetchImpl = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  const inicio = Date.now();
  await assert.rejects(fetchCloudflareIceServers({ env, fetchImpl }), /timeout após 60ms/);
  assert.ok(Date.now() - inicio < 3000, 'a requisição não fica pendurada');
});

test('nenhuma mensagem de erro carrega o valor de um segredo (A4)', async () => {
  const env = {
    CF_TURN_TOKEN_ID: 'ID-SUPER-SECRETO',
    CF_TURN_API_TOKEN: 'TOKEN-SUPER-SECRETO',
  };
  // O `fetch` real inclui a URL na causa do erro, e a URL carrega o tokenId.
  const fetchImpl = async (url) => {
    throw new TypeError(`request to ${url} failed (bearer TOKEN-SUPER-SECRETO)`);
  };

  const err = await fetchCloudflareIceServers({ env, fetchImpl }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.doesNotMatch(err.message, /ID-SUPER-SECRETO/);
  assert.doesNotMatch(err.message, /TOKEN-SUPER-SECRETO/);
  assert.match(err.message, /\*\*\*/);
});

test('isTurnConfigured lê presença, nunca valor', () => {
  assert.equal(isTurnConfigured({}), false);
  assert.equal(isTurnConfigured({ CF_TURN_TOKEN_ID: 'a' }), false);
  assert.equal(isTurnConfigured({ CF_TURN_TOKEN_ID: 'a', CF_TURN_API_TOKEN: '' }), false);
  assert.equal(isTurnConfigured({ CF_TURN_TOKEN_ID: 'a', CF_TURN_API_TOKEN: 'b' }), true);
});

// ------------------------------------------------------- o endpoint, de fato

/**
 * Sobe o `index.js` real num processo filho, com a Cloudflare dublada, e devolve
 * a base URL mais tudo o que ele imprimiu.
 */
async function startServer({ env = {}, stub = 'ok' } = {}) {
  const port = 21000 + Math.floor(Math.random() * 9000);
  const child = spawn(
    process.execPath,
    ['--import', './test/fixtures/stubCloudflare.mjs', 'src/index.js'],
    {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        // O `.env` do desenvolvedor não pode decidir o resultado do teste.
        CF_TURN_TOKEN_ID: '',
        CF_TURN_API_TOKEN: '',
        CF_TURN_TTL: '',
        CF_TURN_TIMEOUT_MS: '',
        DOTENV_CONFIG_QUIET: 'true',
        PORT: String(port),
        STUB_CF: stub,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let saida = '';
  child.stdout.on('data', (chunk) => {
    saida += chunk;
  });
  child.stderr.on('data', (chunk) => {
    saida += chunk;
  });

  const base = `http://127.0.0.1:${port}`;
  const limite = Date.now() + 10_000;
  for (;;) {
    if (Date.now() > limite) {
      child.kill('SIGKILL');
      throw new Error(`servidor não subiu em 10s:\n${saida}`);
    }
    try {
      await fetch(`${base}/health`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return {
    base,
    saida: () => saida,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      }),
  };
}

test('sem as variáveis: 503 turn-unconfigured, e nunca 200 com lista vazia (A2)', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const res = await fetch(`${server.base}/turn-credentials`);
  assert.equal(res.status, 503);

  const body = await res.json();
  assert.equal(body.error, 'turn-unconfigured');
  assert.equal(body.iceServers, undefined, 'não devolve lista nenhuma');
  assert.ok(body.message);
});

test('com as variáveis e a Cloudflare boa: 200 com ttl e expiresAt (A1)', async (t) => {
  const server = await startServer({
    env: { CF_TURN_TOKEN_ID: 'id', CF_TURN_API_TOKEN: 'secret', CF_TURN_TTL: '1200' },
  });
  t.after(() => server.stop());

  const res = await fetch(`${server.base}/turn-credentials`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ttl, 1200);
  assert.ok(Array.isArray(body.iceServers) && body.iceServers.length > 0);
  assert.ok(Number.isFinite(Date.parse(body.expiresAt)));
});

test('Cloudflare não-OK, lançando, vazia ou muda: 502 turn-upstream (A3)', async (t) => {
  for (const stub of ['error', 'throw', 'empty']) {
    const server = await startServer({
      env: { CF_TURN_TOKEN_ID: 'id', CF_TURN_API_TOKEN: 'secret' },
      stub,
    });
    t.after(() => server.stop());

    const res = await fetch(`${server.base}/turn-credentials`);
    assert.equal(res.status, 502, `stub=${stub}`);
    assert.equal((await res.json()).error, 'turn-upstream', `stub=${stub}`);
  }

  const pendurado = await startServer({
    env: { CF_TURN_TOKEN_ID: 'id', CF_TURN_API_TOKEN: 'secret', CF_TURN_TIMEOUT_MS: '200' },
    stub: 'hang',
  });
  t.after(() => pendurado.stop());

  const inicio = Date.now();
  const res = await fetch(`${pendurado.base}/turn-credentials`);
  assert.equal(res.status, 502);
  assert.ok(Date.now() - inicio < 5000, 'a requisição termina em tempo limitado');
});

test('/health reporta turn.configured sem chamar a Cloudflare, e preserva ok (A5)', async (t) => {
  const semTurn = await startServer();
  t.after(() => semTurn.stop());
  assert.deepEqual(await (await fetch(`${semTurn.base}/health`)).json(), {
    ok: true,
    turn: { configured: false },
  });

  // `throw` no dublê: se o /health tocasse a Cloudflare, ele quebraria aqui.
  const comTurn = await startServer({
    env: { CF_TURN_TOKEN_ID: 'id', CF_TURN_API_TOKEN: 'secret' },
    stub: 'throw',
  });
  t.after(() => comTurn.stop());
  assert.deepEqual(await (await fetch(`${comTurn.base}/health`)).json(), {
    ok: true,
    turn: { configured: true },
  });
});

test('o boot avisa quando falta TURN, e cala quando não falta (A7)', async (t) => {
  const semTurn = await startServer();
  t.after(() => semTurn.stop());
  const avisos = semTurn.saida().split('\n').filter((l) => l.includes('CF_TURN_TOKEN_ID'));
  assert.equal(avisos.length, 1, 'um aviso, não zero e não uma enxurrada');
  assert.match(avisos[0], /relay/, 'o aviso explica por que ninguém vai conectar');

  const comTurn = await startServer({
    env: { CF_TURN_TOKEN_ID: 'id', CF_TURN_API_TOKEN: 'secret' },
  });
  t.after(() => comTurn.stop());
  assert.doesNotMatch(comTurn.saida(), /ATENÇÃO/);
});

test('nem o segredo nem o token id aparecem na saída do servidor (A4)', async (t) => {
  const server = await startServer({
    env: { CF_TURN_TOKEN_ID: 'ID-SECRETO-XYZ', CF_TURN_API_TOKEN: 'TOKEN-SECRETO-XYZ' },
    stub: 'throw',
  });
  t.after(() => server.stop());

  const res = await fetch(`${server.base}/turn-credentials`);
  const texto = await res.text();

  assert.doesNotMatch(texto, /SECRETO-XYZ/, 'a resposta não vaza segredo');
  assert.doesNotMatch(server.saida(), /SECRETO-XYZ/, 'o log não vaza segredo');
});
