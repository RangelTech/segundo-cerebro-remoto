# segundo-cerebro-remoto

Ponte do acesso web do Segundo Cérebro (`https://remoto.rangeltech.net`). O aplicativo desktop ou a máquina virtual do cliente abre um WebSocket de saída até aqui, e o navegador (ou o celular) usa a interface do próprio app através desse túnel.

## Como funciona

1. O host (app ou máquina virtual) conecta em `/ws/maquina` com a chave da conta. A ponte valida a chave no `llm-access` (`/v1/auth/whoami`).
2. O usuário abre o site e entra com e-mail e senha (`/api/entrar`, que chama `/v1/auth/verify` do `llm-access`). A ponte devolve o cookie assinado `sb_web`.
3. `/m/<id>/` serve a interface do app pelo túnel (com cache por máquina, versão e caminho). As chamadas internas viajam em `/ws/web` como mensagens `inv`, `ret` e `ev`.

Limites: resposta acima de 30 MB é recusada, mensagem acima de `MAX_MSG_MB` (40) derruba a conexão, e os canais pesados (modelo de ditado, Whisper) ficam na lista de bloqueados do cliente (`second-brain/remoto.js`).

O que a ponte guarda: só hashes de vínculo em `/data/vinculos.json`. Conversa e arquivo não passam por disco.

## Variáveis

| Variável | Padrão | Função |
|---|---|---|
| `PORT` | 8080 | porta HTTP |
| `ACCESS_URL` | https://qwen.rangeltech.net | endereço do `llm-access` |
| `SESSION_SECRET` | aleatório a cada início | assina o cookie; sem ele as sessões caem a cada reinício |
| `SESSAO_DIAS` | 7 | validade da sessão |
| `MAX_MSG_MB` | 40 | tamanho máximo de mensagem |

## Rodar e testar

```
npm ci && PORT=8787 npm start
npm test
```

## Versão e deploy

`gh workflow run release.yml -f version=vX.Y.Z` publica a imagem e o manifesto. O deploy é só pelo `vps_rt_infra` (`release-intake.yml`, depois `deploy.yml -f service=segundo-cerebro-remoto`). Este repositório não tem credencial da VPS.

Mapa geral do ecossistema: skill `ecossistema_rt` (repositório `personal-skills`) e `MANUAL_ARQUITETURA_RANGELTECH.docx`.
