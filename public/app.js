const socket = io();

/* ===== DOM Elements ===== */
const lobby = document.getElementById('lobby');
const roomView = document.getElementById('roomView');
const lobbyForm = document.getElementById('lobbyForm');
const usernameInput = document.getElementById('usernameInput');
const roomInput = document.getElementById('roomInput');
const roomCards = document.getElementById('roomCards');
const passwordSection = document.getElementById('passwordSection');
const passwordInput = document.getElementById('passwordInput');
const lobbyError = document.getElementById('lobbyError');
const roomName = document.getElementById('roomName');
const roomIcon = document.getElementById('roomIcon');
const currentUsername = document.getElementById('currentUsername');
const headerAvatar = document.getElementById('headerAvatar');
const encryptionBadge = document.getElementById('encryptionBadge');
const videoGrid = document.getElementById('videoGrid');
const localVideo = document.getElementById('localVideo');
const participantsList = document.getElementById('participantsList');
const participantCount = document.getElementById('participantCount');
const messages = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCameraBtn = document.getElementById('toggleCameraBtn');
const toggleRecordBtn = document.getElementById('toggleRecordBtn');
const recordDot = document.getElementById('recordDot');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');

/* ===== State ===== */
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
let selectedRoomId = null;
let selectedRoomIcon = '🌐';

// Recording state
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

// E2E Encryption state
let localKeyPair = null;
let sharedKeys = new Map(); // userId -> CryptoKey (AES-GCM)
let roomKey = null; // Shared room key for group chat

let rtcConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};
let iceServersLoaded = false;

/* ===== Avatar Colors ===== */
const AVATAR_COLORS = [
  'linear-gradient(135deg, #06b6d4, #0284c7)',
  'linear-gradient(135deg, #8b5cf6, #7c3aed)',
  'linear-gradient(135deg, #f43f5e, #e11d48)',
  'linear-gradient(135deg, #10b981, #059669)',
  'linear-gradient(135deg, #f59e0b, #d97706)',
  'linear-gradient(135deg, #ec4899, #db2777)',
  'linear-gradient(135deg, #6366f1, #4f46e5)',
  'linear-gradient(135deg, #14b8a6, #0d9488)'
];

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

/* ===== Notification Sounds (Web Audio API) ===== */
let audioContext = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

function playTone(frequency, duration, type, volume) {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type || 'sine';
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
    gain.gain.setValueAtTime(volume || 0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (duration || 0.2));
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + (duration || 0.2));
  } catch (e) {
    // Audio not available
  }
}

function playJoinSound() {
  playTone(880, 0.12, 'sine', 0.06);
  setTimeout(() => playTone(1100, 0.15, 'sine', 0.06), 120);
}

function playLeaveSound() {
  playTone(660, 0.12, 'sine', 0.05);
  setTimeout(() => playTone(440, 0.18, 'sine', 0.05), 120);
}

function playMessageSound() {
  if (document.hasFocus()) return;
  playTone(1200, 0.08, 'sine', 0.04);
  setTimeout(() => playTone(1500, 0.1, 'sine', 0.04), 80);
}

/* ===== E2E Encryption ===== */
async function generateKeyPair() {
  try {
    localKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
    return localKeyPair;
  } catch (e) {
    console.warn('E2E encryption not available:', e);
    return null;
  }
}

async function exportPublicKey(key) {
  const exported = await crypto.subtle.exportKey('raw', key);
  return Array.from(new Uint8Array(exported));
}

async function importPublicKey(keyData) {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(keyData),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

async function deriveSharedKey(privateKey, publicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptMessage(message, key) {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(message)
  );
  return {
    encrypted: Array.from(new Uint8Array(encrypted)),
    iv: Array.from(iv)
  };
}

async function decryptMessage(encryptedData, iv, key) {
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(encryptedData)
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return '[رسالة مشفرة — تعذر فك التشفير]';
  }
}

async function broadcastPublicKey() {
  if (!localKeyPair || !currentRoomId) return;
  const pubKeyData = await exportPublicKey(localKeyPair.publicKey);
  socket.emit('public-key', { roomId: currentRoomId, publicKey: pubKeyData });
}

