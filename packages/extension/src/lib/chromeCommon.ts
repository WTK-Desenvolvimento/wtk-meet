/**
 * As duas APIs que **todo** contexto da extensão tem: `chrome.runtime` e
 * `chrome.storage`.
 *
 * Por que passar por aqui em vez de escrever `chrome.` direto: o documento
 * offscreen tem acesso a um subconjunto pequeno da API de extensão —
 * `chrome.tabs`, `chrome.action` e `chrome.offscreen` **não são dele**. Um
 * `chrome.action.setBadgeText` lá dentro é `TypeError` em runtime, e nada no
 * compilador avisa. A regra do motor, escrita também no topo de `offscreen.ts`,
 * é: *o motor só fala `chrome.runtime` e `chrome.storage`; qualquer outra coisa
 * é pedida ao service worker por mensagem (`target: 'sw'`)*.
 *
 * Este módulo é o que torna a regra verificável: `offscreen.ts` e `engine/`
 * importam daqui, e o lint recusa o global `chrome` nesses arquivos.
 */

/** `chrome.runtime`, na fatia que existe em qualquer contexto. */
export const runtime = chrome.runtime;
