/**
 * O único ponto de saída de métrica do produto.
 *
 * Este é o **único** arquivo do repositório que importa `@opentelemetry/*`. Os
 * call sites (`index.ts`) falam domínio — `recordJoin('room_full')` — e nunca
 * API de OTel. A troca é deliberada e tem duas consequências que valem por si:
 * a prova de não-vazamento tem um lugar só para olhar, e substituir o SDK por
 * um POST OTLP/JSON à mão (o plano B registrado no documento de arquitetura)
 * seria mudança de um arquivo, sem tocar em call site nenhum.
 *
 * Quatro propriedades sustentam o resto do desenho:
 *
 * 1. **Sem endpoint, é no-op absoluto.** Sem `OTEL_EXPORTER_OTLP_ENDPOINT` não
 *    se cria `MeterProvider`, não se arma timer e não se abre socket — devolve-se
 *    um objeto com a mesma superfície e todos os métodos vazios. É o que roda em
 *    `npm run dev` e em todo teste que não seja de telemetria.
 * 2. **Todo `record*` é total e síncrono.** Nenhum é `async`, nenhum devolve
 *    promise, nenhum pode lançar. Um handler de Socket.IO que quebrasse por
 *    causa de telemetria mudaria a ordem observável de `join-approved` e
 *    `peer-joined` — que é justamente o que `test/signaling.test.ts` caracteriza.
 * 3. **Os gauges são leitura do `RoomStore`, não contagem.** `snapshot()` é
 *    injetado; ver a decisão §3.5 do documento e o comentário de `registerGauge`.
 * 4. **A allow-list de atributos é estrutural.** Uma *view* catch-all descarta,
 *    antes da agregação, qualquer chave que não seja `outcome` ou `route`. Um
 *    atributo acrescentado por engano num call site futuro não vira série
 *    temporal — ele simplesmente não chega lá.
 *
 * **Divergência registrada (dependências):** o documento previa quatro pacotes
 * `@opentelemetry/*`; são cinco. `@opentelemetry/core` entrou porque
 * `ExportResult`/`ExportResultCode` — o tipo de retorno de `PushMetricExporter.
 * export`, que o wrapper de aviso precisa inspecionar — moram nele. Ele já
 * vinha instalado como transitivo dos outros quatro; declará-lo só torna
 * explícito o que já era usado, e o total instalado continua sendo 11.
 *
 * **Divergência registrada em relação ao documento de arquitetura (§5.4):** o
 * `Telemetry` documentado listava também `recordRoomOpened()`. Ele não foi
 * implementado porque não alimenta nenhuma das nove métricas do catálogo — o
 * número de salas abertas é derivável do que já se exporta (`count` de
 * `wtk_room_lifetime_seconds` + `wtk_rooms_active`). Um método vazio no
 * contrato seria código morto convidando alguém a "consertá-lo" acrescentando
 * uma décima métrica fora do DoD.
 */
import { AggregationTemporalityPreference, OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
} from '@opentelemetry/sdk-metrics';
import { ExportResultCode } from '@opentelemetry/core';

import type { Histogram, Counter } from '@opentelemetry/api';
import type { PushMetricExporter, ResourceMetrics, ViewOptions } from '@opentelemetry/sdk-metrics';
import type { ExportResult } from '@opentelemetry/core';
import type { PageViewRoute } from './telemetryEvents.js';

/** Desfecho de uma tentativa de entrada. Fechado pelo DoD; ver o mapa no README. */
export type JoinOutcome = 'admitted' | 'approved' | 'denied' | 'room_full' | 'invalid_room';

/**
 * Desfecho de um `POST /telemetry`. Fechado em dois valores **de propósito**:
 * um beacon barrado pelo rate limit conta como `rejected`, e não ganha valor
 * próprio — acrescentar `rate_limited` quebraria o catálogo do DoD e o painel
 * versionado. A distinção que se perde vale menos que a cardinalidade fixa.
 */
