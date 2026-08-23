(() => {
  'use strict';

  const FALLBACK_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'stun:stun.relay.metered.ca:443' },
  ];

  let iceServers = FALLBACK_ICE_SERVERS;

  async function loadIceServers() {
    try {
      const res = await fetch('/api/turn-credentials');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const servers = await res.json();
      if (Array.isArray(servers) && servers.length) {
        iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, ...servers];
      }
    } catch (err) {
      console.warn('[PulseCord] Usando reserva comunitaria:', err);
    }
  }

  const socket = io();

  // ---------- estado ----------
  let selfId = null;
  let displayName = '';
  let roomCode = '';
  let localStream = null;
  let screenStream = null;
  let isSharingScreen = false;
  let remoteAudioMuted = false;
  let liveVolume = 1.0;
  const peers = new Map();

  // ---------- relay state ----------
  const relayPeers = new Map(); // id -> { canvas, ctx, audioCtx, gainNode, videoInterval, name }
  let relayVideoInterval = null;
  let relayCanvas = null;
  let relayCtx = null;

  // ---------- audio context global ----------
  let remoteAudioCtx = null;
  function getRemoteAudioCtx() {
    if (!remoteAudioCtx) remoteAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (remoteAudioCtx.state === 'suspended') remoteAudioCtx.resume();
    return remoteAudioCtx;
  }

  // ---------- elementos ----------
  const lobby = document.getElementById('lobby');
  const callScreen = document.getElementById('call');
  const lobbyError = document.getElementById('lobby-error');
  const tileTemplate = document.getElementById('tile-template');
  const stage = document.getElementById('stage');
  const thumbStrip = document.getElementById('thumb-strip');
  const participantsList = document.getElementById('participants-list');
  const chatLog = document.getElementById('chat-log');
  const chatPanel = document.getElementById('chat-panel');

  // ---------- volume overlay ----------
  const volumeOverlay = document.getElementById('volume-overlay');
  const volumeSlider = document.getElementById('volume-slider');
  const volumeValue = document.getElementById('volume-value');
  let volumeTargetPeer = null;

  function showVolumeOverlay(e, peerId) {
    volumeTargetPeer = peerId;
    volumeSlider.value = liveVolume;
    updateVolumeLabel();
    volumeOverlay.hidden = false;
    const rect = stage.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    x = Math.max(80, Math.min(x, rect.width - 80));
    y = Math.max(40, Math.min(y, rect.height - 40));
    volumeOverlay.style.left = x + 'px';
    volumeOverlay.style.top = y + 'px';
  }

  function hideVolumeOverlay() {
    volumeOverlay.hidden = true;
    volumeTargetPeer = null;
  }

  function updateVolumeLabel() {
    volumeValue.textContent = Math.round(liveVolume * 100) + '%';
  }

  volumeSlider.addEventListener('input', () => {
    liveVolume = parseFloat(volumeSlider.value);
    updateVolumeLabel();
    applyVolumeToAll();
  });

  volumeOverlay.addEventListener('mousedown', (e) => e.stopPropagation());
  volumeOverlay.addEventListener('mouseup', (e) => e.stopPropagation());

  function applyVolumeToAll() {
    peers.forEach((peer, id) => {
      if (id === 'self') return;
      if (peer.gainNode) {
        peer.gainNode.gain.value = remoteAudioMuted ? 0 : liveVolume;
      }
    });
    relayPeers.forEach((rp, id) => {
      if (rp.gainNode) {
        rp.gainNode.gain.value = remoteAudioMuted ? 0 : liveVolume;
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (!volumeOverlay.hidden && !volumeOverlay.contains(e.target)) hideVolumeOverlay();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideVolumeOverlay();
  });

  // ---------- tabs do lobby ----------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`form-${tab.dataset.tab}`).classList.add('active');
      lobbyError.textContent = '';
    });
  });

  const params = new URLSearchParams(location.search);
  if (params.get('sala')) {
    document.querySelector('.tab[data-tab="join"]').click();
    document.getElementById('join-code').value = params.get('sala').toUpperCase();
  }

  document.getElementById('form-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    lobbyError.textContent = '';
    const name = document.getElementById('create-name').value.trim();
    const roomName = document.getElementById('create-room-name').value.trim();
    const password = document.getElementById('create-password').value;
    if (!name) return;
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName, password: password || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await enterCall(data.code, name);
    } catch (err) {
      lobbyError.textContent = err.message;
    }
  });

  document.getElementById('form-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    lobbyError.textContent = '';
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const password = document.getElementById('join-password').value;
    if (!name || !code) return;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await enterCall(code, name);
    } catch (err) {
      lobbyError.textContent = err.message;
    }
  });

  // ---------- entrar na chamada ----------
  async function enterCall(code, name) {
    roomCode = code;
    displayName = name;
    const iceServersReady = loadIceServers();
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      } catch (err2) {
        lobbyError.textContent = 'Precisamos de acesso ao microfone.';
        return;
      }
    }
    await iceServersReady;
    lobby.hidden = true;
    callScreen.hidden = false;
    document.getElementById('room-code-display').textContent = code;
    socket.emit('join-room', { code, displayName: name });
  }

  // ---------- sinalizacao ----------
  socket.on('joined', ({ selfId: id, roomName, peers: existingPeers }) => {
    selfId = id;
    document.getElementById('room-name').textContent = roomName || 'PulseCord';
    addLocalTile();
    existingPeers.forEach((p) => createPeerConnection(p.id, p.name, true));
    updateParticipantsList();
  });

  socket.on('peer-joined', ({ id, name }) => {
    createPeerConnection(id, name, false);
    updateParticipantsList();
    logSystem(`${name} entrou na sala.`);
    playNotificationSound('join');
  });

  socket.on('peer-left', ({ id }) => {
    const peer = peers.get(id);
    if (peer) {
      logSystem(`${peer.name} saiu.`);
      teardownPeer(id);
    }
    const rp = relayPeers.get(id);
    if (rp) {
      logSystem(`${rp.name} saiu.`);
      teardownRelayPeer(id);
    }
    updateParticipantsList();
    playNotificationSound('leave');
  });

  socket.on('signal', async ({ from, data }) => {
    let peer = peers.get(from);
    if (data.type === 'offer') {
      if (peer) teardownPeer(from);
      peer = createPeerConnection(from, 'Amigo', false);
    } else if (!peer) {
      return;
    }
    try {
      if (data.type === 'offer') {
        await peer.pc.setRemoteDescription(data);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, data: peer.pc.localDescription });
      } else if (data.type === 'answer') {
        if (peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(data);
        }
      } else if (data.candidate) {
        await peer.pc.addIceCandidate(data);
      }
    } catch (err) {
      console.warn('[PulseCord] Erro ao processar signal:', err.message);
    }
  });

  socket.on('chat-message', ({ name, text, from }) => {
    logChat(name, text, from === selfId);
  });

  socket.on('screen-share-state', ({ id, sharing }) => {
    const peer = peers.get(id);
    if (peer) {
      peer.sharingScreen = sharing;
      peer.tileEl.classList.toggle('screen-tile', sharing);
      peer.tileEl.querySelector('.screen-badge').hidden = !sharing;
      refreshStageLayout();
    }
  });

  socket.on('error-message', (msg) => {
    teardownAllAndReturnToLobby(msg);
  });

  // ---------- RELAY: receber midia via Socket.io ----------
  socket.on('relay-media', ({ from, type, data }) => {
    let rp = relayPeers.get(from);

    // Cria tile de relay se nao existe
    if (!rp) {
      rp = createRelayPeer(from, 'Amigo');
    }

    if (type === 'video' && data) {
      const img = new Image();
      img.onload = () => {
        rp.ctx.drawImage(img, 0, 0, rp.canvas.width, rp.canvas.height);
        rp.tileEl.querySelector('.avatar-fallback').style.display = 'none';
      };
      img.src = 'data:image/jpeg;base64,' + data;
    } else if (type === 'audio' && data) {
      try {
        const raw = atob(data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const float32 = new Float32Array(bytes.buffer);
        const audioCtx = rp.audioCtx;
        const buffer = audioCtx.createBuffer(1, float32.length, 16000);
        buffer.getChannelData(0).set(float32);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(rp.gainNode);
        source.start();
      } catch (_) {}
    } else if (type === 'state') {
      rp.sharingScreen = !!data;
      rp.tileEl.classList.toggle('screen-tile', rp.sharingScreen);
      rp.tileEl.querySelector('.screen-badge').hidden = !rp.sharingScreen;
      refreshStageLayout();
    }
  });

  function createRelayPeer(id, name) {
    const tileEl = createTile(name);
    stage.appendChild(tileEl);

    // Troca o <video> por um <canvas> pro relay
    const videoEl = tileEl.querySelector('video');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    canvas.style.cssText = 'width:100%;height:100%;display:block;background:#000;border-radius:inherit;';
    const ring = tileEl.querySelector('.ember-ring');
    videoEl.style.display = 'none';
    ring.insertBefore(canvas, ring.querySelector('.avatar-fallback'));

    const audioCtx = getRemoteAudioCtx();
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = remoteAudioMuted ? 0 : liveVolume;
    gainNode.connect(audioCtx.destination);

    const rp = {
      name,
      tileEl,
      canvas,
      ctx: canvas.getContext('2d'),
      audioCtx,
      gainNode,
      sharingScreen: false,
    };
    relayPeers.set(id, rp);
    refreshStageLayout();
    return rp;
  }

  function teardownRelayPeer(id) {
    const rp = relayPeers.get(id);
    if (!rp) return;
    rp.tileEl.remove();
    relayPeers.delete(id);
    refreshStageLayout();
  }

  // ---------- RELAY: enviar midia via Socket.io ----------
  function startRelaySender(stream) {
    // Video: captura canvas em JPEG e envia
    relayCanvas = document.createElement('canvas');
    relayCanvas.width = 640;
    relayCanvas.height = 360;
    relayCtx = relayCanvas.getContext('2d');

    const videoEl = document.createElement('video');
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.play().catch(() => {});

    relayVideoInterval = setInterval(() => {
      if (!isSharingScreen) return;
      relayCtx.drawImage(videoEl, 0, 0, relayCanvas.width, relayCanvas.height);
      const b64 = relayCanvas.toDataURL('image/jpeg', 0.5).split(',')[1];
      socket.emit('relay-media', { type: 'video', data: b64 });
    }, 100); // 10fps

    // Audio: captura PCM e envia
    const audioCtx = getRemoteAudioCtx();
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination);

    let audioThrottle = 0;
    processor.onaudioprocess = (e) => {
      if (!isSharingScreen) return;
      const now = Date.now();
      if (now - audioThrottle < 100) return; // throttle: 10x/s
      audioThrottle = now;
      const input = e.inputBuffer.getChannelData(0);
      // Downsample 48k->16k
      const downsampled = new Float32Array(input.length / 3);
      for (let i = 0; i < downsampled.length; i++) {
        downsampled[i] = input[i * 3];
      }
      const int16 = new Int16Array(downsampled.length);
      for (let i = 0; i < downsampled.length; i++) {
        const s = Math.max(-1, Math.min(1, downsampled[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      // Convert to base64
      let b64 = '';
      const bytes = new Uint8Array(int16.buffer);
      for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
      socket.emit('relay-media', { type: 'audio', data: btoa(b64) });
    };

    // Salva referencia pra limpar
    relayPeers.set('__self_sender', { videoEl, processor, source });
  }

  function stopRelaySender() {
    const sender = relayPeers.get('__self_sender');
    if (sender) {
      if (sender.videoEl.srcObject) sender.videoEl.srcObject.getTracks().forEach((t) => t.stop());
      try { sender.processor.disconnect(); } catch (_) {}
      try { sender.source.disconnect(); } catch (_) {}
      relayPeers.delete('__self_sender');
    }
    if (relayVideoInterval) {
      clearInterval(relayVideoInterval);
      relayVideoInterval = null;
    }
  }

  function enterRelayMode(id, name) {
    console.log('[PulseCord] Entrando em modo RELAY com', name);
    const peer = peers.get(id);
    if (peer) teardownPeer(id);
    createRelayPeer(id, name);
    updateParticipantsList();
  }

  // ---------- WebRTC ----------
  function createPeerConnection(id, name, isInitiator, forceRelay) {
    const pcConfig = { iceServers };
    if (forceRelay) pcConfig.iceTransportPolicy = 'relay';
    const pc = new RTCPeerConnection(pcConfig);
    const tileEl = createTile(name);
    stage.appendChild(tileEl);

    const audioCtx = getRemoteAudioCtx();
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = remoteAudioMuted ? 0 : liveVolume;
    gainNode.connect(audioCtx.destination);

    const peer = {
      pc, name, tileEl,
      videoEl: tileEl.querySelector('video'),
      ring: tileEl.querySelector('.ember-ring'),
      analyser: null, raf: null, sharingScreen: false,
      audioCtx, gainNode, sourceNode: null,
    };
    peers.set(id, peer);
    refreshStageLayout();

    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('signal', { to: id, data: e.candidate });
    };

    pc.ontrack = (e) => {
      console.log('[PulseCord] ontrack de', name, '— kind:', e.track.kind);
      const stream = e.streams[0];
      if (!stream) return;
      peer.tileEl.querySelector('.avatar-fallback').style.display = 'none';
      if (e.track.kind === 'video') peer.videoEl.srcObject = stream;
      peer.videoEl.muted = true;
      if (e.track.kind === 'audio') {
        if (peer.sourceNode) { try { peer.sourceNode.disconnect(); } catch (_) {} }
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(peer.gainNode);
        peer.sourceNode = source;
      }
      startAudioMeter(peer, stream);
    };

    let iceRestartCount = 0;
    let disconnectTimer = null;
    let relayAttempted = forceRelay || false;

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log('[PulseCord] ICE com', name, ':', state);

      if (state === 'disconnected') {
        disconnectTimer = setTimeout(async () => {
          if (pc.iceConnectionState === 'disconnected' && iceRestartCount < 3) {
            iceRestartCount++;
            console.log('[PulseCord] ICE restart #' + iceRestartCount, 'com', name);
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              socket.emit('signal', { to: id, data: pc.localDescription });
            } catch (err) {
              console.warn('[PulseCord] Falha no ICE restart:', err);
            }
          }
        }, 3000);
      } else if (state === 'failed') {
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
        if (!relayAttempted) {
          console.log('[PulseCord] WebRTC falhou — fallback para RELAY');
          enterRelayMode(id, name);
        }
        return;
      } else {
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
        if (state === 'connected' || state === 'completed') iceRestartCount = 0;
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[PulseCord] Conexao com', name, ':', pc.connectionState);
    };

    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', { to: id, data: pc.localDescription });
      };
    }

    return peer;
  }

  function teardownPeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    if (peer.raf) cancelAnimationFrame(peer.raf);
    if (peer.sourceNode) { try { peer.sourceNode.disconnect(); } catch (_) {} }
    peer.pc.close();
    peer.tileEl.remove();
    peers.delete(id);
    refreshStageLayout();
  }

  // ---------- tiles / video ----------
  function createTile(name) {
    const node = tileTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.tile-name').textContent = name;
    node.querySelector('.avatar-fallback').textContent = initials(name);
    return node;
  }

  function addLocalTile() {
    const tileEl = createTile(`${displayName} (voce)`);
    tileEl.dataset.self = 'true';
    stage.appendChild(tileEl);
    const videoEl = tileEl.querySelector('video');
    videoEl.muted = true;
    videoEl.srcObject = localStream;
    if (localStream.getVideoTracks().length) {
      tileEl.querySelector('.avatar-fallback').style.display = 'none';
    }
    const peer = { videoEl, ring: tileEl.querySelector('.ember-ring'), tileEl, analyser: null, raf: null };
    peers.set('self', peer);
    startAudioMeter(peer, localStream);
  }

  function initials(name) {
    const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map((w) => Array.from(w)[0]?.toUpperCase() || '').join('');
  }

  function refreshStageLayout() {
    const sharingEntry = [...peers.entries()].find(([, p]) => p.tileEl.classList.contains('screen-tile'));
    const relaySharing = [...relayPeers.entries()].find(([id, p]) => id !== '__self_sender' && p.sharingScreen);
    const anySharing = !!(sharingEntry || relaySharing);
    stage.classList.toggle('has-screen', anySharing);
    thumbStrip.hidden = !anySharing;

    peers.forEach((peer, id) => {
      const isSharer = anySharing && sharingEntry && sharingEntry[0] === id;
      const target = anySharing && !isSharer ? thumbStrip : stage;
      if (peer.tileEl.parentElement !== target) target.appendChild(peer.tileEl);
    });

    relayPeers.forEach((rp, id) => {
      if (id === '__self_sender') return;
      const isSharer = anySharing && relaySharing && relaySharing[0] === id;
      const target = anySharing && !isSharer ? thumbStrip : stage;
      if (rp.tileEl.parentElement !== target) target.appendChild(rp.tileEl);
    });
  }

  // ---------- audio meter ----------
  function startAudioMeter(peer, stream) {
    if (!stream.getAudioTracks().length) return;
    const ctx = getRemoteAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const level = Math.min(1, avg / 90);
      peer.ring.style.setProperty('--level', level.toFixed(3));
      const row = participantsList.querySelector(`[data-peer-id="${peer.__id || ''}"]`);
      if (row) row.classList.toggle('speaking', level > 0.15);
      peer.raf = requestAnimationFrame(tick);
    }
    tick();
  }

  // ---------- sons de notificacao ----------
  let notifCtx = null;
  function playNotificationSound(kind) {
    try {
      notifCtx = notifCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = notifCtx.currentTime;
      const notes = kind === 'join' ? [520, 780] : [700, 420];
      notes.forEach((freq, i) => {
        const start = now + i * 0.09;
        const dur = 0.14;
        const osc = notifCtx.createOscillator();
        const gain = notifCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
        gain.gain.linearRampToValueAtTime(0, start + dur);
        osc.connect(gain).connect(notifCtx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.03);
      });
    } catch (_) {}
  }

  // ---------- participantes ----------
  function updateParticipantsList() {
    participantsList.innerHTML = '';
    const allIds = new Set([...peers.keys(), ...relayPeers.keys()].filter((id) => id !== 'self' && id !== '__self_sender'));
    const rows = [{ id: 'self', name: `${displayName} (voce)` }];
    allIds.forEach((id) => {
      const p = peers.get(id) || relayPeers.get(id);
      if (p) rows.push({ id, name: p.name });
    });
    rows.forEach(({ id, name }) => {
      const row = document.createElement('div');
      row.className = 'participant-row';
      row.dataset.peerId = id;
      row.innerHTML = `<span class="dot"></span><span>${escapeHtml(name)}</span>`;
      participantsList.appendChild(row);
      const peer = peers.get(id);
      const rp = relayPeers.get(id);
      if (peer) peer.__id = id;
      if (rp) rp.__id = id;
    });
  }

  // ---------- controles ----------
  const micBtn = document.getElementById('toggle-mic');
  const camBtn = document.getElementById('toggle-cam');
  const screenBtn = document.getElementById('toggle-screen');
  const chatBtn = document.getElementById('toggle-chat');
  const leaveBtn = document.getElementById('leave-call');
  const remoteAudioBtn = document.getElementById('toggle-remote-audio');

  micBtn.addEventListener('click', () => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    micBtn.setAttribute('aria-pressed', String(track.enabled));
  });

  camBtn.addEventListener('click', () => {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    camBtn.setAttribute('aria-pressed', String(track.enabled));
  });

  // ---------- compartilhamento de tela ----------
  let selectedWidth = 1280;
  let selectedHeight = 720;
  let selectedFps = 30;
  const qualityPopover = document.getElementById('quality-popover');

  document.querySelectorAll('.quality-option').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.quality-option').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedWidth = parseInt(btn.dataset.width);
      selectedHeight = parseInt(btn.dataset.height);
      selectedFps = parseInt(btn.dataset.fps);
      qualityPopover.hidden = true;
      startScreenShare();
    });
  });

  screenBtn.addEventListener('click', async () => {
    if (isSharingScreen) {
      stopScreenShare();
      return;
    }
    qualityPopover.hidden = !qualityPopover.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!qualityPopover.hidden && !qualityPopover.contains(e.target) && e.target !== screenBtn && !screenBtn.contains(e.target)) {
      qualityPopover.hidden = true;
    }
  });

  async function startScreenShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: selectedFps, max: selectedFps }, width: { ideal: selectedWidth, max: selectedWidth }, height: { ideal: selectedHeight, max: selectedHeight } },
        audio: true,
      });
    } catch (_) { return; }

    const screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.contentHint = 'motion';

    await sendVideoTrackToPeers(screenTrack, screenStream);

    startRelaySender(screenStream);
    socket.emit('relay-media', { type: 'state', data: true });

    const screenAudioTrack = screenStream.getAudioTracks()[0];
    if (screenAudioTrack) {
      peers.forEach((peer, id) => {
        if (id === 'self') return;
        const audioSender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (audioSender) audioSender.replaceTrack(screenAudioTrack);
      });
    }

    screenTrack.onended = () => stopScreenShare();

    const selfPeer = peers.get('self');
    selfPeer.videoEl.srcObject = screenStream;
    selfPeer.tileEl.querySelector('.avatar-fallback').style.display = 'none';
    selfPeer.tileEl.classList.add('screen-tile');
    selfPeer.tileEl.querySelector('.screen-badge').hidden = false;
    isSharingScreen = true;
    screenBtn.classList.add('active-share');
    socket.emit('screen-share-state', { sharing: true });
    refreshStageLayout();
  }

  function stopScreenShare() {
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    stopRelaySender();
    socket.emit('relay-media', { type: 'state', data: false });

    const micAudioTrack = localStream?.getAudioTracks()[0];
    peers.forEach((peer, id) => {
      if (id === 'self') return;
      const audioSender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (audioSender && micAudioTrack) audioSender.replaceTrack(micAudioTrack);
    });

    const camTrack = localStream?.getVideoTracks()[0];
    if (camTrack) {
      sendVideoTrackToPeers(camTrack, localStream);
    } else {
      peers.forEach((peer, id) => {
        if (id === 'self') return;
        const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) peer.pc.removeTrack(sender);
      });
    }

    const selfPeer = peers.get('self');
    selfPeer.videoEl.srcObject = localStream;
    if (!camTrack || !camTrack.enabled) selfPeer.tileEl.querySelector('.avatar-fallback').style.display = '';
    selfPeer.tileEl.classList.remove('screen-tile');
    selfPeer.tileEl.querySelector('.screen-badge').hidden = true;
    isSharingScreen = false;
    screenBtn.classList.remove('active-share');
    socket.emit('screen-share-state', { sharing: false });
    refreshStageLayout();
  }

  async function sendVideoTrackToPeers(newTrack, stream) {
    const jobs = [];
    peers.forEach((peer, id) => {
      if (id === 'self') return;
      const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(newTrack);
        boostVideoQuality(sender);
      } else {
        peer.pc.addTrack(newTrack, stream);
        const newSender = peer.pc.getSenders().find((s) => s.track === newTrack);
        if (newSender) boostVideoQuality(newSender);
        jobs.push(renegotiate(id, peer.pc));
      }
    });
    await Promise.all(jobs);
  }

  async function renegotiate(id, pc) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: id, data: pc.localDescription });
    } catch (err) {
      console.error('[PulseCord] Falha ao renegociar com', id, ':', err);
    }
  }

  function boostVideoQuality(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 2_500_000;
      params.encodings[0].maxFramerate = 30;
      sender.setParameters(params).catch(() => {});
    } catch (_) {}
  }

  // ---------- mute/unmute live ----------
  remoteAudioBtn.addEventListener('click', () => {
    remoteAudioMuted = !remoteAudioMuted;
    remoteAudioBtn.setAttribute('aria-pressed', String(!remoteAudioMuted));
    remoteAudioBtn.querySelector('.icon').textContent = remoteAudioMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    applyVolumeToAll();
  });

  // ---------- botao direito = volume da live ----------
  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const tile = e.target.closest('.tile');
    if (!tile) return;
    let peerId = null;
    peers.forEach((peer, id) => { if (peer.tileEl === tile) peerId = id; });
    relayPeers.forEach((rp, id) => { if (id !== '__self_sender' && rp.tileEl === tile) peerId = id; });
    if (!peerId || peerId === 'self') return;
    showVolumeOverlay(e, peerId);
  });

  volumeOverlay.addEventListener('wheel', (e) => {
    e.preventDefault();
    liveVolume = Math.max(0, Math.min(1.5, liveVolume + (e.deltaY > 0 ? -0.05 : 0.05)));
    volumeSlider.value = liveVolume;
    updateVolumeLabel();
    applyVolumeToAll();
  });

  // ---------- click esquerdo = tela cheia ----------
  stage.addEventListener('click', (e) => {
    if (volumeOverlay.hidden === false) return;
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const video = tile.querySelector('video');
    const canvas = tile.querySelector('canvas');
    if ((!video || !video.srcObject) && !canvas) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      tile.requestFullscreen().catch(() => {});
    }
  });

  chatBtn.addEventListener('click', () => chatPanel.classList.toggle('hidden'));
  leaveBtn.addEventListener('click', () => teardownAllAndReturnToLobby());

  document.getElementById('copy-invite').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?sala=${roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      const btn = document.getElementById('copy-invite');
      const original = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => (btn.textContent = original), 1500);
    } catch (_) {
      prompt('Copie o link do convite:', url);
    }
  });

  // ---------- chat ----------
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat-message', { text });
    input.value = '';
  });

  function logChat(name, text, isSelf) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="who">${escapeHtml(isSelf ? 'Voce' : name)}</span>${escapeHtml(text)}`;
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function logSystem(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg system';
    el.textContent = text;
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- saida ----------
  function teardownAllAndReturnToLobby(errorMsg) {
    peers.forEach((peer, id) => {
      if (peer.raf) cancelAnimationFrame(peer.raf);
      if (peer.sourceNode) { try { peer.sourceNode.disconnect(); } catch (_) {} }
      if (peer.pc) peer.pc.close();
    });
    relayPeers.forEach((rp, id) => {
      if (id !== '__self_sender') rp.tileEl.remove();
    });
    relayPeers.clear();
    peers.clear();
    stage.innerHTML = '';
    thumbStrip.innerHTML = '';
    thumbStrip.hidden = true;
    chatLog.innerHTML = '';
    stopRelaySender();
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    socket.disconnect();
    callScreen.hidden = true;
    lobby.hidden = false;
    if (errorMsg) lobbyError.textContent = errorMsg;
    socket.connect();
  }

  window.addEventListener('beforeunload', () => {
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  });
})();