/* ===== Helpers ===== */
function setLobbyError(message) {
  lobbyError.textContent = message || '';
}

function formatTime(isoString) {
  return new Intl.DateTimeFormat('ar', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(isoString));
}

async function loadIceServers() {
  if (iceServersLoaded) return;
  try {
    const response = await fetch('/api/ice-servers');
    if (!response.ok) throw new Error('Could not load ICE servers.');
    const data = await response.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      rtcConfiguration = { iceServers: data.iceServers };
    }
  } catch (error) {
    console.warn('Using fallback ICE servers:', error);
  } finally {
    iceServersLoaded = true;
  }
}

/* ===== Room Cards ===== */
async function loadRoomCards() {
  try {
    const response = await fetch('/api/rooms');
    const data = await response.json();
    renderRoomCards(data.rooms);
  } catch (e) {
    // Fallback to default rooms
    renderRoomCards([
      { id: 'عامة', name: 'عامة', description: 'للدردشة العامة والنقاشات', icon: '🌐', participants: 0, hasPassword: false },
      { id: 'تقنية', name: 'تقنية', description: 'للمواضيع التقنية والبرمجة', icon: '💻', participants: 0, hasPassword: false },
      { id: 'ترفيه', name: 'ترفيه', description: 'للترفيه والألعاب', icon: '🎮', participants: 0, hasPassword: false }
    ]);
  }
}

function renderRoomCards(roomsList) {
  roomCards.innerHTML = '';
  roomsList.forEach((room) => {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.dataset.roomId = room.id;
    card.dataset.icon = room.icon;

    card.innerHTML = `
      <div class="room-card-icon">${room.icon}</div>
      <div class="room-card-name">${room.name}</div>
      <div class="room-card-desc">${room.description}</div>
      <div class="room-card-meta">
        <span class="room-card-count">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          ${room.participants}
        </span>
        ${room.hasPassword ? '<span class="room-card-lock"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>' : ''}
      </div>
    `;

    card.addEventListener('click', () => selectRoom(room.id, room.icon));
    roomCards.appendChild(card);
  });
}

function selectRoom(roomId, icon) {
  selectedRoomId = roomId;
  selectedRoomIcon = icon || '🌐';
  roomInput.value = roomId;

  document.querySelectorAll('.room-card').forEach((c) => c.classList.remove('selected'));
  const selected = document.querySelector(`.room-card[data-room-id="${roomId}"]`);
  if (selected) selected.classList.add('selected');

  passwordSection.classList.remove('hidden');
  joinRoomBtn.disabled = false;
}

/* ===== UI Updates ===== */
function showRoom() {
  lobby.classList.add('hidden');
  roomView.classList.remove('hidden');
  roomName.textContent = currentRoomId;
  roomIcon.textContent = selectedRoomIcon;
  currentUsername.textContent = localUsername;
  headerAvatar.textContent = getInitial(localUsername);
  headerAvatar.style.background = getAvatarColor(localUsername);
  updateVideoTileStatus(localUserId, localUsername, micEnabled, cameraEnabled);
}