export type BeaconOutcome = 'accepted' | 'rejected';

/** O que o gauge lê a cada coleta. Números, e só números. */
export interface RoomSnapshot {
  rooms: number;
  participants: number;
}

export interface Telemetry {
  /** `false` quando não há endpoint configurado. É o que `/health` reporta. */
  enabled: boolean;
  recordJoin(outcome: JoinOutcome): void;
  recordSessionEnd(durationMs: number): void;
  recordRoomClosed(lifetimeMs: number, peak: number): void;
  recordPageView(route: PageViewRoute): void;
  recordClientSession(durationMs: number): void;
  recordBeacon(outcome: BeaconOutcome): void;
  shutdown(): Promise<void>;
}

export interface InitTelemetryOptions {
  /**
   * O exporter. Ausente **e** com endpoint configurado ⇒ constrói o OTLP/HTTP.
   * Os testes injetam o `InMemoryMetricExporter` do próprio SDK: nenhum teste
   * abre socket, e a asserção é feita sobre o `ResourceMetrics` de verdade —
   * o mesmo que iria pro fio.
   */
  exporter?: PushMetricExporter;
  /** Leitura do `RoomStore` no instante da coleta (§3.5). */
  snapshot?: () => RoomSnapshot;
  /** Sobrepõe `OTEL_EXPORTER_OTLP_ENDPOINT`. String vazia = desligado. */
  endpoint?: string;
  serviceName?: string;
  serviceVersion?: string;
  intervalMs?: number;
  logger?: Pick<Console, 'warn'>;
  /**
   * Janela de silêncio entre dois avisos de falha de exportação. Existe porque
   * um collector fora do ar produziria um aviso por tentativa, e o log do
   * servidor de sinalização viraria um flood que esconde o resto.
   */
  exportWarnIntervalMs?: number;
}

/**
 * As únicas duas chaves de atributo que existem no sistema inteiro.
 *
 * Não há `roomId`, `socketId`, `displayName`, IP, `Origin` ou User-Agent —
 * **nem hasheados**. Um label de sala transformaria "quem está reunido agora"
 * em série persistida no Prometheus, que é exatamente o banco de dados que o
 * produto se orgulha de não ter; e um hash é pior, porque parece resolvido:
 * com um espaço de nomes prováveis (`daily`, `suporte`), é reversível por força
 * bruta em segundos.
 */
export const ALLOWED_ATTRIBUTE_KEYS = ['outcome', 'route'] as const;

/**
 * Ocupação: `MAX_PARTICIPANTS` é 6, então o bucket `+Inf` deve ficar vazio para
 * sempre. Se ele encher, há defeito na contagem — e isso é sinal útil por si só.
 */
export const OCCUPANCY_BUCKETS = [1, 2, 3, 4, 5, 6];

/** Durações: de "abriu e desistiu" (≤5s) até "reunião de duas horas". */
export const DURATION_BUCKETS_SECONDS = [5, 30, 60, 300, 900, 1800, 3600, 7200];

/**
 * Teto duro de séries por instrumento. O desenho produz no máximo 5 (`outcome`
 * de `wtk_joins_total`); o teto existe para o caso em que ele deixe de produzir.
 */
const CARDINALITY_LIMIT = 32;

const DEFAULT_SERVICE_NAME = 'wtk-meet-server';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_EXPORT_WARN_INTERVAL_MS = 300_000;
/** O reader não pode segurar o `SIGTERM`: ver §7.15 do documento. */
const SHUTDOWN_TIMEOUT_MS = 3_000;

