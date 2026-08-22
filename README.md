# 🔥 PulseCord

Um app simples pra você e seus amigos: chat, chamada de voz/vídeo e
compartilhamento de tela, em salas com código e senha.

## Como rodar

```bash
npm install
npm start
```

Abra `http://localhost:3000` no navegador. Para outra pessoa entrar de outro
computador/rede, você precisa publicar o servidor num endereço acessível por
HTTPS — em `localhost` só funciona na sua própria máquina.

## Como funciona (resumo)

- **Sinalização**: o servidor Node.js só ajuda os navegadores a se
  encontrarem (troca de SDP/ICE via Socket.io). Ele nunca recebe áudio,
  vídeo ou tela.
- **Chamada**: depois que os navegadores se encontram, a mídia viaja
  **direto entre os participantes** (WebRTC, P2P), criptografada
  ponto a ponto por padrão (DTLS-SRTP) — nenhum servidor consegue
  interceptar o conteúdo.
- **Salas**: em memória, nada é salvo em disco. Uma sala some sozinha
  quando todo mundo sai.
- **Senha de sala**: guardada só como hash (bcrypt), nunca em texto puro.
- **Malha (mesh)**: cada participante se conecta diretamente com todos os
  outros. Funciona muito bem para grupos pequenos (o alvo aqui é até ~20
  pessoas).

## O que já tem de segurança

- Senha de sala com hash (bcrypt), nunca armazenada em texto puro
- Rate limiting em criação/entrada de salas (evita força bruta e spam)
- Cabeçalhos de segurança (Helmet: CSP, sem `X-Powered-By`, etc.)
- Sinalização restrita à mesma sala
- Sem persistência: nada de histórico de chat ou gravação fica salvo
- Limite de participantes por sala e expiração automática

## Escopo atual

Este é um app de salas temporárias — sem contas, sem lista de amigos, sem
histórico persistente. Se um dia quiser evoluir pra algo com contas de
usuário, amizades, servidores/canais permanentes e mensagens salvas, isso é
uma reformulação bem maior (banco de dados relacional, autenticação, etc.),
não um ajuste no que já existe.
