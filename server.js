// PulseCord — servidor de sinalização
//
// Este servidor NUNCA vê ou transporta áudio/vídeo/tela dos usuários.
// Ele só ajuda dois navegadores a se encontrarem (sinalização WebRTC);
// depois disso a chamada é peer-to-peer e criptografada (DTLS-SRTP,
// obrigatório no padrão WebRTC — nenhum servidor consegue "ouvir" a ligação).

const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { customAlphabet } = require('nanoid');

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
});

app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'stun:', 'turn:', 'turns:'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Sala em memória (nada é gravado em disco / banco de dados) ---
const rooms = new Map();
const MAX_MEMBERS_PER_ROOM = 20;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;

function pruneRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const empty = room.members.size === 0 && now - room.lastActive > 60_000;
    const expired = now - room.createdAt > ROOM_TTL_MS;
    if (empty || expired) rooms.delete(code);
  }
}
setInterval(pruneRooms, 30_000);

const createRoomLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 30,
  validate: { trustProxy: false, xForwardedForHeader: false },
});
const joinRoomLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  validate: { trustProxy: false, xForwardedForHeader: false },
});

app.post('/api/rooms', createRoomLimiter, async (req, res) => {
  const { password, name } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || name.length > 40)) {
    return res.status(400).json({ error: 'Nome inválido.' });
  }
  if (password !== undefined && typeof password !== 'string') {
    return res.status(400).json({ error: 'Senha inválida.' });
  }

  let code;
  do {
    code = nanoid();
  } while (rooms.has(code));

  const passwordHash = password ? await bcrypt.hash(password.slice(0, 100), 10) : null;

  rooms.set(code, {
    code,
    name: (name && name.trim()) || 'Sala sem nome',
    passwordHash,
    createdAt: Date.now(),
    lastActive: Date.now(),
    members: new Map(),
  });

  res.json({ code });
});

app.post('/api/rooms/:code/check', joinRoomLimiter, async (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.status(404).json({ error: 'Sala não encontrada.' });
  if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
    return res.status(403).json({ error: 'Sala cheia.' });
  }
  if (room.passwordHash) {
    const ok = await bcrypt.compare(String(req.body?.password || ''), room.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Senha incorreta.' });
  }
  res.json({ ok: true, name: room.name, hasPassword: !!room.passwordHash });
});

app.get('/api/turn-credentials', joinRoomLimiter, async (req, res) => {
  const domain = process.env.METERED_DOMAIN;
  const apiKey = process.env.METERED_API_KEY;
  if (!domain || !apiKey) {
    return res.status(200).json([]);
  }
  try {
    const meteredRes = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${apiKey}`);
    if (!meteredRes.ok) throw new Error(`Metered respondeu ${meteredRes.status}`);
    const servers = await meteredRes.json();
    res.json(servers);
  } catch (err) {
    console.error('Falha ao buscar credenciais TURN do Metered:', err.message);
    res.status(200).json([]);
  }
});

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join-room', ({ code, displayName } = {}) => {
    code = String(code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('error-message', 'Essa sala não existe mais.');
    if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
      return socket.emit('error-message', 'Essa sala está cheia.');
    }

    const safeName = String(displayName || 'Amigo').slice(0, 24) || 'Amigo';
    const existingIds = [...room.members.keys()];

    room.members.set(socket.id, { name: safeName });
    room.lastActive = Date.now();
    joinedRoom = code;
    socket.join(code);

    socket.emit('joined', {
      selfId: socket.id,
      roomName: room.name,
      peers: existingIds.map((id) => ({ id, name: room.members.get(id).name })),
    });

    socket.to(code).emit('peer-joined', { id: socket.id, name: safeName });
  });

  socket.on('signal', ({ to, data } = {}) => {
    if (!joinedRoom || !to || !data) return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.members.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat-message', ({ text } = {}) => {
    if (!joinedRoom || typeof text !== 'string' || !text.trim()) return;
    const room = rooms.get(joinedRoom);
    const member = room?.members.get(socket.id);
    if (!room || !member) return;
    room.lastActive = Date.now();
    io.to(joinedRoom).emit('chat-message', {
      from: socket.id,
      name: member.name,
      text: text.slice(0, 500),
      at: Date.now(),
    });
  });

  socket.on('screen-share-state', ({ sharing } = {}) => {
    if (!joinedRoom) return;
    socket.to(joinedRoom).emit('screen-share-state', { id: socket.id, sharing: !!sharing });
  });

  // Relay de midia: recebe binario e repassa pra sala (fallback quando WebRTC falha)
  socket.on('relay-media', ({ type, data } = {}) => {
    if (!joinedRoom || !type || !data) return;
    socket.to(joinedRoom).emit('relay-media', { from: socket.id, type, data });
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.members.delete(socket.id);
    room.lastActive = Date.now();
    socket.to(joinedRoom).emit('peer-left', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔥 PulseCord rodando em http://localhost:${PORT}`);
});
