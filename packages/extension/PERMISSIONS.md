# Por que cada permissão existe

Quatro entradas no `manifest.json`, e cada uma se justifica sozinha. Uma permissão
que o código não usa é uma permissão que ninguém consegue defender numa revisão —
e a lista abaixo é o que se responde quando alguém pergunta.

| Permissão | Quem usa | Para quê |
|---|---|---|
| `offscreen` | `src/background.ts` | Criar o documento offscreen que é **o motor** (`chrome.offscreen.createDocument`). Sem ela não há áudio nenhum. |
| `storage` | `src/lib/storage.ts` | `chrome.storage.local`: favoritos do soundboard (chave `wtk-meet:soundboard`, o mesmo formato do app) e as preferências da extensão (última sala, nome, URL do servidor, volume). |
| `activeTab` | `src/background.ts` (`prefill`) | Ler a URL da aba ativa **no clique no ícone**, para dizer *por que* o campo de sala não foi preenchido quando a aba não é uma reunião. É concedida no ato da invocação e só para aquela aba. |
| `notifications` | `src/background.ts` (`badge`) | Exibir notificação do sistema quando alguém pede para entrar na sala e o popup está fechado. Sem ela o usuário só vê o badge laranja, que pode passar despercebido. |
| `host_permissions: https://meet.google.com/*` | `src/background.ts` (`prefill`) | Ler o código da reunião da aba ativa do Meet mesmo quando `activeTab` não está concedida — é o que garante o pré-preenchimento do campo de id, que é o comportamento central desta entrega. |
| `host_permissions: https://meet.wtk.app/*` | `src/content.ts` | Injetar o content script de sincronização na página do app para compartilhar a lista de favoritos do soundboard entre `localStorage` do app e `chrome.storage.local` da extensão. |
| `host_permissions: https://meet-api.wtk.app/*` | `src/engine/room.ts` | Conectar ao servidor de sinalização padrão (WebSocket + HTTP polling do socket.io). A URL é configurável pelo usuário; esta permissão cobre o servidor de produção da WTK sem exigir `https://*/*`. |

O que **não** está pedido, e por quê:

- **`tabs`** (a permissão ampla): ela daria URL de *todas* as abas, o tempo todo. O
  que a extensão precisa é da aba ativa no clique — que é exatamente o que
  `activeTab` dá.
- **Content script em `meet.google.com`**: nada é injetado na página da Google. O
  código da reunião é lido da URL, e só.
- **`tabCapture`**: capturar o áudio da aba do Meet levaria a voz de quem está na
  reunião para dentro de outra sala. É gravação de terceiros por caminho
  transverso.
- **`optional_host_permissions: *://*/*`**: seria o que faria o MyInstants (que não
  serve CORS) tocar, porque o privilégio de host da extensão dispensa o
  `Access-Control-Allow-Origin` no `fetch`. Ficou **de fora** desta entrega: o
  comportamento combinado é o mesmo do app — URL sem CORS é recusada com mensagem,
  nunca com silêncio. Retomar isso é decisão de produto, e está registrada no
  `ARCHITECTURE.md` §11.8.
