const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_ROOM_ID_LENGTH = 40;
const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_PARTICIPANTS_PER_ROOM = Number(process.env.MAX_PARTICIPANTS_PER_ROOM || 8);
const SOCKET_WINDOW_MS = 10 * 1000;
const SOCKET_LIMITS = {
  join: 8,
  message: 20,
  signal: 80,
  media: 20
};
const rooms = new Map();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  res.json({ iceServers });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sanitizeUsername(username) {
  return String(username || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_USERNAME_LENGTH);
}

function sanitizeRoomId(roomId) {
  return String(roomId || '')
    .trim()
    .slice(0, MAX_ROOM_ID_LENGTH);
}

function sanitizeMessage(message) {
  return String(message || '')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function isValidRoomId(roomId) {
  return /^[a-zA-Z0-9_-]{3,40}$/.test(roomId);
}

function isValidUsername(username) {
  return username.length >= 2 && username.length <= MAX_USERNAME_LENGTH;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRateLimited(socket, bucketName, limit) {
  const now = Date.now();
  const buckets = socket.data.rateBuckets || {};
  const bucket = (buckets[bucketName] || []).filter((timestamp) => now - timestamp < SOCKET_WINDOW_MS);

  if (bucket.length >= limit) {
    buckets[bucketName] = bucket;
    socket.data.rateBuckets = buckets;
    return true;
  }

  bucket.push(now);
  buckets[bucketName] = bucket;
  socket.data.rateBuckets = buckets;
  return false;
}

function callbackError(callback, error) {
  if (typeof callback === 'function') {
    callback({ ok: false, error });
  }
}

function canSignalTo(socket, targetSocketId) {
  const { roomId } = socket.data;

  if (!roomId || !targetSocketId || !rooms.has(roomId)) {
    return false;
  }

  return rooms.get(roomId).has(targetSocketId);
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return [];
  }

  return Array.from(room.entries()).map(([socketId, user]) => ({
    id: socketId,
    username: user.username,
    micEnabled: user.micEnabled,
    cameraEnabled: user.cameraEnabled
  }));
}

function emitParticipants(roomId) {
  io.to(roomId).emit('participants-updated', getRoomUsers(roomId));
}

function leaveCurrentRoom(socket) {
  const { roomId, username } = socket.data;

  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  room.delete(socket.id);
  socket.leave(roomId);

  socket.to(roomId).emit('user-left', {
    userId: socket.id,
    username
  });

  socket.to(roomId).emit('system-message', {
    message: `${username} left the room.`,
    time: new Date().toISOString()
  });

  if (room.size === 0) {
    rooms.delete(roomId);
  } else {
    emitParticipants(roomId);
  }

  socket.data.roomId = null;
  socket.data.username = null;
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username } = {}, callback) => {
    if (isRateLimited(socket, 'join', SOCKET_LIMITS.join)) {
      callbackError(callback, 'Too many join attempts. Please wait a moment.');
      return;
    }

    const cleanRoomId = sanitizeRoomId(roomId);
    const cleanUsername = sanitizeUsername(username);

    if (!isValidUsername(cleanUsername)) {
      callbackError(callback, 'Username must be 2 to 32 characters.');
      return;
    }

    if (!isValidRoomId(cleanRoomId)) {
      callbackError(callback, 'Room ID must be 3 to 40 letters, numbers, dashes, or underscores.');
      return;
    }

    leaveCurrentRoom(socket);

    if (!rooms.has(cleanRoomId)) {
      rooms.set(cleanRoomId, new Map());
    }

    const room = rooms.get(cleanRoomId);
    const existingUsers = getRoomUsers(cleanRoomId);

    if (room.size >= MAX_PARTICIPANTS_PER_ROOM) {
      callbackError(callback, 'This room is full.');
      return;
    }

    room.set(socket.id, {
      username: cleanUsername,
      micEnabled: true,
      cameraEnabled: true,
      joinedAt: Date.now()
    });

    socket.data.roomId = cleanRoomId;
    socket.data.username = cleanUsername;
    socket.join(cleanRoomId);

    if (typeof callback === 'function') {
      callback({
        ok: true,
        roomId: cleanRoomId,
        userId: socket.id,
        users: existingUsers
      });
    }

    socket.to(cleanRoomId).emit('user-joined', {
      userId: socket.id,
      username: cleanUsername,
      micEnabled: true,
      cameraEnabled: true
    });

    io.to(cleanRoomId).emit('system-message', {
      message: `${cleanUsername} joined the room.`,
      time: new Date().toISOString()
    });

    emitParticipants(cleanRoomId);
  });

  socket.on('media-state', ({ roomId, micEnabled, cameraEnabled } = {}) => {
    if (isRateLimited(socket, 'media', SOCKET_LIMITS.media)) {
      return;
    }

    if (!socket.data.roomId || socket.data.roomId !== roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    const user = room.get(socket.id);

    if (!user) {
      return;
    }

    user.micEnabled = Boolean(micEnabled);
    user.cameraEnabled = Boolean(cameraEnabled);

    io.to(roomId).emit('media-state', {
      userId: socket.id,
      micEnabled: user.micEnabled,
      cameraEnabled: user.cameraEnabled
    });

    emitParticipants(roomId);
  });

  socket.on('chat-message', ({ roomId, message } = {}) => {
    if (isRateLimited(socket, 'message', SOCKET_LIMITS.message)) {
      return;
    }

    const cleanMessage = sanitizeMessage(message);

    if (!socket.data.roomId || socket.data.roomId !== roomId || !cleanMessage) {
      return;
    }

    io.to(roomId).emit('chat-message', {
      id: `${Date.now()}-${socket.id}`,
      userId: socket.id,
      username: socket.data.username,
      message: cleanMessage,
      time: new Date().toISOString()
    });
  });

  socket.on('offer', ({ to, offer } = {}) => {
    if (isRateLimited(socket, 'signal', SOCKET_LIMITS.signal)) {
      return;
    }

    if (!canSignalTo(socket, to) || !isPlainObject(offer)) {
      return;
    }

    socket.to(to).emit('offer', {
      from: socket.id,
      offer
    });
  });

  socket.on('answer', ({ to, answer } = {}) => {
    if (isRateLimited(socket, 'signal', SOCKET_LIMITS.signal)) {
      return;
    }

    if (!canSignalTo(socket, to) || !isPlainObject(answer)) {
      return;
    }

    socket.to(to).emit('answer', {
      from: socket.id,
      answer
    });
  });

  socket.on('ice-candidate', ({ to, candidate } = {}) => {
    if (isRateLimited(socket, 'signal', SOCKET_LIMITS.signal)) {
      return;
    }

    if (!canSignalTo(socket, to) || !isPlainObject(candidate)) {
      return;
    }

    socket.to(to).emit('ice-candidate', {
      from: socket.id,
      candidate
    });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`LocalChat is running at http://localhost:${PORT}`);
});
