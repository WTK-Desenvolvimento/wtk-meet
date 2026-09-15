/**
 * Gera os quatro PNGs do ícone (16/32/48/128) a partir de código, sem binário
 * versionado e sem ferramenta de imagem na árvore.
 *
 * Por que gerar em vez de commitar o PNG: um ícone binário no repositório é um
 * arquivo que ninguém revisa e que ninguém sabe regenerar. Aqui o desenho é
 * literal — um círculo com uma colcheia — e cabe num arquivo que o `tsc` confere.
 *
 * O PNG é escrito à mão (assinatura, IHDR, IDAT com `zlib.deflateSync`, IEND):
 * é o formato mais simples que o Chrome aceita para `action.default_icon`, e a
 * alternativa seria uma dependência de imagem para desenhar um círculo.
 *
 * Rodar: `node tools/makeIcons.ts` (o `build.ts` chama quando os arquivos não
 * existem).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

/** CRC-32 do PNG. Tabela calculada uma vez. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const corpo = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([length, corpo, crc]);
}

/** RGBA → PNG. Uma linha por `scanline`, todas com filtro 0 (nenhum). */
function png(size: number, pixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.subarray(y * size * 4, (y + 1) * size * 4)).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Disco azul do produto com uma nota branca no meio. */
function desenhar(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const centro = (size - 1) / 2;
  const raio = size * 0.46;
  const hasteX = size * 0.6;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const dist = Math.hypot(x - centro, y - centro);
      if (dist > raio) continue;
      // Fundo: o azul de acento da UI.
      px[i] = 0x4f;
      px[i + 1] = 0x7c;
      px[i + 2] = 0xff;
      px[i + 3] = 0xff;

      // A haste da colcheia e a cabeça, em branco.
      const naHaste = Math.abs(x - hasteX) < size * 0.06 && y > size * 0.26 && y < size * 0.68;
      const naCabeca = Math.hypot(x - (hasteX - size * 0.14), y - size * 0.68) < size * 0.14;
      const naBandeira =
        x > hasteX && x < hasteX + size * 0.2 && y > size * 0.26 && y < size * 0.26 + size * 0.14;
      if (naHaste || naCabeca || naBandeira) {
        px[i] = 0xff;
        px[i + 1] = 0xff;
        px[i + 2] = 0xff;
      }
    }
  }
  return px;
}

export function gerarIcones(destino = join(RAIZ, 'icons')): void {
  mkdirSync(destino, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(join(destino, `icon${size}.png`), png(size, desenhar(size)));
  }
}

// `import.meta.main` não existe no Node 24; a comparação de URL é o equivalente.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) gerarIcones();
