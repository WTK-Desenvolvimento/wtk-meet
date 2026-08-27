/**
 * O aparato dos testes de telemetria que precisam do servidor **de verdade**.
 *
 * Duas peças: um collector OTLP falso (um `http.Server` que guarda o corpo cru
 * de cada `POST /v1/metrics`) e um `startServer` que sobe `src/index.ts` num
 * processo filho apontado para ele.
 *
 * A escolha de guardar o **corpo cru**, e não um objeto já interpretado, é o
 * que dá peso ao teste de não-vazamento: a asserção é feita sobre os bytes que
 * sairiam para a stack de monitoramento de produção, e não sobre uma estrutura
 * que o teste montou. Se um `roomId` vazasse por um caminho que ninguém
 * imaginou — um atributo de resource, uma descrição de instrumento, um nome de
 * escopo — ele estaria nessa string.
 *
 * Não é dublê de OTel: o exporter é o OTLP/HTTP real, e o que ele fala é JSON.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TS_HOOK = fileURLToPath(new URL('../../../../tools/registerTs.mjs', import.meta.url));

/** Um ponto de dado como o OTLP/JSON o escreve. */
interface OtlpDataPoint {
  attributes?: { key: string; value: Record<string, unknown> }[];
  asInt?: string;
  asDouble?: number;
  count?: string;
  sum?: number;
  bucketCounts?: string[];
  explicitBounds?: number[];
}

interface OtlpMetric {
  name: string;
  unit?: string;
  sum?: { dataPoints: OtlpDataPoint[]; aggregationTemporality?: number; isMonotonic?: boolean };
  gauge?: { dataPoints: OtlpDataPoint[] };
  histogram?: { dataPoints: OtlpDataPoint[]; aggregationTemporality?: number };
}

export interface FlatSeries {
  name: string;
  unit: string;
  kind: 'sum' | 'gauge' | 'histogram';
  attributes: Record<string, string>;
  point: OtlpDataPoint;
}

export interface FakeCollector {
  /** O que vai em `OTEL_EXPORTER_OTLP_ENDPOINT` (base, sem `/v1/metrics`). */
  endpoint: string;
  /** Os corpos crus, na ordem em que chegaram. */
  bodies: () => string[];
  /** Todas as séries de todas as exportações, achatadas. */
  series: () => FlatSeries[];
  /** Espera até haver pelo menos `n` exportações, ou estoura. */
  waitForExports: (n: number, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

/** Interpreta o valor de um atributo OTLP sem assumir que ele é string. */
function attributeValue(value: Record<string, unknown>): string {
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.intValue === 'string') return value.intValue;
  if (typeof value.boolValue === 'boolean') return String(value.boolValue);
  if (typeof value.doubleValue === 'number') return String(value.doubleValue);
  return JSON.stringify(value);
}

export async function startFakeCollector(): Promise<FakeCollector> {
  const bodies: string[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.endsWith('/v1/metrics')) bodies.push(raw);
      // A resposta de sucesso do OTLP/HTTP é um `ExportMetricsServiceResponse`
      // vazio. Responder outra coisa faria o exporter tratar como falha.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    bodies: () => bodies.slice(),

    series() {
      const out: FlatSeries[] = [];
      for (const body of bodies) {
        let parsed: { resourceMetrics?: { scopeMetrics?: { metrics?: OtlpMetric[] }[] }[] };
        try {
          parsed = JSON.parse(body);
        } catch {
          continue;
        }
        for (const rm of parsed.resourceMetrics ?? []) {
          for (const sm of rm.scopeMetrics ?? []) {
            for (const metric of sm.metrics ?? []) {
              const kind: FlatSeries['kind'] | null = metric.sum
                ? 'sum'
                : metric.gauge
                  ? 'gauge'
                  : metric.histogram
                    ? 'histogram'
                    : null;
              if (!kind) continue;
              const points =
                metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? metric.histogram?.dataPoints ?? [];
              for (const point of points) {
                const attributes: Record<string, string> = {};
                for (const attr of point.attributes ?? []) {
                  attributes[attr.key] = attributeValue(attr.value);
                }
                out.push({ name: metric.name, unit: metric.unit ?? '', kind, attributes, point });
              }
            }
          }
        }
      }
      return out;
    },

    async waitForExports(n, timeoutMs = 8000) {
      const limit = Date.now() + timeoutMs;
      while (bodies.length < n) {
        if (Date.now() > limit) {
          throw new Error(`o collector recebeu ${bodies.length} exportações, esperava ${n}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface RunningServer {
  base: string;
  port: number;
  /** Tudo o que o processo imprimiu, stdout e stderr juntos. */
  saida: () => string;
  stop: () => Promise<void>;
}

/**
 * Sobe `src/index.ts` de verdade, num processo filho, com o `.env` do
 * desenvolvedor neutralizado — nem TURN nem telemetria podem vir de fora.
 */
export async function startServer({
  env = {},
}: { env?: Record<string, string> } = {}): Promise<RunningServer> {
  const port = 22000 + Math.floor(Math.random() * 8000);
  const child: ChildProcess = spawn(process.execPath, ['--import', TS_HOOK, 'src/index.ts'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      CF_TURN_TOKEN_ID: '',
      CF_TURN_API_TOKEN: '',
      DOTENV_CONFIG_QUIET: 'true',
      PORT: String(port),
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_HEADERS: '',
      TELEMETRY_RATE_LIMIT_PER_MINUTE: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saida = '';
  child.stdout!.on('data', (chunk) => {
    saida += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    saida += chunk;
  });

  const base = `http://127.0.0.1:${port}`;
  const limit = Date.now() + 15_000;
  for (;;) {
    if (Date.now() > limit) {
      child.kill('SIGKILL');
      throw new Error(`servidor não subiu em 15s:\n${saida}`);
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
    port,
    saida: () => saida,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        // SIGKILL: o caminho de `SIGTERM` é coberto por teste próprio, e neste
        // sandbox o sinal costuma não ser entregue ao filho.
        child.kill('SIGKILL');
      }),
  };
}
