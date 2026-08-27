/**
 * Dublê da Cloudflare TURN API para os testes que sobem o `index.ts` de
 * verdade.
 *
 * Carregado com `node --import`, antes de qualquer módulo da aplicação:
 * substitui `globalThis.fetch` e devolve o que `STUB_CF` mandar. É o que
 * permite exercitar o mapeamento 200/503/502 do endpoint **sem** tocar no
 * código de produção com um seam de teste e **sem** chamar um terceiro de
 * dentro da suíte.
 *
 * Só intercepta a URL da Cloudflare; qualquer outro `fetch` segue para o
 * original.
 */
const CF_HOST = 'rtc.live.cloudflare.com';
const original = globalThis.fetch;
const mode = process.env.STUB_CF || 'ok';

/**
 * O cast do `fetch`: o dublê devolve `ok`, `status` e `json()`, que é tudo o
 * que `turnCredentials` lê da resposta — montar uma `Response` inteira só para
 * satisfazer o tipo não provaria nada a mais.
 */
globalThis.fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
  if (!String(url).includes(CF_HOST)) return original(url, options);

  if (mode === 'error') {
    return { ok: false, status: 502, json: async () => ({}) };
  }

  if (mode === 'throw') {
    throw new TypeError('fetch failed');
  }

  if (mode === 'hang') {
    // Aceita a conexão e nunca responde: é o caso que o timeout existe para
    // cortar. Rejeita ao ver o abort, como faz o `fetch` real.
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }

  if (mode === 'empty') {
    return { ok: true, status: 200, json: async () => ({ iceServers: [] }) };
  }

  // Ecoa o `ttl` pedido, para o teste conferir o que de fato foi enviado.
  // O corpo que o servidor envia é sempre uma string JSON; o tipo do `fetch`
  // admite mais coisas.
  const ttl = JSON.parse(typeof options.body === 'string' ? options.body : '{}').ttl;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      iceServers: [
        {
          urls: ['turn:turn.example:3478?transport=udp'],
          username: `u-${ttl}`,
          credential: 'segredo-de-turn',
        },
      ],
    }),
  };
}) as unknown as typeof fetch;
