/**
 * Converte caracteres de controle literais em escapes \uXXXX.
 *
 * Um arquivo de teste que exercita sanitizacao acaba com bytes de controle
 * dentro de string literal — e o git passa a trata-lo como binario, o que
 * arruina o diff. Os escapes produzem exatamente a mesma string em tempo de
 * execucao, entao o teste continua testando a mesma coisa.
 *
 * A varredura e por ponto de codigo, sem regex literal: escrever a classe de
 * caracteres traria o mesmo problema para dentro deste arquivo.
 *
 * Uso: node scripts/fix-control-chars.js <arquivo...>
 */
import fs from 'node:fs';

const NEWLINE = 0x0a;
const TAB = 0x09;
const DEL = 0x7f;

function isControl(code) {
  if (code === NEWLINE || code === TAB) return false; // legitimos em codigo-fonte
  return code < 0x20 || code === DEL;
}

for (const file of process.argv.slice(2)) {
  const original = fs.readFileSync(file, 'utf8');
  let changed = 0;
  let out = '';

  for (const char of original) {
    const code = char.codePointAt(0);
    if (isControl(code)) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      changed += 1;
    } else {
      out += char;
    }
  }

  if (changed === 0) {
    process.stdout.write(`${file}: nada a fazer\n`);
    continue;
  }
  fs.writeFileSync(file, out);
  process.stdout.write(`${file}: ${changed} caractere(s) escapado(s)\n`);
}
