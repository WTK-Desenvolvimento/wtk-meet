import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import './styles.css';

// `#root` é criado pelo `index.html`; sem ele não há aplicação para montar, e
// falhar alto aqui é melhor do que uma tela branca sem explicação.
const root = document.getElementById('root');
if (!root) throw new Error('#root não existe no index.html');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
