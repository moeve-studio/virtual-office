const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

const FALLBACK_ROOMS = [
  { id: 'main', name: 'Hauptraum' },
  { id: 'goldberg', name: 'Projekt Goldbergweg' },
  { id: 'sylt', name: 'Projekt Sylt' },
  { id: 'website', name: 'Website / Marketing' }
];

const state = {
  rooms: [...FALLBACK_ROOMS],
  users: new Map(),
  callSessionsByRoom: new Map()
};

app.use(express.static(path.join(__dirname, 'public')));

function roomName(roomId) {
  return state.rooms.find((room) => room.id === roomId)?.name || roomId;
}

function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `room-${Date.now()}`;
}

function uniqueName(baseName, currentSocketId = null) {
  const normalizedBase = (baseName || 'Gast').trim().slice(0, 32) || 'Gast';
  const activeNames = new Set(
    [...state.users.values()]
      .filter((user) => user.socketId !== currentSocketId && user.entered)
      .map((user) => user.name.toLowerCase())
  );
  if (!activeNames.has(normalizedBase.toLowerCase())) return normalizedBase;
  let index = 2;
  let candidate = `${normalizedBase} ${index}`;
  while (activeNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${normalizedBase} ${index}`;
  }
  return candidate;
}

function getUserPublic(user) {
  return {
    socketId: user.socketId,
    name: user.name,
    avatar: user.avatar,
    status: user.status,
    roomId: user.roomId,
    entered: user.entered,
    onlineSince: user.onlineSince,
    lastSeen: user.lastSeen,
    joinedAt: user.joinedAt,
    currentCallRoomId: user.currentCallRoomId || null,
    media: user.media || { audio: false, video: false }
  };
}

function getPeople() {
  return [...state.users.values()].map(getUserPublic);
}

function getCallSummary(roomId) {
  const session = state.callSessionsByRoom.get(roomId);
  if (!session) return null;
  return {
    roomId: session.roomId,
    startedAt: session.startedAt,
    participants: [...session.participants],
    initiatorId: session.initiatorId
  };
}

function buildSnapshot() {
  return {
    rooms: state.rooms,
    people: getPeople(),
    activeCalls: state.rooms
      .map((room) => getCallSummary(room.id))
      .filter(Boolean)
  };
}

function emitState() {
  io.emit('state:snapshot', buildSnapshot());
}

function ensureRoomExists(roomId) {
  if (state.rooms.some((room) => room.id === roomId)) return;
  state.rooms.push({ id: roomId, name: roomName(roomId) });
}

function leaveSocketRooms(socket, roomIdToKeep) {
  for (const joinedRoomId of socket.rooms) {
    if (joinedRoomId !== socket.id && joinedRoomId !== roomIdToKeep) {
      socket.leave(joinedRoomId);
    }
  }
}

function setCallMembership(socketId, roomId) {
  const user = state.users.get(socketId);
  if (!user) return;
  user.currentCallRoomId = roomId;
  user.status = 'im Gespräch';
}

function clearCallMembership(socketId) {
  const user = state.users.get(socketId);
  if (!user) return;
  user.currentCallRoomId = null;
  if (!user.entered) {
    user.status = 'abwesend';
    return;
  }
  if (user.status === 'im Gespräch') user.status = 'anwesend';
}

function endCallForRoom(roomId) {
  const session = state.callSessionsByRoom.get(roomId);
  if (!session) return;
  session.participants.forEach((socketId) => {
    clearCallMembership(socketId);
    io.to(socketId).emit('call:ended', { roomId });
  });
  state.callSessionsByRoom.delete(roomId);
}

function removeUserFromCalls(socketId) {
  for (const [roomId, session] of state.callSessionsByRoom.entries()) {
    if (!session.participants.has(socketId)) continue;
    session.participants.delete(socketId);
    clearCallMembership(socketId);
    io.to(roomId).emit('call:participant-left', { roomId, socketId });
    if (session.participants.size < 2) {
      endCallForRoom(roomId);
    }
  }
}

io.on('connection', (socket) => {
  socket.on('user:join', (payload = {}) => {
    const roomId = payload.roomId || 'main';
    ensureRoomExists(roomId);
    socket.join(roomId);
    leaveSocketRooms(socket, roomId);

    const user = {
      socketId: socket.id,
      name: uniqueName(payload.name || 'Gast'),
      avatar: String(payload.avatar || '').trim(),
      status: payload.status || 'anwesend',
      roomId,
      entered: true,
      onlineSince: new Date().toISOString(),
      lastSeen: null,
      joinedAt: new Date().toISOString(),
      currentCallRoomId: null,
      media: { audio: false, video: false }
    };
    state.users.set(socket.id, user);
    socket.emit('user:joined', { me: getUserPublic(user) });
    emitState();
  });

  socket.on('user:update-profile', (payload = {}) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    user.name = uniqueName(payload.name || user.name, socket.id);
    user.avatar = String(payload.avatar || user.avatar || '').trim();
    if (!user.currentCallRoomId) {
      user.status = payload.status || user.status;
    }
    emitState();
  });

  socket.on('user:set-status', ({ status }) => {
    const user = state.users.get(socket.id);
    if (!user || user.currentCallRoomId) return;
    user.status = status || user.status;
    emitState();
  });

  socket.on('user:toggle-entry', ({ entered }) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    if (entered) {
      user.entered = true;
      user.lastSeen = null;
      user.onlineSince = new Date().toISOString();
      user.status = 'anwesend';
      socket.join(user.roomId);
    } else {
      user.entered = false;
      user.lastSeen = new Date().toISOString();
      user.status = 'abwesend';
      removeUserFromCalls(socket.id);
    }
    emitState();
  });

  socket.on('room:switch', ({ roomId }) => {
    const user = state.users.get(socket.id);
    if (!user || !roomId || user.currentCallRoomId) return;
    ensureRoomExists(roomId);
    user.roomId = roomId;
    if (user.entered) {
      socket.join(roomId);
      leaveSocketRooms(socket, roomId);
    }
    emitState();
  });

  socket.on('room:create', ({ name }) => {
    const normalizedName = String(name || '').trim().slice(0, 60);
    if (!normalizedName) return;
    const id = slugify(normalizedName);
    if (!state.rooms.some((room) => room.id === id)) {
      state.rooms.push({ id, name: normalizedName });
      emitState();
    }
  });

  socket.on('chat:send', ({ roomId, text }) => {
    const user = state.users.get(socket.id);
    if (!user || !roomId) return;
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      roomId,
      authorId: socket.id,
      author: user.name,
      text: String(text || '').trim().slice(0, 1000),
      ts: new Date().toISOString()
    };
    if (!message.text) return;
    io.to(roomId).emit('chat:message', message);
  });

  socket.on('call:start', ({ targetSocketId, roomId }) => {
    const caller = state.users.get(socket.id);
    const target = state.users.get(targetSocketId);
    if (!caller || !target || !roomId) return;
    if (!caller.entered || !target.entered) return;
    if (caller.roomId !== roomId || target.roomId !== roomId) return;

    const existing = state.callSessionsByRoom.get(roomId);
    if (existing) {
      if (!existing.participants.has(socket.id)) existing.participants.add(socket.id);
      if (!existing.participants.has(targetSocketId)) existing.participants.add(targetSocketId);
      setCallMembership(socket.id, roomId);
      setCallMembership(targetSocketId, roomId);
      io.to(roomId).emit('call:updated', getCallSummary(roomId));
      emitState();
      return;
    }

    const session = {
      roomId,
      startedAt: new Date().toISOString(),
      initiatorId: socket.id,
      participants: new Set([socket.id, targetSocketId])
    };
    state.callSessionsByRoom.set(roomId, session);
    setCallMembership(socket.id, roomId);
    setCallMembership(targetSocketId, roomId);
    io.to(roomId).emit('call:started', getCallSummary(roomId));
    emitState();
  });

  socket.on('call:add-participant', ({ roomId, targetSocketId }) => {
    const session = state.callSessionsByRoom.get(roomId);
    const target = state.users.get(targetSocketId);
    if (!session || !target) return;
    if (!session.participants.has(socket.id)) return;
    if (!target.entered || target.roomId !== roomId) return;
    session.participants.add(targetSocketId);
    setCallMembership(targetSocketId, roomId);
    io.to(roomId).emit('call:updated', getCallSummary(roomId));
    emitState();
  });

  socket.on('call:end', ({ roomId }) => {
    const session = state.callSessionsByRoom.get(roomId);
    if (!session || !session.participants.has(socket.id)) return;
    endCallForRoom(roomId);
    emitState();
  });

  socket.on('webrtc:media-state', ({ roomId, audio, video }) => {
    const user = state.users.get(socket.id);
    if (!user || user.currentCallRoomId !== roomId) return;
    user.media = { audio: !!audio, video: !!video };
    io.to(roomId).emit('webrtc:media-state', {
      socketId: socket.id,
      roomId,
      media: user.media
    });
    emitState();
  });

  socket.on('webrtc:signal', ({ roomId, targetSocketId, description, candidate }) => {
    const session = state.callSessionsByRoom.get(roomId);
    if (!session || !session.participants.has(socket.id) || !session.participants.has(targetSocketId)) return;
    io.to(targetSocketId).emit('webrtc:signal', {
      roomId,
      sourceSocketId: socket.id,
      description: description || null,
      candidate: candidate || null
    });
  });

  socket.on('disconnect', () => {
    removeUserFromCalls(socket.id);
    state.users.delete(socket.id);
    emitState();
  });
});

server.listen(PORT, () => {
  console.log(`Virtual Office v0.3 läuft auf http://localhost:${PORT}`);
});
