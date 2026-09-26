/**
 * O contrato do pacote: manifest, permissões, `dist/` e os documentos.
 *
 * Três coisas que o DoD desta entrega cobra e que nenhum teste de lógica
 * alcança, porque nenhuma delas é código que roda:
 *
 * 1. **"Não pede permissão que o código não use."** Uma permissão a mais no
 *    manifest não quebra nada — ela só custa a revisão da Chrome Web Store e a
 *    confiança de quem instala, e por isso é exatamente o tipo de coisa que
 *    apodrece sem ninguém ver. Aqui a lista do manifest, o uso no código e a
 *    tabela de `PERMISSIONS.md` são conferidos **um contra o outro**: as três
 *    têm que contar a mesma história.
 * 2. **"`npm run build` produz um `dist/` carregável."** O build roda de novo
 *    aqui (custa menos de um segundo) e o que se afirma é o que o Chrome faz ao
 *    carregar sem compactação: todo arquivo que o manifest aponta existe, e todo
 *    `src`/`href` dos três HTML resolve. Um `background.js` que não foi emitido
 *    é uma extensão que nem chega a subir — e o erro aparece no navegador de
 *    quem instalou, não na CI.
 * 3. **A decisão de não haver E2EE derivada está escrita.** É requisito do card
 *    ("precisa ficar documentado como decisão explícita"), e um requisito de
 *    documentação sem teste é um requisito que a próxima entrega apaga sem
 *    perceber.
 *
 * Este arquivo **não** duplica o que `meetCode.test.ts` e companhia já provam:
 * ele olha o pacote de fora, como quem vai instalar.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DIST = join(EXT, 'dist');

interface Manifest {
  manifest_version: number;
  background?: { service_worker?: string; type?: string };
  action?: { default_popup?: string; default_icon?: Record<string, string> };
  permissions?: string[];
  host_permissions?: string[];
  icons?: Record<string, string>;
  [campo: string]: unknown;
}

const manifestBruto = readFileSync(join(EXT, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestBruto) as Manifest;

/**
 * O texto de um `.ts` de `src/`, **sem comentários**.
 *
 * Sem esta poda, a varredura de `chrome.*` acusaria as APIs citadas em prosa —
 * e `offscreen.ts` cita `chrome.tabs` e `chrome.action` justamente para dizer
 * que **não** as usa. O `(?<!:)` poupa o `//` de uma URL dentro de string.
 */
function semComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/.*$/gm, ' ');
}

function fontes(): { caminho: string; codigo: string }[] {
  return readdirSync(join(EXT, 'src'), { recursive: true })
    .map(String)
    .filter((nome) => nome.endsWith('.ts') && !nome.endsWith('.d.ts'))
    .map((nome) => ({
      caminho: nome,
      codigo: semComentarios(readFileSync(join(EXT, 'src', nome), 'utf8')),
    }));
}

const CODIGO = fontes()
  .map((f) => f.codigo)
  .join('\n');

/** `chrome.<api>` que o MV3 dá de graça — nenhuma permissão as habilita. */
const SEM_PERMISSAO = new Set(['runtime', 'action']);

/**
 * `chrome.<api>` → a permissão que o manifest precisa declarar por ela.
 *
 * `tabs` está mapeada para `activeTab` de propósito: `chrome.tabs.create` não
 * exige nada, mas `chrome.tabs.query` só devolve `url` com `activeTab` (no
 * clique) ou com a permissão ampla `tabs`. Exigir a declaração é o lado seguro.
 */
const EXIGE = new Map([
  ['offscreen', 'offscreen'],
  ['storage', 'storage'],
  ['tabs', 'activeTab'],
  ['notifications', 'notifications'],
]);

/** Como se prova, no código, que uma permissão declarada é usada. */
const EVIDENCIA: Record<string, RegExp> = {
  offscreen: /chrome\.offscreen\./,
  storage: /chrome\.storage\./,
  activeTab: /chrome\.tabs\.query/,
  notifications: /chrome\.notifications\./,
};

test('o manifest é V3 e o service worker é módulo', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.service_worker, 'background.js');
  assert.equal(manifest.background?.type, 'module');
  assert.equal(manifest.action?.default_popup, 'popup.html');
});

test('as permissões declaradas são exatamente as quatro da entrega', () => {
  assert.deepEqual([...(manifest.permissions ?? [])].sort(), ['activeTab', 'notifications', 'offscreen', 'storage']);
  assert.deepEqual(manifest.host_permissions, [
    'https://meet.google.com/*',
    'https://meet.wtk.app/*',
    'https://meet-api.wtk.app/*',
  ]);
});

