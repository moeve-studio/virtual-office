const fallbackAvatar = 'data:image/svg+xml;utf8,' + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
  <rect width="80" height="80" rx="40" fill="#2a3140"/>
  <circle cx="40" cy="30" r="14" fill="#8bb8ff"/>
  <path d="M20 64c4-12 16-18 20-18s16 6 20 18" fill="#8bb8ff"/>
</svg>`);

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const state = {
  socket: null,
  me: null,
  rooms: [],
  people: [],
  activeCalls: [],
  currentRoomId: 'main',
  entered: true,
  chatByRoom: {},
  roomPositions: {},
  peerConnections: new Map(),
  remoteStreams: new Map(),
  localStream: null,
  call: {
    roomId: null,
    participants: []
  },
  media: {
    audio: true,
    video: false
  },
  mediaStatus: 'Noch kein Mikrofon/Kamera-Zugriff angefordert.'
};

const el = {
  roomList: document.getElementById('roomList'),
  officeCanvas: document.getElementById('officeCanvas'),
  occupancyOverview: document.getElementById('occupancyOverview'),
  whoWhereText: document.getElementById('whoWhereText'),
  lastActionText: document.getElementById('lastActionText'),
  currentRoomTitle: document.getElementById('currentRoomTitle'),
  currentRoomMeta: document.getElementById('currentRoomMeta'),
  displayName: document.getElementById('displayName'),
  avatarUrl: document.getElementById('avatarUrl'),
  presenceStatus: document.getElementById('presenceStatus'),
  updateProfileBtn: document.getElementById('updateProfileBtn'),
  addRoomBtn: document.getElementById('addRoomBtn'),
  newRoomName: document.getElementById('newRoomName'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  sendChatBtn: document.getElementById('sendChatBtn'),
  enterLeaveBtn: document.getElementById('enterLeaveBtn'),
  personTemplate: document.getElementById('personTemplate'),
  callPanel: document.getElementById('callPanel'),
  connectionBadge: document.getElementById('connectionBadge')
};

function fmtTime(dateLike) {
  if (!dateLike) return '—';
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(dateLike));
}

function minutesSince(dateLike) {
  if (!dateLike) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(dateLike).getTime()) / 60000));
}

function roomName(roomId) {
  return state.rooms.find((room) => room.id === roomId)?.name || roomId;
}

function statusClass(status) {
  if (status === 'anwesend') return 'present';
  if (status === 'snooze') return 'snooze';
  if (status === 'im Gespräch') return 'talking';
  return 'away';
}

function getMe() {
  return state.people.find((person) => person.socketId === state.me?.socketId) || state.me;
}

function getPerson(socketId) {
  return state.people.find((person) => person.socketId === socketId) || null;
}

function getCurrentCall() {
  return state.activeCalls.find((call) => call.roomId === state.currentRoomId) || null;
}

function ensureRoomPositions(roomId, visiblePeople) {
  state.roomPositions[roomId] ||= {};
  visiblePeople.forEach((person, index) => {
    if (!state.roomPositions[roomId][person.socketId]) {
      state.roomPositions[roomId][person.socketId] = {
        x: 40 + (index % 4) * 190,
        y: 40 + Math.floor(index / 4) * 180
      };
    }
  });
}

function setLastAction(text) {
  el.lastActionText.textContent = text;
}

function updateConnectionBadge(online) {
  el.connectionBadge.textContent = online ? 'verbunden' : 'offline';
  el.connectionBadge.className = `badge ${online ? 'online' : 'offline'}`;
}

function renderRooms() {
  el.roomList.innerHTML = '';
  state.rooms.forEach((room) => {
    const count = state.people.filter((person) => person.roomId === room.id && person.entered).length;
    const item = document.createElement('div');
    item.className = `room-item ${room.id === state.currentRoomId ? 'active' : ''}`;
    const call = state.activeCalls.find((entry) => entry.roomId === room.id);
    item.innerHTML = `
      <div>
        <strong>${room.name}</strong>
        <small>${count} online${call ? ' · Call aktiv' : ''}</small>
      </div>
      <span>→</span>
    `;
    item.onclick = () => switchRoom(room.id);
    el.roomList.appendChild(item);
  });
}

function renderOffice() {
  el.officeCanvas.innerHTML = '';
  const currentPeople = state.people.filter((person) => person.roomId === state.currentRoomId);
  ensureRoomPositions(state.currentRoomId, currentPeople);

  currentPeople.forEach((person) => {
    const node = el.personTemplate.content.firstElementChild.cloneNode(true);
    const position = state.roomPositions[state.currentRoomId][person.socketId];
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
    const img = node.querySelector('.avatar');
    img.src = person.avatar || fallbackAvatar;
    node.querySelector('.status-badge').classList.add(statusClass(person.status));
    node.querySelector('.person-name').textContent = person.name;

    const onlineText = person.entered
      ? `${person.status} · seit ${minutesSince(person.onlineSince)} min`
      : `zuletzt da ${fmtTime(person.lastSeen)}`;
    node.querySelector('.person-sub').textContent = onlineText;

    const callBtn = node.querySelector('.call-btn');
    const isMe = person.socketId === state.me?.socketId;
    callBtn.textContent = isMe ? 'Ich' : 'Anrufen';
    callBtn.disabled = isMe || !person.entered || !!(state.call.roomId && state.call.roomId !== state.currentRoomId);
    callBtn.onclick = () => startCall(person.socketId);
    el.officeCanvas.appendChild(node);
  });

  el.currentRoomTitle.textContent = roomName(state.currentRoomId);
  const visibleNow = currentPeople.filter((person) => person.entered).length;
  el.currentRoomMeta.textContent = `${visibleNow} sichtbar in diesem Raum`;
}

function renderOccupancy() {
  el.occupancyOverview.innerHTML = '';
  state.rooms.forEach((room) => {
    const peopleInRoom = state.people.filter((person) => person.roomId === room.id);
    const activeNames = peopleInRoom.filter((person) => person.entered).map((person) => person.name);
    const recentNames = peopleInRoom.filter((person) => !person.entered && person.lastSeen).map((person) => `${person.name} (${fmtTime(person.lastSeen)})`);
    const row = document.createElement('div');
    row.className = 'occupancy-row';
    row.innerHTML = `
      <div>
        <strong>${room.name}</strong>
        <small>${activeNames.join(', ') || 'niemand online'}</small>
        ${recentNames.length ? `<small>zuletzt: ${recentNames.join(', ')}</small>` : ''}
      </div>
      <span>${activeNames.length}</span>
    `;
    el.occupancyOverview.appendChild(row);
  });
  el.whoWhereText.textContent = state.rooms
    .map((room) => `${room.name}: ${state.people.filter((person) => person.roomId === room.id && person.entered).length}`)
    .join(' · ');
}

function renderChat() {
  const roomMessages = state.chatByRoom[state.currentRoomId] || [];
  el.chatMessages.innerHTML = '';
  roomMessages.forEach((msg) => {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<strong>${msg.author}</strong><div>${escapeHtml(msg.text)}</div><small>${fmtTime(msg.ts)}</small>`;
    el.chatMessages.appendChild(div);
  });
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function participantNames(call) {
  return call.participants
    .map((socketId) => getPerson(socketId)?.name)
    .filter(Boolean);
}

