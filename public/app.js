const socket = io();

const lobby = document.getElementById('lobby');
const roomView = document.getElementById('roomView');
const lobbyForm = document.getElementById('lobbyForm');
const usernameInput = document.getElementById('usernameInput');
const roomInput = document.getElementById('roomInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const lobbyError = document.getElementById('lobbyError');
const roomName = document.getElementById('roomName');
const currentUsername = document.getElementById('currentUsername');
const videoGrid = document.getElementById('videoGrid');
const localVideo = document.getElementById('localVideo');
const participantsList = document.getElementById('participantsList');
const participantCount = document.getElementById('participantCount');
const messages = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');

const peerConnections = new Map();
const remoteStreams = new Map();
const queuedCandidates = new Map();
const participants = new Map();

let localStream = null;
let currentRoomId = null;
let localUsername = null;
let localUserId = null;
let micEnabled = true;
let cameraEnabled = true;

const rtcConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function setLobbyError(message) {
  lobbyError.textContent = message || '';
}

function generateRoomId() {
  return `room-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(isoString) {
  return new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(isoString));
}

function showRoom() {
  lobby.classList.add('hidden');
  roomView.classList.remove('hidden');
  roomName.textContent = currentRoomId;
  currentUsername.textContent = localUsername;
  updateVideoTileStatus(localUserId, localUsername, micEnabled, cameraEnabled);
}

function showLobby() {
  roomView.classList.add('hidden');
  lobby.classList.remove('hidden');
}

function renderParticipants() {
  const sortedParticipants = Array.from(participants.values()).sort((a, b) => {
    return a.username.localeCompare(b.username);
  });

  participantsList.innerHTML = '';
  participantCount.textContent = String(sortedParticipants.length);

  sortedParticipants.forEach((participant) => {
    const isMicEnabled = participant.micEnabled !== false;
    const isCameraEnabled = participant.cameraEnabled !== false;
    const item = document.createElement('li');
    const dot = document.createElement('span');
    const info = document.createElement('span');
    const name = document.createElement('span');
    const status = document.createElement('span');
    const mic = document.createElement('span');
    const camera = document.createElement('span');

    dot.className = 'participant-dot';
    info.className = 'participant-info';
    status.className = 'participant-status';
    mic.className = isMicEnabled ? 'status-chip on' : 'status-chip off';
    camera.className = isCameraEnabled ? 'status-chip on' : 'status-chip off';
    name.textContent = participant.id === localUserId ? `${participant.username} (You)` : participant.username;
    mic.textContent = isMicEnabled ? 'Mic on' : 'Mic off';
    camera.textContent = isCameraEnabled ? 'Cam on' : 'Cam off';

    info.append(name);
    status.append(mic, camera);
    item.append(dot, info, status);
    participantsList.appendChild(item);
  });
}

function addSystemMessage({ message, time }) {
  const item = document.createElement('article');
  const timestamp = document.createElement('span');
  const text = document.createElement('span');

  item.className = 'system-message';
  timestamp.textContent = formatTime(time);
  text.textContent = message;

  item.append(timestamp, text);
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
}

function addMessage({ username, message, time }) {
  const item = document.createElement('article');
  const meta = document.createElement('div');
  const author = document.createElement('strong');
  const timestamp = document.createElement('span');
  const text = document.createElement('div');

  item.className = 'message';
  meta.className = 'message-meta';
  text.className = 'message-text';

  author.textContent = username;
  timestamp.textContent = formatTime(time);
  text.textContent = message;

  meta.append(author, timestamp);
  item.append(meta, text);
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
}

function updateVideoTileStatus(userId, username, isMicEnabled, isCameraEnabled) {
  const tileId = userId === localUserId ? 'localTile' : `remote-${userId}`;
  const tile = document.getElementById(tileId);
  const displayName = userId === localUserId ? username || localUsername : username || 'Remote user';
  const initial = (displayName || '?').trim().charAt(0).toUpperCase();

  if (!tile) {
    return;
  }

  tile.dataset.initial = initial;
  tile.classList.toggle('camera-off', !isCameraEnabled);

  const label = tile.querySelector('.video-name');
  const status = tile.querySelector('.video-status');

  if (label) {
    label.textContent = userId === localUserId ? `${displayName} (You)` : displayName;
  }

  if (status) {
    status.innerHTML = '';

    const mic = document.createElement('span');
    const camera = document.createElement('span');

    mic.className = isMicEnabled ? 'media-pill on' : 'media-pill off';
    camera.className = isCameraEnabled ? 'media-pill on' : 'media-pill off';
    mic.textContent = isMicEnabled ? 'Mic on' : 'Mic off';
    camera.textContent = isCameraEnabled ? 'Cam on' : 'Cam off';

    status.append(mic, camera);
  }
}

function updateParticipantState(userId, state) {
  const participant = participants.get(userId);

  if (!participant) {
    return;
  }

  const nextParticipant = {
    ...participant,
    ...state
  };

  participants.set(userId, nextParticipant);
  renderParticipants();
  updateVideoTileStatus(
    userId,
    nextParticipant.username,
    nextParticipant.micEnabled,
    nextParticipant.cameraEnabled
  );
}

async function startLocalMedia() {
  if (localStream) {
    return localStream;
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user'
    }
  });

  localVideo.srcObject = localStream;
  return localStream;
}

function createRemoteVideo(userId, username) {
  let tile = document.getElementById(`remote-${userId}`);

  if (tile) {
    const label = tile.querySelector('.video-name');
    label.textContent = username || userId;
    return tile.querySelector('video');
  }

  tile = document.createElement('article');
  tile.className = 'video-tile';
  tile.id = `remote-${userId}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;

  const label = createVideoOverlay(username || userId);

  tile.append(video, label);
  videoGrid.appendChild(tile);

  return video;
}

function createVideoOverlay(displayName) {
  const overlay = document.createElement('div');
  const name = document.createElement('div');
  const status = document.createElement('div');

  overlay.className = 'video-label';
  name.className = 'video-name';
  status.className = 'video-status';
  name.textContent = displayName;

  overlay.append(name, status);
  return overlay;
}

function removeRemoteUser(userId) {
  const peerConnection = peerConnections.get(userId);
  if (peerConnection) {
    peerConnection.close();
  }

  peerConnections.delete(userId);
  remoteStreams.delete(userId);
  queuedCandidates.delete(userId);

  const tile = document.getElementById(`remote-${userId}`);
  if (tile) {
    tile.remove();
  }
}

function getOrCreatePeerConnection(userId, username) {
  if (peerConnections.has(userId)) {
    return peerConnections.get(userId);
  }

  const peerConnection = new RTCPeerConnection(rtcConfiguration);
  const remoteStream = new MediaStream();
  const remoteVideo = createRemoteVideo(userId, username);
  const participant = participants.get(userId);

  remoteVideo.srcObject = remoteStream;
  remoteStreams.set(userId, remoteStream);
  updateVideoTileStatus(
    userId,
    participant?.username || username,
    participant?.micEnabled !== false,
    participant?.cameraEnabled !== false
  );

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        to: userId,
        candidate: event.candidate
      });
    }
  };

  peerConnection.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      if (!remoteStream.getTrackById(track.id)) {
        remoteStream.addTrack(track);
      }
    });
  };

  peerConnection.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(peerConnection.connectionState)) {
      removeRemoteUser(userId);
    }
  };

  peerConnections.set(userId, peerConnection);
  return peerConnection;
}