test('toda permissão declarada tem uso no código', () => {
  for (const permissao of manifest.permissions ?? []) {
    const evidencia = EVIDENCIA[permissao];
    assert.ok(evidencia, `permissão '${permissao}' sem evidência esperada — atualize este teste ou o manifest`);
    assert.match(CODIGO, evidencia, `'${permissao}' está no manifest e nada no código a usa`);
  }
});

test('toda API `chrome.*` usada no código está coberta por uma permissão', () => {
  const usadas = new Set<string>();
  for (const [, api] of CODIGO.matchAll(/(?<![\w/])chrome\.([a-z][a-zA-Z]*)\./g)) usadas.add(api!);

  // O que a extensão usa hoje. Se esta lista crescer, a linha de baixo diz por quê.
  assert.ok(usadas.size > 0, 'a varredura não encontrou nenhuma chamada — o regex quebrou');

  const declaradas = new Set(manifest.permissions ?? []);
  for (const api of usadas) {
    if (SEM_PERMISSAO.has(api)) continue;
    const exigida = EXIGE.get(api);
    assert.ok(exigida, `\`chrome.${api}\` é usada e este teste não sabe qual permissão a cobre`);
    assert.ok(
      declaradas.has(exigida),
      `\`chrome.${api}\` é usada e o manifest não declara '${exigida}'`,
    );
  }
});

test('toda permissão do manifest está justificada em PERMISSIONS.md', () => {
  const texto = readFileSync(join(EXT, 'PERMISSIONS.md'), 'utf8');
  for (const permissao of manifest.permissions ?? []) {
    assert.match(
      texto,
      new RegExp(`\`${permissao}\``),
      `'${permissao}' está no manifest e não tem linha em PERMISSIONS.md`,
    );
  }
  for (const host of manifest.host_permissions ?? []) {
    assert.ok(texto.includes(host), `o host '${host}' não está justificado em PERMISSIONS.md`);
  }
});

test('o que PERMISSIONS.md diz que não pede, o manifest realmente não pede', () => {
  // As quatro recusas explícitas do §3.10 e do §2 do documento de arquitetura.
  // Cada uma delas foi uma decisão; sem este teste, voltar é um `git commit` que
  // ninguém questiona.
  assert.ok(!(manifest.permissions ?? []).includes('tabs'), 'a permissão ampla `tabs` voltou');
  assert.ok(!(manifest.permissions ?? []).includes('tabCapture'), '`tabCapture` voltou — ver §2 do doc');
  // Content scripts são permitidos, mas nunca em google.com (apenas no app wtk-meet).
  const cs: { matches?: string[] }[] = (manifest.content_scripts as { matches?: string[] }[] | undefined) ?? [];
  assert.ok(
    !cs.some((s) => s.matches?.some((m) => m.includes('google.com'))),
    'content script injetado em google.com',
  );
  assert.equal(
    manifest.optional_host_permissions,
    undefined,
    'a permissão de host ampla (§3.10) segue pendente de aval — não entra sem decisão',
  );
  assert.ok(!manifestBruto.includes('<all_urls>'), '`<all_urls>` no manifest');
  assert.ok(!manifestBruto.includes('*://*/*'), 'host permission curinga no manifest');
});

test('`npm run build` produz um dist/ com tudo que o manifest aponta', () => {
  // O build é barato (esbuild, ~100ms) e roda aqui para que o teste afirme o
  // estado de **agora**, e não o de uma execução anterior que ninguém viu.
  execFileSync('node', ['build.ts'], { cwd: EXT, stdio: 'pipe' });

  const referenciados = [
    manifest.background!.service_worker!,
    manifest.action!.default_popup!,
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {}),
  ];
  for (const arquivo of referenciados) {
    assert.ok(existsSync(join(DIST, arquivo)), `o manifest aponta '${arquivo}' e ele não está no dist/`);
  }

  // As outras duas superfícies não aparecem no manifest (a `manager` abre por
  // `chrome.runtime.getURL`, o offscreen por `createDocument`) — e é justamente
  // por não aparecerem que um build que as esquecesse passaria despercebido.
  for (const arquivo of ['manager.html', 'manager.js', 'offscreen.html', 'offscreen.js']) {
    assert.ok(existsSync(join(DIST, arquivo)), `'${arquivo}' não foi emitido`);
  }
});

test('todo src/href dos HTML do dist resolve dentro do dist', () => {
  const htmls = readdirSync(DIST).filter((nome) => nome.endsWith('.html'));
  assert.ok(htmls.length >= 3, 'esperava popup, manager e offscreen');
  for (const html of htmls) {
    const conteudo = readFileSync(join(DIST, html), 'utf8');
    for (const [, referencia] of conteudo.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:)?\/\//.test(referencia!)) continue;
      assert.ok(
        existsSync(join(DIST, referencia!)),
        `${html} referencia '${referencia}', que não existe no dist/`,
      );
    }
  }
});

