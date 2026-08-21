# 🔥 Fogueira

Um app simples pra você e seus amigos: chat, chamada de voz/vídeo e
compartilhamento de tela, em salas com código e senha.

## Como rodar

```bash
npm install
npm start
```

Abra `http://localhost:3000` no navegador. Para outra pessoa entrar de outro
computador/rede, você precisa publicar o servidor num endereço acessível por
HTTPS (veja "Colocando no ar" abaixo) — em `localhost` só funciona na sua
própria máquina.

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
  pessoas). Passando bastante disso, o ideal seria um SFU (servidor de
  mídia) — um projeto bem maior.

## O que já tem de segurança

- Senha de sala com hash (bcrypt), nunca armazenada em texto puro
- Rate limiting em criação/entrada de salas (evita força bruta e spam)
- Cabeçalhos de segurança (Helmet: CSP, sem `X-Powered-By`, etc.)
- Sinalização restrita à mesma sala (não dá pra "espiar" outra sala)
- Sem persistência: nada de histórico de chat ou gravação fica salvo
- Limite de participantes por sala e expiração automática

## O que falta se você quiser algo "de verdade" em produção

Sendo honesto, para ficar robusto o suficiente para uso mais sério, ainda
faltaria:

- **HTTPS obrigatório** (getUserMedia/getDisplayMedia exigem HTTPS fora de
  `localhost`) — normalmente resolvido com um proxy tipo Caddy/Nginx +
  Let's Encrypt, ou hospedando em algo como Render/Fly.io/Railway.
- **Servidor TURN** (ex.: coturn) para garantir conexão mesmo em redes com
  NAT/firewall restritivo — sem TURN, uma fração das conexões pode falhar.
- Login/identidade real, se quiser mais controle de quem entra além da
  senha da sala.
- Testes automatizados e monitoramento, se for algo usado com frequência.

## Colocando no ar

A forma mais simples: um serviço com HTTPS automático (Render, Railway,
Fly.io) apontando pro `npm start`. Depois é só compartilhar o link com o
código da sala (ou o botão "Copiar convite" já gera esse link).