function mediaStatusText() {
  return escapeHtml(state.mediaStatus || 'Bereit');
}

function renderCall() {
  const call = getCurrentCall();
  if (!call) {
    state.call = { roomId: null, participants: [] };
    el.callPanel.className = 'call-panel empty';
    el.callPanel.innerHTML = `<div><strong>Kein aktives Gespräch</strong></div><div class="note">${mediaStatusText()}</div>`;
    return;
  }

  state.call = {
    roomId: call.roomId,
    participants: call.participants
  };

  const participants = call.participants.map((id) => getPerson(id)).filter(Boolean);
  const available = state.people.filter((person) => (
    person.roomId === state.currentRoomId &&
    person.entered &&
    !call.participants.includes(person.socketId)
  ));

  el.callPanel.className = 'call-panel';
  el.callPanel.innerHTML = `
    <div><strong>Aktiver Call</strong></div>
    <div>${participantNames(call).map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join(' ')}</div>
    <div class="media-actions">
      <button id="toggleAudioBtn" class="btn small">${state.media.audio ? 'Mikro an' : 'Mikro aus'}</button>
      <button id="toggleVideoBtn" class="btn small">${state.media.video ? 'Video an' : 'Video aus'}</button>
      <button id="refreshMediaBtn" class="btn small">Medien neu laden</button>
      <button id="endCallBtn" class="btn small primary">Call beenden</button>
    </div>
    <div class="participant-actions">
      ${available.map((person) => `<button class="btn small add-call" data-id="${person.socketId}">${escapeHtml(person.name)} hinzufügen</button>`).join('') || '<span class="note">Keine weiteren Personen im Raum.</span>'}
    </div>
    <div id="videoGrid" class="video-grid"></div>
    <div class="note">${mediaStatusText()}</div>
    <div class="note">Für Audio sauber mit zwei echten Geräten testen, nicht mit zwei Tabs auf demselben Gerät.</div>
  `;

  el.callPanel.querySelector('#toggleAudioBtn').onclick = () => toggleAudio();
  el.callPanel.querySelector('#toggleVideoBtn').onclick = () => toggleVideo();
  el.callPanel.querySelector('#refreshMediaBtn').onclick = () => refreshMedia();
  el.callPanel.querySelector('#endCallBtn').onclick = () => endCall();
  el.callPanel.querySelectorAll('.add-call').forEach((btn) => {
    btn.onclick = () => addToCall(btn.dataset.id);
  });

  renderVideoTiles(participants);
}

