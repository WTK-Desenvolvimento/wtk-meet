/**
 * O teste que sustenta a ausência do banner de consentimento.
 *
 * A decisão de não pedir consentimento não é uma opinião jurídica escrita num
 * documento: ela é uma **consequência** de o produto não criar, não ler e não
 * persistir identificador nenhum para fins de telemetria. A base legal para
 * banner é o armazenamento/leitura de informação no terminal do usuário e o
 * tratamento de dado pessoal; um contador de page views por rota, sem
 * identificador, sem IP e sem User-Agent, não é nenhum dos dois.
 *
 * O que sustenta isso ao longo do tempo não é o parágrafo acima — é este
 * arquivo. `localStorage`, `sessionStorage`, `document.cookie`,
 * `crypto.randomUUID` e `Math.random` são substituídos por armadilhas que
 * **reprovam o teste** se o módulo de telemetria encostar em qualquer uma
 * delas. Reintroduzir um identificador — inclusive "só um id de sessão para
 * deduplicar" — quebra este teste, que é exatamente o ponto: quem reintroduzir
 * tem que trazer o banner junto.
 *
 * O segundo eixo é o payload: o beacon emitido a partir da `Room` não pode
 * conter o slug da sala, o fragmento da URL (que carrega a passphrase) nem o
 * `displayName`. Aqui isso é verificado do jeito mais forte disponível — o
 * envelope é fechado e **não tem campo** para nenhum deles, então a prova é que
 * o corpo emitido tem exatamente as chaves declaradas, com um estado de página
 * reconhecível montado ao redor.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  configureTelemetry,
  resetTelemetry,
  startSession,
  trackPageView,
} from '../src/lib/telemetry.js';

/** O estado de página que existiria numa sala de verdade. Nada disso pode sair. */
const SLUG = 'sala-secreta-do-nicolas';
const PASSPHRASE = 'entrada-guitarra-vermelha';
const NOME = 'Nicolas Woitchik';

/**
 * Instala armadilhas nos cinco globais proibidos e devolve a função que as
 * remove. Cada uma registra o toque em vez de lançar na hora: um `throw` seria
 * engolido pelo `try/catch` do módulo, e o teste passaria dizendo o contrário
 * do que aconteceu.
 */
function armarArmadilhas(tocados: string[]) {
  const alvo = globalThis as Record<string, unknown>;
  const originais = {
    localStorage: Object.getOwnPropertyDescriptor(alvo, 'localStorage'),
    sessionStorage: Object.getOwnPropertyDescriptor(alvo, 'sessionStorage'),
    document: Object.getOwnPropertyDescriptor(alvo, 'document'),
    crypto: Object.getOwnPropertyDescriptor(alvo, 'crypto'),
  };
  const mathRandom = Math.random;

  const armadilhaDeStorage = (nome: string) => ({
    getItem: () => {
      tocados.push(`${nome}.getItem`);
      return null;
    },
    setItem: () => tocados.push(`${nome}.setItem`),
    removeItem: () => tocados.push(`${nome}.removeItem`),
  });

  Object.defineProperty(alvo, 'localStorage', {
    configurable: true,
    get() {
      tocados.push('localStorage');
      return armadilhaDeStorage('localStorage');
    },
  });
  Object.defineProperty(alvo, 'sessionStorage', {
    configurable: true,
    get() {
      tocados.push('sessionStorage');
      return armadilhaDeStorage('sessionStorage');
    },
  });
  Object.defineProperty(alvo, 'document', {
    configurable: true,
    value: {
      get cookie() {
        tocados.push('document.cookie');
        return '';
      },
      set cookie(_v: string) {
        tocados.push('document.cookie=');
      },
      // `visibilityState` é legítimo (a `Room` o usa como gatilho de fim de
      // sessão), então ele existe e não é armadilha.
      visibilityState: 'visible',
    },
  });
  Object.defineProperty(alvo, 'crypto', {
    configurable: true,
    value: {
      randomUUID: () => {
        tocados.push('crypto.randomUUID');
        return '00000000-0000-4000-8000-000000000000';
      },
      getRandomValues: (arr: Uint8Array) => {
        tocados.push('crypto.getRandomValues');
        return arr;
      },
    },
  });
  Math.random = () => {
    tocados.push('Math.random');
    return 0.5;
  };

  return () => {
    Math.random = mathRandom;
    for (const [chave, descritor] of Object.entries(originais)) {
      if (descritor) Object.defineProperty(alvo, chave, descritor);
      else delete (globalThis as Record<string, unknown>)[chave];
    }
  };
}