async function addQueuedCandidates(userId) {
  const peerConnection = peerConnections.get(userId);
  const candidates = queuedCandidates.get(userId) || [];

  if (!peerConnection || !peerConnection.remoteDescription) {
    return;
  }

  for (const candidate of candidates) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  queuedCandidates.delete(userId);
}

async function callUser(userId, username) {
  const peerConnection = getOrCreatePeerConnection(userId, username);
  const offer = await peerConnection.createOffer();

  await peerConnection.setLocalDescription(offer);

  socket.emit('offer', {
    to: userId,
    offer
  });
}

async function handleOffer({ from, offer }) {
  const username = participants.get(from)?.username || 'Remote user';
  const peerConnection = getOrCreatePeerConnection(from, username);

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  await addQueuedCandidates(from);

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('answer', {
    to: from,
    answer
  });
}

async function handleAnswer({ from, answer }) {
  const peerConnection = peerConnections.get(from);

  if (!peerConnection) {
    return;
  }

  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  await addQueuedCandidates(from);
}

async function handleIceCandidate({ from, candidate }) {
  const peerConnection = peerConnections.get(from);

  if (!peerConnection || !peerConnection.remoteDescription) {
    const candidates = queuedCandidates.get(from) || [];
    candidates.push(candidate);
    queuedCandidates.set(from, candidates);
    return;
  }

  await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

async function joinRoom(roomId, username) {
  setLobbyError('');
  createRoomBtn.disabled = true;

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support camera and microphone access.');
    }

    await startLocalMedia();

    socket.emit('join-room', { roomId, username }, async (response) => {
      if (!response || !response.ok) {
        setLobbyError(response?.error || 'Could not join the room.');
        return;
      }

      currentRoomId = response.roomId;
      localUsername = username;
      localUserId = response.userId;

      participants.clear();
      participants.set(localUserId, {
        id: localUserId,
        username: localUsername,
        micEnabled,
        cameraEnabled
      });

      response.users.forEach((user) => {
        participants.set(user.id, {
          ...user,
          micEnabled: user.micEnabled !== false,
          cameraEnabled: user.cameraEnabled !== false
        });
      });

      renderParticipants();
      showRoom();

      for (const user of response.users) {
        await callUser(user.id, user.username);
      }
    });
  } catch (error) {
    setLobbyError(error.message || 'Camera and microphone permission is required.');
  } finally {
    createRoomBtn.disabled = false;
  }
}

