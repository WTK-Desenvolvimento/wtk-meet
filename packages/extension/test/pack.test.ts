/**
 * `tools/pack.ts`: o que entra e o que fica de fora do zip, e o que ele recusa.
 *
 * Roda o script como o `npm run pack` roda (processo filho), apontando
 * `PACK_DIST`/`PACK_OUT` para um diretório temporário — o `dist/` real não é
 * tocado e o teste não depende de `build.ts` ter rodado antes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'pack.ts');
const temporarios: string[] = [];

after(() => {
  for (const dir of temporarios) rmSync(dir, { recursive: true, force: true });
});

function montar(manifest: string | null): { dist: string; out: string } {
  const base = mkdtempSync(join(tmpdir(), 'pack test '));
  temporarios.push(base);
  const dist = join(base, 'dist');
  mkdirSync(join(dist, 'sub'), { recursive: true });
  if (manifest !== null) writeFileSync(join(dist, 'manifest.json'), manifest);
  writeFileSync(join(dist, 'a.js'), '//');
  writeFileSync(join(dist, 'a.js.map'), '{}');
  writeFileSync(join(dist, 'sub', 'b.js.map'), '{}');
  writeFileSync(join(dist, 'sub', 'c.png'), 'png');
  return { dist, out: join(base, 'out') };
}

function empacotar({ dist, out }: { dist: string; out: string }) {
  return spawnSync(process.execPath, [PACK], {
    env: { ...process.env, PACK_DIST: dist, PACK_OUT: out },
    encoding: 'utf8',
  });
}

function entradas(zip: string): string[] {
  return spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
}

test('zip tem manifest na raiz, mantém subpastas e exclui todo .map', () => {
  const dirs = montar(JSON.stringify({ version: '1.2.3' }));
  const r = empacotar(dirs);
  assert.equal(r.status, 0, r.stderr);

  const zip = join(dirs.out, 'wtk-meet-extension-v1.2.3.zip');
  assert.equal(r.stdout.trim(), zip);
  const lista = entradas(zip);
  assert.ok(lista.includes('manifest.json'));
  assert.ok(lista.includes('a.js'));
  assert.ok(lista.includes('sub/c.png'));
  assert.deepEqual(lista.filter((e) => e.endsWith('.map')), []);
});

test('rodar de novo substitui o zip em vez de acumular entradas', () => {
  const dirs = montar(JSON.stringify({ version: '1.0.0' }));
  assert.equal(empacotar(dirs).status, 0);
  writeFileSync(join(dirs.dist, 'a.js'), '// outra');
  assert.equal(empacotar(dirs).status, 0);
  const lista = entradas(join(dirs.out, 'wtk-meet-extension-v1.0.0.zip'));
  assert.equal(lista.filter((e) => e === 'a.js').length, 1);
});

test('recusa dist sem manifest.json', () => {
  const r = empacotar(montar(null));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /manifest\.json não existe/);
});

test('recusa version ausente ou fora do formato do Chrome', () => {
  for (const manifest of [
    JSON.stringify({}),
    JSON.stringify({ version: '1.2.0-beta.1' }),
    JSON.stringify({ version: 'foo' }),
    JSON.stringify({ version: '../x' }),
    JSON.stringify({ version: '1.2.3.4.5' }),
  ]) {
    const r = empacotar(montar(manifest));
    assert.equal(r.status, 1, manifest);
    assert.match(r.stderr, /ausente ou inválida/, manifest);
  }
});