function renderVideoTiles(participants) {
  const grid = document.getElementById('videoGrid');
  if (!grid) return;
  grid.innerHTML = '';

  participants.forEach((person) => {
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;

    if (person.socketId === state.me?.socketId) {
      video.muted = true;
      if (state.localStream) video.srcObject = state.localStream;
    } else if (state.remoteStreams.has(person.socketId)) {
      video.srcObject = state.remoteStreams.get(person.socketId);
    }

    const label = document.createElement('div');
    label.className = 'video-label';
    const mediaLabel = person.media?.video ? 'Video' : 'Avatar';
    label.textContent = `${person.name} · ${mediaLabel}`;
    tile.appendChild(video);
    tile.appendChild(label);
    grid.appendChild(tile);
  });
}

function render() {
  renderRooms();
  renderOffice();
  renderOccupancy();
  renderChat();
  renderCall();
  syncFormWithMe();
}

function syncFormWithMe() {
  const me = getMe();
  if (!me) return;
  if (document.activeElement !== el.displayName) el.displayName.value = me.name || '';
  if (document.activeElement !== el.avatarUrl) el.avatarUrl.value = me.avatar || '';
  el.presenceStatus.value = me.status === 'im Gespräch' ? 'anwesend' : me.status;
  el.enterLeaveBtn.textContent = me.entered ? 'Raum verlassen' : 'Raum betreten';
}

function switchRoom(roomId) {
  if (state.call.roomId) {
    setLastAction('Raumwechsel während eines Calls gesperrt');
    return;
  }
  state.currentRoomId = roomId;
  state.socket.emit('room:switch', { roomId });
  setLastAction(`Raum gewechselt: ${roomName(roomId)}`);
  render();
}

function updateProfile() {
  state.socket.emit('user:update-profile', {
    name: el.displayName.value.trim(),
    avatar: el.avatarUrl.value.trim(),
    status: el.presenceStatus.value
  });
  if (!state.call.roomId) {
    state.socket.emit('user:set-status', { status: el.presenceStatus.value });
  }
  setLastAction('Profil aktualisiert');
}

function togglePresence() {
  const me = getMe();
  if (!me) return;
  if (state.call.roomId && me.entered) {
    setLastAction('Während eines Calls nicht verlassen');
    return;
  }
  const nextEntered = !me.entered;
  state.socket.emit('user:toggle-entry', { entered: nextEntered });
  setLastAction(nextEntered ? 'Raum betreten' : 'Raum verlassen');
}

function addRoom() {
  const name = el.newRoomName.value.trim();
  if (!name) return;
  state.socket.emit('room:create', { name });
  el.newRoomName.value = '';
  setLastAction(`Raum angelegt: ${name}`);
}

function sendChat() {
  const text = el.chatInput.value.trim();
  if (!text) return;
  state.socket.emit('chat:send', { roomId: state.currentRoomId, text });
  el.chatInput.value = '';
}

function startCall(targetSocketId) {
  state.socket.emit('call:start', {
    roomId: state.currentRoomId,
    targetSocketId
  });
  setLastAction('Gespräch angefragt');
}

function addToCall(targetSocketId) {
  state.socket.emit('call:add-participant', {
    roomId: state.currentRoomId,
    targetSocketId
  });
}

function stopAndClearLocalMedia() {
  if (!state.localStream) return;
  state.localStream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch (error) {
      console.warn('Track konnte nicht gestoppt werden', error);
    }
  });
  state.localStream = null;
}

