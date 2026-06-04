const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_ROOM_ID_LENGTH = 40;
const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_ROOM_PASSWORD_LENGTH = 128;
const MAX_PARTICIPANTS_PER_ROOM = Number(process.env.MAX_PARTICIPANTS_PER_ROOM || 8);
const SOCKET_WINDOW_MS = 10 * 1000;
const SOCKET_LIMITS = {
  join: 8,
  message: 20,
  signal: 80,
  media: 20
};
const rooms = new Map();

const PREDEFINED_ROOMS = [
  { id: 'عامة', name: 'عامة', description: 'للدردشة العامة والنقاشات', icon: '🌐' },
  { id: 'تقنية', name: 'تقنية', description: 'للمواضيع التقنية والبرمجة', icon: '💻' },
  { id: 'ترفيه', name: 'ترفيه', description: 'للترفيه والألعاب', icon: '🎮' }
];

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
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

// Generate temporary TURN credentials using HMAC-SHA1
function generateTurnCredentials(secret, ttl) {
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = `${timestamp}:localchat`;
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(username);
  const credential = hmac.digest('base64');
  return { username, credential };
}

function getTurnUrls() {
  const rawUrls = process.env.TURN_URLS || process.env.TURN_URL || '';
  return rawUrls
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

app.get('/api/ice-servers', (req, res) => {
  const turnUrls = getTurnUrls();
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  // Temporary TURN credentials (preferred)
  if (process.env.TURN_SECRET && turnUrls.length > 0) {
    const ttl = 86400; // 24 hours
    const { username, credential } = generateTurnCredentials(process.env.TURN_SECRET, ttl);
    iceServers.push({
      urls: turnUrls,
      username,
      credential
    });
  }
  // Static TURN credentials (fallback)
  else if (turnUrls.length > 0 && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  // Free public TURN servers as last-resort fallback
  // These ensure WebRTC works across different networks even without a custom TURN config
  const hasTurn = iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
  });

  if (!hasTurn) {
    // OpenRelay free TURN servers (metered.ca public project)
    iceServers.push(
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turns:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    );
    console.log('ℹ️  No TURN server configured — using free public relay (OpenRelay).');
    console.log('   For better performance, set TURN_URLS and TURN_SECRET in .env');
  }

  res.json({
    iceServers,
    turnConfigured: iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
    })
  });
});

app.get('/api/rooms', (req, res) => {
  const roomList = PREDEFINED_ROOMS.map((predefined) => {
    const room = rooms.get(predefined.id);
    return {
      id: predefined.id,
      name: predefined.name,
      description: predefined.description,
      icon: predefined.icon,
      participants: room ? room.users.size : 0,
      hasPassword: room ? Boolean(room.passwordRecord) : false
    };
  });
  res.json({ rooms: roomList });
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

function sanitizePassword(password) {
  return String(password || '')
    .trim()
    .slice(0, MAX_ROOM_PASSWORD_LENGTH);
}

function createPasswordRecord(password) {
  if (!password) {
    return null;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, passwordRecord) {
  if (!passwordRecord) {
    return true;
  }

  if (!password) {
    return false;
  }

  const hash = crypto.pbkdf2Sync(password, passwordRecord.salt, 100000, 32, 'sha256');
  const storedHash = Buffer.from(passwordRecord.hash, 'hex');

  if (hash.length !== storedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(hash, storedHash);
}

function isValidRoomId(roomId) {
  // Allow Arabic, Latin, numbers, dashes, underscores (3-40 chars)
  return /^[\u0600-\u06FFa-zA-Z0-9_-]{2,40}$/.test(roomId);
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

  return rooms.get(roomId).users.has(targetSocketId);
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return [];
  }

  return Array.from(room.users.entries()).map(([socketId, user]) => ({
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
  room.users.delete(socket.id);
  socket.leave(roomId);

  socket.to(roomId).emit('user-left', {
    userId: socket.id,
    username
  });

  socket.to(roomId).emit('system-message', {
    message: `${username} غادر الغرفة.`,
    time: new Date().toISOString()
  });

  if (room.users.size === 0) {
    rooms.delete(roomId);
  } else {
    emitParticipants(roomId);
  }

  socket.data.roomId = null;
  socket.data.username = null;
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username, password } = {}, callback) => {
    if (isRateLimited(socket, 'join', SOCKET_LIMITS.join)) {
      callbackError(callback, 'محاولات كثيرة. انتظر لحظة.');
      return;
    }

    const cleanRoomId = sanitizeRoomId(roomId);
    const cleanUsername = sanitizeUsername(username);
    const cleanPassword = sanitizePassword(password);

    if (!isValidUsername(cleanUsername)) {
      callbackError(callback, 'اسم المستخدم يجب أن يكون من 2 إلى 32 حرف.');
      return;
    }

    if (!isValidRoomId(cleanRoomId)) {
      callbackError(callback, 'اسم الغرفة غير صالح.');
      return;
    }

    leaveCurrentRoom(socket);

    // Check if room exists and validate password
    if (rooms.has(cleanRoomId)) {
      const existingRoom = rooms.get(cleanRoomId);
      if (!verifyPassword(cleanPassword, existingRoom.passwordRecord)) {
        callbackError(callback, 'كلمة المرور غير صحيحة.');
        return;
      }
    }

    if (!rooms.has(cleanRoomId)) {
      rooms.set(cleanRoomId, {
        users: new Map(),
        passwordRecord: createPasswordRecord(cleanPassword),
        createdAt: Date.now()
      });
    }

    const room = rooms.get(cleanRoomId);
    const existingUsers = getRoomUsers(cleanRoomId);

    if (room.users.size >= MAX_PARTICIPANTS_PER_ROOM) {
      callbackError(callback, 'الغرفة ممتلئة.');
      return;
    }

    room.users.set(socket.id, {
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
      message: `${cleanUsername} انضم للغرفة.`,
      time: new Date().toISOString()
    });

    emitParticipants(cleanRoomId);
  });

  // E2E key exchange: broadcast public key to room
  socket.on('public-key', ({ roomId, publicKey } = {}) => {
    if (!socket.data.roomId || socket.data.roomId !== roomId) {
      return;
    }
    socket.to(roomId).emit('public-key', {
      userId: socket.id,
      publicKey
    });
  });

  // E2E key exchange: forward encrypted shared key
  socket.on('key-exchange', ({ to, encryptedKey } = {}) => {
    if (!socket.data.roomId || !canSignalTo(socket, to)) {
      return;
    }
    socket.to(to).emit('key-exchange', {
      from: socket.id,
      encryptedKey
    });
  });

  socket.on('media-state', ({ roomId, micEnabled, cameraEnabled } = {}) => {
    if (isRateLimited(socket, 'media', SOCKET_LIMITS.media)) {
      return;
    }

    if (!socket.data.roomId || socket.data.roomId !== roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    const user = room.users.get(socket.id);

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

  socket.on('chat-message', ({ roomId, message, encrypted, iv } = {}) => {
    if (isRateLimited(socket, 'message', SOCKET_LIMITS.message)) {
      return;
    }

    const cleanMessage = encrypted ? message : sanitizeMessage(message);

    if (!socket.data.roomId || socket.data.roomId !== roomId || !cleanMessage) {
      return;
    }

    io.to(roomId).emit('chat-message', {
      id: `${Date.now()}-${socket.id}`,
      userId: socket.id,
      username: socket.data.username,
      message: cleanMessage,
      encrypted: Boolean(encrypted),
      iv: iv || null,
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
