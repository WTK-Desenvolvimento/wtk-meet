// Antes de tudo: a base de tokens e a camada `base` precisam ser avaliadas
// antes de qualquer CSS de componente. A ordem final é garantida pelas camadas
// declaradas no `index.html` (ver o cabeçalho de `styles.css`); este import
// vir primeiro é a segunda linha de defesa, não a única.
import './styles.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import { THEME, applyTheme, readTheme, resolveTheme } from './lib/theme.js';

// `#root` é criado pelo `index.html`; sem ele não há aplicação para montar, e
// falhar alto aqui é melhor do que uma tela branca sem explicação.
const root = document.getElementById('root');
if (!root) throw new Error('#root não existe no index.html');

/**
 * Enquanto a preferência for `system`, o tema acompanha o sistema **com a aba
 * aberta**. O script inline do `index.html` resolve uma vez, no boot; este
 * listener cobre o resto da sessão — trocar o tema do SO com a chamada em curso
 * é justamente quando ninguém quer recarregar a página.
 *
 * Fora de qualquer componente de propósito: não depende de montagem, não roda
 * duas vezes no `StrictMode` e vive tanto quanto a aba.
 */
const sistemaEscuro = window.matchMedia?.('(prefers-color-scheme: dark)');
sistemaEscuro?.addEventListener?.('change', (evento) => {
  if (readTheme(window.localStorage) !== THEME.SYSTEM) return;
  applyTheme(document.documentElement, resolveTheme(THEME.SYSTEM, evento.matches));
});

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
