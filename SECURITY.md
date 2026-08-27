# Politica de Seguranca

## Versoes suportadas

| Versao  | Suporte          |
| ------- | ---------------- |
| 1.1.x   | Suporte ativo    |

## Como relatar uma vulnerabilidade

**Nao abra issues publicas para relatar vulnerabilidades de seguranca.**

Utilize um dos canais abaixo:

1. **GitHub Security Advisories** (preferencial):
   <https://github.com/WTK-Desenvolvimento/wtk-meet/security/advisories/new>
2. **E-mail**: [security@wtk.app](mailto:security@wtk.app)

Inclua o maximo de detalhes possivel: passos para reproduzir, impacto estimado e, se houver, sugestao de correcao.

## SLA

- **Resposta inicial**: ate 48 horas.
- **Resolucao**: ate 7 dias uteis apos a confirmacao.

## Escopo

Vulnerabilidades nos seguintes componentes sao consideradas no escopo:

- Sinalizacao WebRTC (servidor de sinalizacao)
- Camada de E2EE (AES-GCM-256)
- Credenciais TURN efemeras
- XSS, injection e problemas similares no cliente

## Fora do escopo

- Vulnerabilidades em dependencias ja reportadas upstream.
- Ataques de engenharia social.

## Reconhecimento

Contribuidores que reportarem vulnerabilidades validas serao creditados no CHANGELOG, caso desejem.