function cleanupRoom() {
  peerConnections.forEach((peerConnection) => peerConnection.close());
  peerConnections.clear();
  remoteStreams.clear();
  queuedCandidates.clear();
  participants.clear();

  document.querySelectorAll('[id^="remote-"]').forEach((tile) => tile.remove());

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  currentRoomId = null;
  localUsername = null;
  localUserId = null;
  micEnabled = true;
  cameraEnabled = true;
  toggleMicBtn.textContent = 'Mic';
  toggleCameraBtn.textContent = 'Camera';
  toggleMicBtn.classList.remove('is-off');
  toggleCameraBtn.classList.remove('is-off');
  messages.innerHTML = '';
  participantsList.innerHTML = '';
  participantCount.textContent = '0';
}

function leaveRoom() {
  if (currentRoomId) {
    socket.emit('leave-room');
  }

  cleanupRoom();
  showLobby();
}

createRoomBtn.addEventListener('click', () => {
  if (!roomInput.value.trim()) {
    roomInput.value = generateRoomId();
  }

  lobbyForm.requestSubmit();
});

lobbyForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const username = usernameInput.value.trim();
  const roomId = roomInput.value.trim();

  if (!username || !roomId) {
    setLobbyError('Username and Room ID are required.');
    return;
  }

  joinRoom(roomId, username);
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();

  if (!message || !currentRoomId) {
    return;
  }

  socket.emit('chat-message', {
    roomId: currentRoomId,
    message
  });

  messageInput.value = '';
  messageInput.focus();
});

toggleMicBtn.addEventListener('click', () => {
  if (!localStream) {
    return;
  }

  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = micEnabled;
  });

  toggleMicBtn.textContent = micEnabled ? 'Mic' : 'Mic Off';
  toggleMicBtn.classList.toggle('is-off', !micEnabled);
  updateParticipantState(localUserId, { micEnabled });
  socket.emit('media-state', {
    roomId: currentRoomId,
    micEnabled,
    cameraEnabled
  });
});

toggleCameraBtn.addEventListener('click', () => {
  if (!localStream) {
    return;
  }

  cameraEnabled = !cameraEnabled;
  localStream.getVideoTracks().forEach((track) => {
    track.enabled = cameraEnabled;
  });

  toggleCameraBtn.textContent = cameraEnabled ? 'Camera' : 'Camera Off';
  toggleCameraBtn.classList.toggle('is-off', !cameraEnabled);
  updateParticipantState(localUserId, { cameraEnabled });
  socket.emit('media-state', {
    roomId: currentRoomId,
    micEnabled,
    cameraEnabled
  });
});

leaveRoomBtn.addEventListener('click', leaveRoom);

window.addEventListener('beforeunload', () => {
  if (currentRoomId) {
    socket.emit('leave-room');
  }
});

socket.on('participants-updated', (users) => {
  participants.clear();
  users.forEach((user) => {
    const normalizedUser = {
      ...user,
      micEnabled: user.micEnabled !== false,
      cameraEnabled: user.cameraEnabled !== false
    };

    participants.set(user.id, normalizedUser);
    updateVideoTileStatus(
      normalizedUser.id,
      normalizedUser.username,
      normalizedUser.micEnabled,
      normalizedUser.cameraEnabled
    );
  });
  renderParticipants();
});

socket.on('user-joined', ({ userId, username, micEnabled: userMicEnabled, cameraEnabled: userCameraEnabled }) => {
  participants.set(userId, {
    id: userId,
    username,
    micEnabled: userMicEnabled !== false,
    cameraEnabled: userCameraEnabled !== false
  });
  renderParticipants();
});

socket.on('user-left', ({ userId }) => {
  participants.delete(userId);
  renderParticipants();
  removeRemoteUser(userId);
});

socket.on('chat-message', addMessage);
socket.on('system-message', addSystemMessage);
socket.on('media-state', ({ userId, micEnabled: userMicEnabled, cameraEnabled: userCameraEnabled }) => {
  updateParticipantState(userId, {
    micEnabled: userMicEnabled,
    cameraEnabled: userCameraEnabled
  });
});

socket.on('offer', (payload) => {
  handleOffer(payload).catch((error) => {
    console.error('Failed to handle offer:', error);
  });
});

socket.on('answer', (payload) => {
  handleAnswer(payload).catch((error) => {
    console.error('Failed to handle answer:', error);
  });
});

socket.on('ice-candidate', (payload) => {
  handleIceCandidate(payload).catch((error) => {
    console.error('Failed to handle ICE candidate:', error);
  });
});
