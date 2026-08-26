/**
 * Declaração **transitória** de `musicSources.js`.
 *
 * O módulo continua JavaScript por um motivo específico e registrado: o teste
 * `musicSources.test.mjs` prova a pureza dele **lendo o texto do arquivo** por
 * caminho (`readFile('../src/lib/musicSources.js')`), e nenhum hook de módulo
 * intercepta uma leitura de `fs`. Renomear agora quebraria o item 6 do DoD
 * (testes byte-a-byte idênticos nas fases 2–6).
 *
 * Este arquivo existe só para que quem já é TypeScript enxergue os tipos. Ele
 * **some na fase 7**, junto com a conversão do teste e do próprio módulo, e
 * estas declarações passam a viver no `.ts`.
 */

export type SourceKind = 'youtube' | 'file' | 'url';
export type Availability = 'ok' | 'embed-blocked' | 'not-found' | 'unknown';

export interface ParsedSourceOk {
  ok: true;
  kind: SourceKind;
  sourceRef: string;
  title: string;
  warning?: string | null;
}

export interface ParsedSourceFail {
  ok: false;
  reason: string;
}

export type ParsedSource = ParsedSourceOk | ParsedSourceFail;

export interface SourceMeta {
  title: string;
  availability: Availability;
}

export const MAX_TITLE: number;
export const MAX_SOURCE_REF: number;
export const SOURCE_KINDS: ReadonlySet<string>;
export const AVAILABILITY: ReadonlySet<string>;
export const REFUSAL_BY_AVAILABILITY: Record<string, string | undefined>;
export const SOURCE_ERRORS: Record<string, string>;

export function parseYouTubeId(raw: unknown): string | null;
export function titleFromUrl(raw: unknown): string;
export function titleFromFileName(name: unknown): string;
export function looksLikeAudioUrl(raw: unknown): boolean;
export function parseSource(raw: unknown, options?: { allowYouTube?: boolean }): ParsedSource;
export function resolveSourceMeta(
  parsed: ParsedSource | null | undefined,
  options?: {
    fetchMeta?: (
      sourceRef: string,
    ) => Promise<{ title?: unknown; availability?: unknown } | null | undefined>;
  },
): Promise<SourceMeta>;
export function parseFileSource(file: unknown): ParsedSource;
export function formatDuration(seconds: unknown): string;
