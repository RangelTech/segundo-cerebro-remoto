# segundo-cerebro-remoto

Ponte do controle remoto do Segundo Cérebro: o computador e o celular abrem WebSocket até aqui e a ponte repassa as mensagens. O celular se vincula lendo um QR code (sem login); a página do celular é servida pela própria ponte.

- Spec: `specs/20_CONTROLE_REMOTO_QR.md` (repositório `luar_docs`/workspace da Rangel Tech).
- O que a ponte guarda: só hashes dos vínculos (`/data/vinculos.json`). Conversa e arquivo não passam por disco.
- Rodar local: `npm ci && PORT=8787 npm start`. Testes: `npm test`.
- Deploy: só pelo `vps_rt_infra` (release com imagem e manifesto, lock e deploy).