function showLobby() {
  roomView.classList.add('hidden');
  lobby.classList.remove('hidden');
  loadRoomCards();
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

    const avatar = document.createElement('div');
    avatar.className = 'participant-avatar';
    avatar.textContent = getInitial(participant.username);
    avatar.style.background = getAvatarColor(participant.username);

    const info = document.createElement('span');
    info.className = 'participant-info';
    info.textContent = participant.id === localUserId ? `${participant.username} (أنت)` : participant.username;

    const status = document.createElement('span');
    status.className = 'participant-status';

    const mic = document.createElement('span');
    mic.className = isMicEnabled ? 'status-chip on' : 'status-chip off';
    mic.textContent = isMicEnabled ? '🎤' : '🔇';

    const camera = document.createElement('span');
    camera.className = isCameraEnabled ? 'status-chip on' : 'status-chip off';
    camera.textContent = isCameraEnabled ? '📷' : '📷‍';

    status.append(mic, camera);
    item.append(avatar, info, status);
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

async function addMessage({ userId, username, message, time, encrypted, iv }) {
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

  // Decrypt if E2E encrypted
  if (encrypted && iv) {
    let decryptedText = null;

    if (userId === localUserId) {
      // Our own message — we have the original text (it's already encrypted on send)
      // Try to decrypt with room key
      if (roomKey) {
        decryptedText = await decryptMessage(message, iv, roomKey);
      }
    } else if (roomKey) {
      decryptedText = await decryptMessage(message, iv, roomKey);
    }

    text.textContent = decryptedText || '[رسالة مشفرة]';

    const lockBadge = document.createElement('span');
    lockBadge.className = 'message-encrypted';
    lockBadge.textContent = '🔒';
    meta.append(author, lockBadge, timestamp);
  } else {
    text.textContent = message;
    meta.append(author, timestamp);
  }

  item.append(meta, text);
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;

  playMessageSound();
}

function updateVideoTileStatus(userId, username, isMicEnabled, isCameraEnabled) {
  const tileId = userId === localUserId ? 'localTile' : `remote-${userId}`;
  const tile = document.getElementById(tileId);
  const displayName = userId === localUserId ? username || localUsername : username || 'مستخدم';
  const initial = getInitial(displayName);

  if (!tile) return;

  tile.dataset.initial = initial;
  tile.classList.toggle('camera-off', !isCameraEnabled);

  const label = tile.querySelector('.video-name');
  const status = tile.querySelector('.video-status');

  if (label) {
    label.textContent = userId === localUserId ? `${displayName} (أنت)` : displayName;
  }

  if (status) {
    status.innerHTML = '';
    const mic = document.createElement('span');
    const camera = document.createElement('span');

    mic.className = isMicEnabled ? 'media-pill on' : 'media-pill off';
    camera.className = isCameraEnabled ? 'media-pill on' : 'media-pill off';
    mic.textContent = isMicEnabled ? '🎤' : '🔇';
    camera.textContent = isCameraEnabled ? '📷' : '📷‍';

    status.append(mic, camera);
  }
}

function updateParticipantState(userId, state) {
  const participant = participants.get(userId);
  if (!participant) return;

  const nextParticipant = { ...participant, ...state };
  participants.set(userId, nextParticipant);
  renderParticipants();
  updateVideoTileStatus(
    userId,
    nextParticipant.username,
    nextParticipant.micEnabled,
    nextParticipant.cameraEnabled
  );
}

/* ===== Media ===== */
async function startLocalMedia() {
  if (localStream) return localStream;

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

/* ===== Recording ===== */
function startRecording() {
  if (!localStream || isRecording) return;

  recordedChunks = [];
  const options = { mimeType: 'video/webm;codecs=vp9,opus' };

  try {
    mediaRecorder = new MediaRecorder(localStream, options);
  } catch (e) {
    try {
      mediaRecorder = new MediaRecorder(localStream, { mimeType: 'video/webm' });
    } catch (e2) {
      console.error('Recording not supported');
      return;
    }
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    recordedChunks = [];
  };

  mediaRecorder.start(1000);
  isRecording = true;
  toggleRecordBtn.classList.add('is-recording');
  recordDot.classList.remove('hidden');
}

function stopRecording() {
  if (!mediaRecorder || !isRecording) return;

  mediaRecorder.stop();
  isRecording = false;
  toggleRecordBtn.classList.remove('is-recording');
  recordDot.classList.add('hidden');
}

/* ===== WebRTC ===== */
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

  const overlay = document.createElement('div');
  const name = document.createElement('div');
  const status = document.createElement('div');

  overlay.className = 'video-label';
  name.className = 'video-name';
  status.className = 'video-status';
  name.textContent = username || userId;

  overlay.append(name, status);
  tile.append(video, overlay);
  videoGrid.appendChild(tile);

  return video;
}

function removeRemoteUser(userId) {
  const peerConnection = peerConnections.get(userId);
  if (peerConnection) peerConnection.close();

  peerConnections.delete(userId);
  remoteStreams.delete(userId);
  queuedCandidates.delete(userId);
  sharedKeys.delete(userId);

  const tile = document.getElementById(`remote-${userId}`);
  if (tile) tile.remove();
}

function getOrCreatePeerConnection(userId, username) {
  if (peerConnections.has(userId)) return peerConnections.get(userId);

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
      socket.emit('ice-candidate', { to: userId, candidate: event.candidate });
    }
  };

  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      event.streams[0].getTracks().forEach((track) => {
        if (!remoteStream.getTrackById(track.id)) {
          remoteStream.addTrack(track);
        }
      });
    } else {
      // Fallback: add track directly (common with TURN relay)
      if (!remoteStream.getTrackById(event.track.id)) {
        remoteStream.addTrack(event.track);
      }
    }
    // Ensure video element is playing
    const videoEl = document.querySelector(`#remote-${userId} video`);
    if (videoEl && videoEl.paused) {
      videoEl.play().catch(() => {});
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    console.log(`ICE state [${userId}]: ${state}`);
    if (state === 'failed') {
      // Attempt ICE restart
      console.log(`Attempting ICE restart for ${userId}`);
      peerConnection.createOffer({ iceRestart: true }).then((offer) => {
        return peerConnection.setLocalDescription(offer);
      }).then(() => {
        socket.emit('offer', { to: userId, offer: peerConnection.localDescription });
      }).catch((err) => console.error('ICE restart failed:', err));
    }
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

  if (!peerConnection || !peerConnection.remoteDescription) return;

  for (const candidate of candidates) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  queuedCandidates.delete(userId);
}