test('nenhum bundle carrega `import.meta.env` — a telemetria do app fica no app', () => {
  // O `define` do `build.ts` é a rede de segurança para um import futuro que
  // arrastasse `config.ts` do client. Esta asserção é o alarme dela.
  for (const arquivo of readdirSync(DIST).filter((nome) => nome.endsWith('.js'))) {
    const conteudo = readFileSync(join(DIST, arquivo), 'utf8');
    assert.ok(
      !conteudo.includes('import.meta.env'),
      `${arquivo} embute \`import.meta.env\` — algum import puxou o config do app`,
    );
  }
});

test('a ausência de E2EE derivada está escrita nos três documentos', () => {
  // Requisito do card, não zelo: "o fluxo da extensão entra sem passphrase
  // derivada (sem a camada de E2EE do app), o que precisa ficar documentado como
  // decisão explícita".
  const arquitetura = readFileSync(join(REPO, 'ARCHITECTURE.md'), 'utf8');
  assert.match(arquitetura, /^## 11\..*Extens(ã|a)o Chrome/m, 'ARCHITECTURE.md perdeu a §11');
  assert.match(arquitetura, /DTLS-SRTP/);
  assert.match(arquitetura, /### 11\.2 Sem passphrase e sem chave derivada/);

  for (const readme of ['README.md', 'README.en.md']) {
    const texto = readFileSync(join(REPO, readme), 'utf8');
    assert.match(texto, /packages\/extension/, `${readme} não fala da extensão`);
    assert.match(texto, /E2EE/, `${readme} não diz que a sala da extensão entra sem a camada extra`);
    assert.match(texto, /DTLS-SRTP/, `${readme} não diz o que protege o áudio no lugar dela`);
  }

  const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /packages\/extension/);
});

/**
 * O que um `git clone` recebe — que não é, necessariamente, o que este worktree
 * tem.
 *
 * Todos os testes acima (inclusive o que roda `node build.ts`) olham para os
 * arquivos **em disco**. Um arquivo que existe aqui e que o `git` ignora passa
 * em todos eles e desaparece do PR: a suíte fecha verde na máquina de quem
 * escreveu e o build quebra na de quem clonou, com um `Could not resolve` que
 * não aponta para nenhuma mudança recente. É a mesma classe de falha silenciosa
 * que o §11 do `ARCHITECTURE.md` persegue, só que no empacotamento em vez de no
 * áudio.
 *
 * `dist/`, `icons/` e `node_modules/` são ignorados **de propósito** — os dois
 * primeiros o `build.ts` gera (os ícones são desenhados por
 * `tools/makeIcons.ts`, para não versionar binário). Qualquer outra ausência é
 * defeito, e a mensagem traz a regra de `.gitignore` responsável para que o
 * conserto não dependa de adivinhação.
 */
const GERADOS_DE_PROPOSITO = new Set(['node_modules', 'dist', 'icons']);

function arquivosEmDisco(relativo = ''): string[] {
  return readdirSync(join(EXT, relativo), { withFileTypes: true }).flatMap((entrada) => {
    const caminho = relativo ? `${relativo}/${entrada.name}` : entrada.name;
    if (entrada.isDirectory()) {
      return GERADOS_DE_PROPOSITO.has(caminho) ? [] : arquivosEmDisco(caminho);
    }
    return entrada.isFile() ? [caminho] : [];
  });
}

/** A linha de `.gitignore` que manda ignorar o caminho, ou `null`. */
function regraQueIgnora(relativo: string): string | null {
  try {
    return execFileSync('git', ['check-ignore', '-v', '--', `packages/extension/${relativo}`], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null; // `check-ignore` sai com 1 quando o caminho não é ignorado.
  }
}

test('todo arquivo do pacote está versionado — o clone recebe o que este worktree tem', () => {
  const rastreados = new Set(
    execFileSync('git', ['ls-files', '-z', '--', 'packages/extension'], { cwd: REPO, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .map((caminho) => caminho.replace(/^packages\/extension\//, '')),
  );

  const ausentes = arquivosEmDisco().filter((caminho) => !rastreados.has(caminho));
  const detalhe = ausentes
    .map((caminho) => `  ${caminho} — ${regraQueIgnora(caminho) ?? 'não é ignorado; falta um `git add`'}`)
    .join('\n');

  assert.deepEqual(
    ausentes,
    [],
    `arquivo(s) do pacote fora do git — um clone não consegue construir a extensão:\n${detalhe}`,
  );
});