async function ensureLocalMedia({ force = false } = {}) {
  if (force) stopAndClearLocalMedia();
  if (state.localStream) return state.localStream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true
    });
    state.localStream = stream;
    state.mediaStatus = 'Mikrofon und Kamera erfolgreich verbunden.';
    applyTrackStates();
    return stream;
  } catch (error) {
    state.mediaStatus = 'Browser blockiert Mikrofon oder Kamera.';
    renderCall();
    throw error;
  }
}

function applyTrackStates() {
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !!state.media.audio;
    });
    state.localStream.getVideoTracks().forEach((track) => {
      track.enabled = !!state.media.video;
    });
    const audioReady = state.localStream.getAudioTracks().length > 0;
    const videoReady = state.localStream.getVideoTracks().length > 0;
    state.mediaStatus = `Mikro ${audioReady ? (state.media.audio ? 'an' : 'aus') : 'fehlt'} · Video ${videoReady ? (state.media.video ? 'an' : 'aus') : 'fehlt'}`;
  }
  if (state.call.roomId) {
    state.socket.emit('webrtc:media-state', {
      roomId: state.call.roomId,
      audio: state.media.audio,
      video: state.media.video
    });
  }
}

async function toggleAudio() {
  try {
    await ensureLocalMedia();
    state.media.audio = !state.media.audio;
    applyTrackStates();
    renderCall();
  } catch (error) {
    setLastAction('Mikrofon konnte nicht aktiviert werden');
  }
}

async function toggleVideo() {
  try {
    await ensureLocalMedia();
    state.media.video = !state.media.video;
    applyTrackStates();
    renderCall();
  } catch (error) {
    setLastAction('Video konnte nicht aktiviert werden');
  }
}

async function refreshMedia() {
  try {
    await ensureLocalMedia({ force: true });
    teardownPeers({ preserveLocalMedia: true });
    const currentCall = getCurrentCall();
    if (currentCall && currentCall.participants.includes(state.me?.socketId)) {
      await setupPeersForCall(currentCall, { forceMediaRefresh: false });
    }
    renderCall();
    setLastAction('Mikrofon und Kamera neu geladen');
  } catch (error) {
    setLastAction('Medien konnten nicht neu geladen werden');
  }
}

async function setupPeersForCall(call, { forceMediaRefresh = false } = {}) {
  try {
    if (forceMediaRefresh) {
      teardownPeers({ preserveLocalMedia: false });
    }
    await ensureLocalMedia({ force: forceMediaRefresh });
  } catch (error) {
    setLastAction('Medienfreigabe abgelehnt');
    console.error(error);
    return;
  }

  call.participants
    .filter((socketId) => socketId !== state.me?.socketId)
    .forEach((socketId) => createPeerConnection(socketId, true));

  state.socket.emit('webrtc:media-state', {
    roomId: call.roomId,
    audio: state.media.audio,
    video: state.media.video
  });
}

function teardownPeers({ preserveLocalMedia = false } = {}) {
  state.peerConnections.forEach((pc) => {
    try {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.getSenders?.().forEach((sender) => {
        try {
          pc.removeTrack?.(sender);
        } catch (error) {
          // ignore
        }
      });
      pc.close();
    } catch (error) {
      console.warn('Peer konnte nicht sauber geschlossen werden', error);
    }
  });
  state.peerConnections.clear();
  state.remoteStreams.clear();
  if (!preserveLocalMedia) {
    stopAndClearLocalMedia();
    state.mediaStatus = 'Gespräch beendet. Mikrofon und Kamera freigegeben.';
  }
}

function createPeerConnection(remoteSocketId, shouldCreateOffer) {
  if (state.peerConnections.has(remoteSocketId)) return state.peerConnections.get(remoteSocketId);
  const pc = new RTCPeerConnection(rtcConfig);
  state.peerConnections.set(remoteSocketId, pc);

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, state.localStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate || !state.call.roomId) return;
    state.socket.emit('webrtc:signal', {
      roomId: state.call.roomId,
      targetSocketId: remoteSocketId,
      candidate: event.candidate
    });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    state.remoteStreams.set(remoteSocketId, stream);
    renderCall();
  };

  pc.onconnectionstatechange = () => {
    if (['closed', 'disconnected', 'failed'].includes(pc.connectionState)) {
      pc.close();
      state.peerConnections.delete(remoteSocketId);
      state.remoteStreams.delete(remoteSocketId);
      renderCall();
    }
  };

  if (shouldCreateOffer) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        state.socket.emit('webrtc:signal', {
          roomId: state.call.roomId,
          targetSocketId: remoteSocketId,
          description: pc.localDescription
        });
      })
      .catch((error) => console.error(error));
  }

  return pc;
}