/** A superfície inteira, sem efeito nenhum. */
function noopTelemetry(): Telemetry {
  return {
    enabled: false,
    recordJoin() {},
    recordSessionEnd() {},
    recordRoomClosed() {},
    recordPageView() {},
    recordClientSession() {},
    recordBeacon() {},
    async shutdown() {},
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * `OTEL_EXPORTER_OTLP_ENDPOINT` é a base (`http://alloy:4318`); o caminho do
 * sinal é acrescentado aqui. Passar a URL montada, em vez de deixar o exporter
 * ler a variável sozinho, é o que faz o endpoint efetivo ser decidido em **um**
 * lugar — e é o que permite ao teste apontar para uma porta fechada sem mexer
 * no ambiente do processo.
 */
export function metricsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/metrics`;
}

/**
 * Envolve o exporter real para transformar "falhou" em **um** aviso por janela.
 *
 * Sem isto, o comportamento default do SDK é o oposto do útil nas duas pontas:
 * o `diag` do OTel nasce mudo (um collector fora do ar não produz sinal
 * nenhum), e ligá-lo produz um aviso por tentativa. O que se quer é o meio —
 * saber que a exportação está falhando, uma vez a cada janela, sem que o log
 * do servidor de sinalização vire flood.
 *
 * O aviso **não** carrega a URL do collector nem os headers: `OTEL_EXPORTER_
 * OTLP_HEADERS` é credencial, e log é o lugar mais fácil de vazá-la.
 */
export function withThrottledWarning(
  exporter: PushMetricExporter,
  {
    warn,
    intervalMs,
    now = () => Date.now(),
  }: { warn: (message: string) => void; intervalMs: number; now?: () => number },
): PushMetricExporter {
  let lastWarnAt = -Infinity;
  let suppressed = 0;

  return {
    export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
      exporter.export(metrics, (result) => {
        if (result.code === ExportResultCode.FAILED) {
          const at = now();
          if (at - lastWarnAt >= intervalMs) {
            const extra = suppressed > 0 ? ` (${suppressed} falha(s) omitida(s) desde o último aviso)` : '';
            lastWarnAt = at;
            suppressed = 0;
            warn(
              `[telemetry] falha ao exportar métricas para o collector${extra}. ` +
                'O produto segue normalmente; nenhuma métrica é bufferizada em disco.',
            );
          } else {
            suppressed += 1;
          }
        }
        resultCallback(result);
      });
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: () => exporter.shutdown(),
    // Repassados **por referência condicional**: o `PeriodicExportingMetricReader`
    // checa a presença do método, e um wrapper que sempre os define mudaria a
    // temporalidade escolhida por um exporter que não os implementa.
    ...(exporter.selectAggregationTemporality
      ? { selectAggregationTemporality: exporter.selectAggregationTemporality.bind(exporter) }
      : {}),
    ...(exporter.selectAggregation
      ? { selectAggregation: exporter.selectAggregation.bind(exporter) }
      : {}),
  };
}

/**
 * Liga a telemetria, ou devolve o no-op.
 *
 * A decisão de ligar tem uma condição só: existe endpoint (por opção ou por
 * `OTEL_EXPORTER_OTLP_ENDPOINT`), **ou** um exporter foi injetado. A segunda
 * metade é o que permite ao teste rodar tudo sem variável de ambiente.
 */
export function initTelemetry({
  exporter,
  snapshot,
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
  serviceName = process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
  serviceVersion = process.env.npm_package_version || '0.0.0',
  intervalMs = positiveInt(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS, DEFAULT_INTERVAL_MS),
  logger = console,
  exportWarnIntervalMs = DEFAULT_EXPORT_WARN_INTERVAL_MS,
}: InitTelemetryOptions = {}): Telemetry {
  const configuredEndpoint = endpoint.trim();
  if (!exporter && !configuredEndpoint) {
    // Um aviso, no boot, no mesmo tom do aviso de TURN ausente — e pelo mesmo
    // motivo: um deploy sem configuração não pode ser indistinguível de um
    // deploy saudável. A diferença é que TURN ausente desliga o produto e
    // telemetria ausente não degrada nada, por isso aviso e não erro.
    logger.warn(
      '[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT não configurado — nenhuma métrica sai deste processo. ' +
        '/health reportará telemetry.enabled:false e POST /telemetry continuará respondendo 204.',
    );
    return noopTelemetry();
  }

  const pushExporter =
    exporter ??
    withThrottledWarning(
      new OTLPMetricExporter({
        url: metricsUrl(configuredEndpoint),
        // Cumulativa é o que o Prometheus espera; delta exigiria
        // `deltatocumulative` no pipeline do collector — estado a mais em
        // troca de nada.
        temporalityPreference: AggregationTemporalityPreference.CUMULATIVE,
      }),
      { warn: (message) => logger.warn(message), intervalMs: exportWarnIntervalMs },
    );

  const reader = new PeriodicExportingMetricReader({
    exporter: pushExporter,
    exportIntervalMillis: intervalMs,
    // Curto: o callback do gauge só lê memória, então estourar isto significa
    // que o processo está travado por outro motivo.
    exportTimeoutMillis: Math.min(intervalMs, 30_000),
  });

  /**
   * A view catch-all. É reforço **estrutural**, e não disciplina: qualquer
   * atributo fora da allow-list é descartado antes da agregação, em qualquer
   * instrumento, inclusive nos que ainda não existem.
   *
   * Ela é **uma só**, e não uma por instrumento, por um motivo de API: quando
   * duas views casam com o mesmo instrumento, o SDK cria dois fluxos com o
   * mesmo nome. É por isso que as fronteiras de bucket dos histogramas vão em
   * `advice` na criação do instrumento, e não numa view por nome.
   */
  const views: ViewOptions[] = [
    {
      instrumentName: '*',
      attributesProcessors: [createAllowListAttributesProcessor([...ALLOWED_ATTRIBUTE_KEYS])],
      aggregationCardinalityLimit: CARDINALITY_LIMIT,
    },
  ];

  const provider = new MeterProvider({
    // Resource **explícito**. Nada de `detectResources()`: `hostDetector` e
    // `processDetector` acrescentariam `host.name`, `process.pid` e
    // `process.command_args`, que carregam hostname e caminho do filesystem do
    // operador para dentro da stack de monitoramento sem ninguém ter pedido.
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'service.version': serviceVersion,
    }),
    readers: [reader],
    views,
  });

  const meter = provider.getMeter('wtk-meet');

  const joins: Counter = meter.createCounter('wtk_joins_total', {
    description: 'Desfechos de tentativas de entrada em sala.',
    unit: '{join}',
  });
  const pageViews: Counter = meter.createCounter('wtk_page_views_total', {
    description: 'Páginas vistas, por rota. Nunca o endereço da sala.',
    unit: '{page_view}',
  });
  const beacons: Counter = meter.createCounter('wtk_telemetry_beacons_total', {
    description: 'Beacons recebidos em POST /telemetry (rate limit conta como rejected).',
    unit: '{beacon}',
  });
  const sessionDuration: Histogram = meter.createHistogram('wtk_session_duration_seconds', {
    description: 'Tempo de um socket dentro de uma sala.',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
  });
  const roomLifetime: Histogram = meter.createHistogram('wtk_room_lifetime_seconds', {
    description: 'Tempo entre a abertura de uma sala e o momento em que ela esvaziou.',
    unit: 's',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
  });
  const clientSessionDuration: Histogram = meter.createHistogram(
    'wtk_client_session_duration_seconds',
    {
      description: 'Tempo que uma aba ficou na sala, medido no navegador.',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
    },
  );
  const occupancy: Histogram = meter.createHistogram('wtk_room_occupancy', {
    description: 'Pico de participantes simultâneos de cada sala, amostrado no fechamento.',
    unit: '{participant}',
    advice: { explicitBucketBoundaries: OCCUPANCY_BUCKETS },
  });

  /**
   * Gauge derivado do estado real, com o último valor conhecido como rede.
   *
   * Contador incremental exigiria que **todos** os caminhos de saída
   * decrementassem — e este servidor tem quatro. Um esquecido produz "7 salas
   * ativas" num servidor com zero, o gráfico mente para sempre, e ninguém
   * descobre sem reiniciar o processo. Derivar do `Map` torna esse defeito
   * impossível por construção.
   *
   * O guard existe porque o callback roda no ciclo de exportação: se ele
   * lançar, o SDK registra erro a cada intervalo — barulho constante e métrica
   * ausente ao mesmo tempo.
   */
  if (snapshot) {
    let lastKnown: RoomSnapshot = { rooms: 0, participants: 0 };
    const read = (): RoomSnapshot => {
      try {
        const current = snapshot();
        if (Number.isFinite(current?.rooms) && Number.isFinite(current?.participants)) {
          lastKnown = { rooms: current.rooms, participants: current.participants };
        }
      } catch {
        // Fica com o último valor conhecido, em silêncio: um aviso aqui seria
        // um aviso por janela de exportação, para sempre.
      }
      return lastKnown;
    };

    meter
      .createObservableGauge('wtk_rooms_active', {
        description: 'Salas com pelo menos um participante, no instante da coleta.',
        unit: '{room}',
      })
      .addCallback((result) => result.observe(read().rooms));

    meter
      .createObservableGauge('wtk_participants_active', {
        description: 'Participantes somados de todas as salas, no instante da coleta.',
        unit: '{participant}',
      })
      .addCallback((result) => result.observe(read().participants));
  }

  /**
   * O invólucro que torna todo `record*` total.
   *
   * Não é paranoia: `add`/`record` do SDK podem lançar por argumento inválido,
   * e o chamador é um handler de Socket.IO no meio de uma sequência de `emit`.
   * Telemetria que derruba um `join-approved` é pior do que telemetria nenhuma.
   */
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Silêncio deliberado: ver o comentário acima. Uma métrica perdida não
      // tem consequência; um log por evento, sim.
    }
  };

  /** Milissegundos → segundos, recusando o que não é número utilizável. */
  const seconds = (ms: number): number | null =>
    Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;

  return {
    enabled: true,

    recordJoin(outcome: JoinOutcome) {
      safely(() => joins.add(1, { outcome }));
    },

    recordSessionEnd(durationMs: number) {
      safely(() => {
        const value = seconds(durationMs);
        if (value !== null) sessionDuration.record(value);
      });
    },

    recordRoomClosed(lifetimeMs: number, peak: number) {
      safely(() => {
        const value = seconds(lifetimeMs);
        if (value !== null) roomLifetime.record(value);
        if (Number.isFinite(peak) && peak > 0) occupancy.record(peak);
      });
    },

    recordPageView(route: PageViewRoute) {
      safely(() => pageViews.add(1, { route }));
    },

    recordClientSession(durationMs: number) {
      safely(() => {
        const value = seconds(durationMs);
        if (value !== null) clientSessionDuration.record(value);
      });
    },

    recordBeacon(outcome: BeaconOutcome) {
      safely(() => beacons.add(1, { outcome }));
    },

    /**
     * Fecha o reader sem segurar a saída do processo.
     *
     * Um `shutdown()` que espere um collector fora do ar deixa o container
     * pendurado até o `SIGKILL` do orquestrador. O último intervalo de
     * contadores pode se perder: é o preço, e ele é menor que o de um deploy
     * que demora um minuto para morrer. Nunca rejeita.
     */
    async shutdown() {
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        // Um timer pendente aqui manteria o event loop vivo justamente no
        // caminho que existe para deixá-lo morrer.
        timer.unref?.();
      });
      try {
        await Promise.race([provider.shutdown({ timeoutMillis: SHUTDOWN_TIMEOUT_MS }), timeout]);
      } catch {
        // Exporter que rejeita no fechamento não pode impedir o processo de sair.
      }
    },
  };
}