async function callUser(userId, username) {
  const peerConnection = getOrCreatePeerConnection(userId, username);
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('offer', { to: userId, offer });
}

async function handleOffer({ from, offer }) {
  const username = participants.get(from)?.username || 'مستخدم';
  const peerConnection = getOrCreatePeerConnection(from, username);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  await addQueuedCandidates(from);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
}

async function handleAnswer({ from, answer }) {
  const peerConnection = peerConnections.get(from);
  if (!peerConnection) return;
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

/* ===== Join / Leave ===== */
async function joinRoom(roomId, username, password) {
  setLobbyError('');
  joinRoomBtn.disabled = true;

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('هذا المتصفح لا يدعم الكاميرا والمايكروفون.');
    }

    await loadIceServers();
    await startLocalMedia();

    // Generate E2E key pair
    await generateKeyPair();

    socket.emit('join-room', { roomId, username, password }, async (response) => {
      if (!response || !response.ok) {
        setLobbyError(response?.error || 'لم يمكن الانضمام للغرفة.');
        joinRoomBtn.disabled = false;
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

      // Generate room key for E2E group chat
      // Use a simple approach: derive key from room password or generate a shared one
      if (password) {
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
          'raw',
          encoder.encode(password + currentRoomId),
          'PBKDF2',
          false,
          ['deriveKey']
        );
        roomKey = await crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: encoder.encode('localchat-e2e-salt'),
            iterations: 100000,
            hash: 'SHA-256'
          },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      } else {
        // For rooms without password, use room ID as base for shared key
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
          'raw',
          encoder.encode(currentRoomId + '-localchat-shared'),
          'PBKDF2',
          false,
          ['deriveKey']
        );
        roomKey = await crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: encoder.encode('localchat-e2e-open'),
            iterations: 100000,
            hash: 'SHA-256'
          },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      }

      // Broadcast our public key
      broadcastPublicKey();

      renderParticipants();
      showRoom();

      for (const user of response.users) {
        await callUser(user.id, user.username);
      }
    });
  } catch (error) {
    setLobbyError(error.message || 'مطلوب إذن الكاميرا والمايكروفون.');
    joinRoomBtn.disabled = false;
  }
}