async function handleSignal({ sourceSocketId, description, candidate }) {
  const pc = createPeerConnection(sourceSocketId, false);
  try {
    if (description) {
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        state.socket.emit('webrtc:signal', {
          roomId: state.call.roomId,
          targetSocketId: sourceSocketId,
          description: pc.localDescription
        });
      }
    }
    if (candidate) {
      await pc.addIceCandidate(candidate);
    }
  } catch (error) {
    console.error(error);
  }
}

function endCall() {
  if (!state.call.roomId) return;
  const roomId = state.call.roomId;
  teardownPeers();
  state.socket.emit('call:end', { roomId });
}

function handleCallEnded(roomId = null) {
  teardownPeers();
  state.activeCalls = state.activeCalls.filter((call) => call.roomId !== roomId);
  state.call = { roomId: null, participants: [] };
  renderCall();
  setLastAction('Gespräch beendet');
}

function connect() {
  state.socket = io();

  state.socket.on('connect', () => {
    updateConnectionBadge(true);
    state.socket.emit('user:join', {
      name: el.displayName.value.trim() || 'Gast',
      avatar: el.avatarUrl.value.trim(),
      status: el.presenceStatus.value,
      roomId: state.currentRoomId
    });
  });

  state.socket.on('disconnect', () => {
    updateConnectionBadge(false);
    teardownPeers();
  });

  state.socket.on('user:joined', ({ me }) => {
    state.me = me;
    setLastAction(`Eingeloggt als ${me.name}`);
    render();
  });

  state.socket.on('state:snapshot', (snapshot) => {
    state.rooms = snapshot.rooms;
    state.people = snapshot.people;
    state.activeCalls = snapshot.activeCalls;
    const myRecord = getMe();
    if (myRecord) {
      state.me = myRecord;
      state.currentRoomId = myRecord.roomId || state.currentRoomId;
      state.entered = myRecord.entered;
    }
    render();
  });

  state.socket.on('chat:message', (message) => {
    state.chatByRoom[message.roomId] ||= [];
    state.chatByRoom[message.roomId].push(message);
    if (message.roomId === state.currentRoomId) renderChat();
    setLastAction(`Nachricht von ${message.author}`);
  });

  state.socket.on('call:started', async (call) => {
    state.activeCalls = [...state.activeCalls.filter((entry) => entry.roomId !== call.roomId), call];
    render();
    if (call.participants.includes(state.me?.socketId)) {
      state.call = { roomId: call.roomId, participants: call.participants };
      await setupPeersForCall(call, { forceMediaRefresh: true });
      render();
      setLastAction('Gespräch gestartet');
    }
  });

  state.socket.on('call:updated', async (call) => {
    state.activeCalls = [...state.activeCalls.filter((entry) => entry.roomId !== call.roomId), call];
    render();
    if (call.participants.includes(state.me?.socketId)) {
      state.call = { roomId: call.roomId, participants: call.participants };
      await setupPeersForCall(call, { forceMediaRefresh: false });
      render();
      setLastAction('Gespräch aktualisiert');
    }
  });

  state.socket.on('call:participant-left', ({ socketId }) => {
    const pc = state.peerConnections.get(socketId);
    if (pc) {
      try { pc.close(); } catch (error) {}
    }
    state.peerConnections.delete(socketId);
    state.remoteStreams.delete(socketId);
    state.mediaStatus = 'Teilnehmer hat das Gespräch verlassen.';
    renderCall();
  });

  state.socket.on('call:ended', ({ roomId }) => {
    handleCallEnded(roomId);
    render();
  });

  state.socket.on('webrtc:signal', handleSignal);

  state.socket.on('webrtc:media-state', ({ socketId, media }) => {
    const person = getPerson(socketId);
    if (person) {
      person.media = media;
      renderCall();
    }
  });
}

el.updateProfileBtn.onclick = updateProfile;
el.addRoomBtn.onclick = addRoom;
el.sendChatBtn.onclick = sendChat;
el.enterLeaveBtn.onclick = togglePresence;
el.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendChat();
});
el.presenceStatus.addEventListener('change', () => {
  state.socket?.emit('user:set-status', { status: el.presenceStatus.value });
});

connect();