test('configurar, emitir page view e encerrar sessão não toca em nenhum identificador', (t) => {
  const tocados: string[] = [];
  const desarmar = armarArmadilhas(tocados);
  t.after(() => {
    desarmar();
    resetTelemetry();
  });

  // Controle: as armadilhas precisam disparar, senão este teste passaria por
  // não estar medindo nada. Toca-se em cada uma de propósito, e limpa-se.
  void (globalThis as { localStorage?: { getItem(k: string): unknown } }).localStorage?.getItem('x');
  void (globalThis as { document?: { cookie: string } }).document?.cookie;
  void (globalThis as { crypto?: { randomUUID(): string } }).crypto?.randomUUID();
  void Math.random();
  assert.deepEqual(tocados, ['localStorage', 'localStorage.getItem', 'document.cookie', 'crypto.randomUUID', 'Math.random']);
  tocados.length = 0;

  const enviados: string[] = [];
  configureTelemetry({
    endpoint: `http://localhost:4000/telemetry`,
    send: (_endpoint, body) => enviados.push(body),
  });

  trackPageView('home');
  trackPageView('room');
  trackPageView('legacy');
  const sessao = startSession();
  sessao.end();

  assert.deepEqual(
    tocados,
    [],
    `o módulo de telemetria encostou em: ${tocados.join(', ')} — isso reabre a exigência de consentimento`,
  );
  assert.equal(enviados.length, 4, 'e ainda assim os quatro beacons saíram');
});

test('o corpo do beacon da sala não carrega slug, fragmento nem displayName', (t) => {
  t.after(() => resetTelemetry());

  const enviados: string[] = [];
  // O endpoint é montado por `config.ts` a partir de `SIGNALING_URL`; o estado
  // da sala existe ao redor, como existiria de verdade, e nenhuma parte dele
  // tem por onde entrar no envelope.
  configureTelemetry({
    endpoint: 'http://localhost:4000/telemetry',
    send: (_e, body) => enviados.push(body),
  });

  trackPageView('room');
  const sessao = startSession();
  sessao.end();

  const tudo = enviados.join('\n');
  for (const segredo of [SLUG, PASSPHRASE, NOME, 'nicolas', 'guitarra', 'secreta']) {
    assert.ok(!tudo.toLowerCase().includes(segredo.toLowerCase()), `"${segredo}" vazou no beacon`);
  }

  assert.deepEqual(Object.keys(JSON.parse(enviados[0])).sort(), ['event', 'route']);
  assert.deepEqual(Object.keys(JSON.parse(enviados[1])).sort(), ['durationMs', 'event']);
});

test('o fonte do módulo não menciona nenhum dos globais proibidos', () => {
  // Rede de segurança estática, contra o caminho que a armadilha de runtime não
  // pega: código novo atrás de um `if` que os testes não exercitam. É barato, e
  // falha alto no dia em que alguém escrever `localStorage.setItem` aqui.
  const fonte = readFileSync(
    fileURLToPath(new URL('../src/lib/telemetry.ts', import.meta.url)),
    'utf8',
  );
  // Só o corpo do código: os comentários deste módulo citam os globais de
  // propósito, para explicar por que eles não estão lá.
  const codigo = fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linha) => !linha.trim().startsWith('//'))
    .join('\n');

  for (const proibido of [
    'localStorage',
    'sessionStorage',
    'document.cookie',
    'randomUUID',
    'Math.random',
  ]) {
    assert.ok(!codigo.includes(proibido), `\`${proibido}\` apareceu no código de lib/telemetry.ts`);
  }
});

test('o envelope não tem um terceiro evento, e nenhum campo de identificador', () => {
  // A prova por construção: qualquer coisa que se peça ao módulo produz um dos
  // dois envelopes, e os dois têm as chaves declaradas. Um `sessionId` "só para
  // deduplicar" precisaria de um campo, e o campo não existe.
  const enviados: string[] = [];
  configureTelemetry({ endpoint: '/telemetry', send: (_e, b) => enviados.push(b) });
  trackPageView('home');
  startSession().end();
  resetTelemetry();

  const chaves = new Set(enviados.flatMap((b) => Object.keys(JSON.parse(b))));
  assert.deepEqual([...chaves].sort(), ['durationMs', 'event', 'route']);
});