function cleanupRoom() {
  if (isRecording) stopRecording();

  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();
  remoteStreams.clear();
  queuedCandidates.clear();
  participants.clear();
  sharedKeys.clear();
  roomKey = null;
  localKeyPair = null;

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
  selectedRoomId = null;

  // Reset button states
  toggleMicBtn.classList.remove('is-off');
  toggleCameraBtn.classList.remove('is-off');
  toggleMicBtn.querySelector('.icon-on').classList.remove('hidden');
  toggleMicBtn.querySelector('.icon-off').classList.add('hidden');
  toggleCameraBtn.querySelector('.icon-on').classList.remove('hidden');
  toggleCameraBtn.querySelector('.icon-off').classList.add('hidden');

  messages.innerHTML = '';
  participantsList.innerHTML = '';
  participantCount.textContent = '0';
  joinRoomBtn.disabled = true;
}

function leaveRoom() {
  if (currentRoomId) socket.emit('leave-room');
  cleanupRoom();
  showLobby();
}

/* ===== Event Listeners ===== */
lobbyForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const username = usernameInput.value.trim();
  const roomId = roomInput.value.trim();
  const password = passwordInput.value.trim();

  if (!username) {
    setLobbyError('أدخل اسم المستخدم.');
    return;
  }

  if (!roomId) {
    setLobbyError('اختر غرفة.');
    return;
  }

  joinRoom(roomId, username, password);
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();

  if (!message || !currentRoomId) return;

  // Encrypt the message if we have a room key
  if (roomKey) {
    try {
      const { encrypted, iv } = await encryptMessage(message, roomKey);
      socket.emit('chat-message', {
        roomId: currentRoomId,
        message: encrypted,
        encrypted: true,
        iv
      });
    } catch (e) {
      // Fallback to unencrypted
      socket.emit('chat-message', { roomId: currentRoomId, message });
    }
  } else {
    socket.emit('chat-message', { roomId: currentRoomId, message });
  }

  messageInput.value = '';
  messageInput.focus();
});

toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => { track.enabled = micEnabled; });

  toggleMicBtn.classList.toggle('is-off', !micEnabled);
  toggleMicBtn.querySelector('.icon-on').classList.toggle('hidden', !micEnabled);
  toggleMicBtn.querySelector('.icon-off').classList.toggle('hidden', micEnabled);

  updateParticipantState(localUserId, { micEnabled });
  socket.emit('media-state', { roomId: currentRoomId, micEnabled, cameraEnabled });
});

toggleCameraBtn.addEventListener('click', () => {
  if (!localStream) return;
  cameraEnabled = !cameraEnabled;
  localStream.getVideoTracks().forEach((track) => { track.enabled = cameraEnabled; });

  toggleCameraBtn.classList.toggle('is-off', !cameraEnabled);
  toggleCameraBtn.querySelector('.icon-on').classList.toggle('hidden', !cameraEnabled);
  toggleCameraBtn.querySelector('.icon-off').classList.toggle('hidden', cameraEnabled);

  updateParticipantState(localUserId, { cameraEnabled });
  socket.emit('media-state', { roomId: currentRoomId, micEnabled, cameraEnabled });
});

toggleRecordBtn.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

leaveRoomBtn.addEventListener('click', leaveRoom);

window.addEventListener('beforeunload', () => {
  if (currentRoomId) socket.emit('leave-room');
});

/* ===== Socket Events ===== */
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
  playJoinSound();
});

socket.on('user-left', ({ userId }) => {
  participants.delete(userId);
  renderParticipants();
  removeRemoteUser(userId);
  playLeaveSound();
});

socket.on('chat-message', (data) => addMessage(data));
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

// E2E key exchange
socket.on('public-key', async ({ userId, publicKey }) => {
  if (!localKeyPair) return;
  try {
    const importedKey = await importPublicKey(publicKey);
    const shared = await deriveSharedKey(localKeyPair.privateKey, importedKey);
    sharedKeys.set(userId, shared);
  } catch (e) {
    console.warn('Key exchange failed:', e);
  }
});

/* ===== PWA Service Worker ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('SW registration failed:', error);
    });
  });
}

/* ===== Init ===== */
loadRoomCards();
