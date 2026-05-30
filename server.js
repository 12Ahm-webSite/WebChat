const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
  socket.on('join-room', ({ roomId, username }, callback) => {
    const cleanRoomId = String(roomId || '').trim();
    const cleanUsername = String(username || '').trim();

    if (!cleanRoomId || !cleanUsername) {
      if (typeof callback === 'function') {
        callback({
          ok: false,
          error: 'Username and Room ID are required.'
        });
      }
      return;
    }

    leaveCurrentRoom(socket);

    if (!rooms.has(cleanRoomId)) {
      rooms.set(cleanRoomId, new Map());
    }

    const room = rooms.get(cleanRoomId);
    const existingUsers = getRoomUsers(cleanRoomId);

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

  socket.on('media-state', ({ roomId, micEnabled, cameraEnabled }) => {
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

  socket.on('chat-message', ({ roomId, message }) => {
    const cleanMessage = String(message || '').trim();

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

  socket.on('offer', ({ to, offer }) => {
    if (!to || !offer) {
      return;
    }

    socket.to(to).emit('offer', {
      from: socket.id,
      offer
    });
  });

  socket.on('answer', ({ to, answer }) => {
    if (!to || !answer) {
      return;
    }

    socket.to(to).emit('answer', {
      from: socket.id,
      answer
    });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (!to || !candidate) {
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
