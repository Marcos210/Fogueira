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
  let liveVolume = 1.0; // 0 a 1.5 (150%)
  const peers = new Map();

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
    const pct = Math.round(liveVolume * 100);
    volumeValue.textContent = pct + '%';
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
  }

  document.addEventListener('click', (e) => {
    if (!volumeOverlay.hidden && !volumeOverlay.contains(e.target)) {
      hideVolumeOverlay();
    }
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
      if (!res.ok) throw new Error(data.error || 'Nao foi possivel criar a sala.');
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
      if (!res.ok) throw new Error(data.error || 'Nao foi possivel entrar na sala.');
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
    updateParticipantsList();
    playNotificationSound('leave');
  });

  socket.on('signal', async ({ from, data }) => {
    let peer = peers.get(from);

    // Se recebemos uma offer nova, sempre destrói a conexão antiga e recria
    if (data.type === 'offer') {
      if (peer) teardownPeer(from);
      peer = createPeerConnection(from, 'Amigo', false);
    } else if (!peer) {
      return; // Ignora answer/candidate de peer desconhecido
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
    if (!peer) return;
    peer.sharingScreen = sharing;
    peer.tileEl.classList.toggle('screen-tile', sharing);
    peer.tileEl.querySelector('.screen-badge').hidden = !sharing;
    refreshStageLayout();
  });

  socket.on('error-message', (msg) => {
    teardownAllAndReturnToLobby(msg);
  });

  // ---------- WebRTC ----------
  function createPeerConnection(id, name, isInitiator, forceRelay) {
    const pcConfig = { iceServers };
    if (forceRelay) {
      pcConfig.iceTransportPolicy = 'relay';
      console.log('[PulseCord] Conectando em modo RELAY com', name);
    }
    const pc = new RTCPeerConnection(pcConfig);
    const tileEl = createTile(name);
    stage.appendChild(tileEl);

    const audioCtx = getRemoteAudioCtx();
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = remoteAudioMuted ? 0 : liveVolume;
    gainNode.connect(audioCtx.destination);

    const peer = {
      pc,
      name,
      tileEl,
      videoEl: tileEl.querySelector('video'),
      ring: tileEl.querySelector('.ember-ring'),
      analyser: null,
      raf: null,
      sharingScreen: false,
      audioCtx,
      gainNode,
      sourceNode: null,
    };
    peers.set(id, peer);
    refreshStageLayout();

    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('signal', { to: id, data: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      console.log('[PulseCord] ontrack de', name, '— kind:', e.track.kind);
      const stream = e.streams[0];
      if (!stream) return;

      peer.tileEl.querySelector('.avatar-fallback').style.display = 'none';

      // Video: sempre no elemento
      if (e.track.kind === 'video') {
        peer.videoEl.srcObject = stream;
      }

      // Audio: SEMPRE mudo o <video> e rodo pelo GainNode (controle de volume 0-150%)
      peer.videoEl.muted = true;
      if (e.track.kind === 'audio') {
        if (peer.sourceNode) {
          try { peer.sourceNode.disconnect(); } catch (_) {}
        }
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
          // P2P falhou — reconecta forçando relay (TURN)
          console.log('[PulseCord] P2P falhou com', name, '— reconectando via RELAY...');
          teardownPeer(id);
          setTimeout(() => {
            createPeerConnection(id, name, true, true);
            updateParticipantsList();
          }, 500);
        } else {
          console.log('[PulseCord] Relay tambem falhou com', name, '— conexao impossivel');
        }
        return;
      } else {
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
        if (state === 'connected' || state === 'completed') {
          iceRestartCount = 0;
        }
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
    const anySharing = !!sharingEntry;
    stage.classList.toggle('has-screen', anySharing);
    thumbStrip.hidden = !anySharing;

    peers.forEach((peer, id) => {
      const isSharer = anySharing && sharingEntry[0] === id;
      const target = anySharing && !isSharer ? thumbStrip : stage;
      if (peer.tileEl.parentElement !== target) target.appendChild(peer.tileEl);
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
    const rows = [{ id: 'self', name: `${displayName} (voce)` }, ...[...peers.entries()]
      .filter(([id]) => id !== 'self')
      .map(([id, p]) => ({ id, name: p.name }))];

    rows.forEach(({ id, name }) => {
      const row = document.createElement('div');
      row.className = 'participant-row';
      row.dataset.peerId = id;
      row.innerHTML = `<span class="dot"></span><span>${escapeHtml(name)}</span>`;
      participantsList.appendChild(row);
      const peer = peers.get(id);
      if (peer) peer.__id = id;
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
  screenBtn.addEventListener('click', async () => {
    if (!isSharingScreen) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 30, max: 30 },
            width: { ideal: 1280, max: 1280 },
            height: { ideal: 720, max: 720 },
          },
          audio: true,
        });
      } catch (_) {
        return;
      }

      console.log('[PulseCord] Screen share audio tracks:', screenStream.getAudioTracks().length);

      const screenTrack = screenStream.getVideoTracks()[0];
      screenTrack.contentHint = 'motion';

      // Envia video da tela
      await sendVideoTrackToPeers(screenTrack, screenStream);

      // Envia audio da tela substituindo o microfone
      const screenAudioTrack = screenStream.getAudioTracks()[0];
      if (screenAudioTrack) {
        console.log('[PulseCord] Enviando audio da tela');
        peers.forEach((peer, id) => {
          if (id === 'self') return;
          const audioSender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
          if (audioSender) {
            audioSender.replaceTrack(screenAudioTrack);
          }
        });
      } else {
        console.log('[PulseCord] Nenhum track de audio na tela (-browser nao suporta ou usuario nao marcou "compartilhar audio")');
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
    } else {
      stopScreenShare();
    }
  });

  function stopScreenShare() {
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());

    // Volta audio do microfone
    const micAudioTrack = localStream?.getAudioTracks()[0];
    peers.forEach((peer, id) => {
      if (id === 'self') return;
      const audioSender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (audioSender && micAudioTrack) {
        audioSender.replaceTrack(micAudioTrack);
      }
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
    if (!camTrack || !camTrack.enabled) {
      selfPeer.tileEl.querySelector('.avatar-fallback').style.display = '';
    }
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

    // Encontra o peer desse tile
    let peerId = null;
    peers.forEach((peer, id) => {
      if (peer.tileEl === tile) peerId = id;
    });
    if (!peerId || peerId === 'self') return;

    showVolumeOverlay(e, peerId);
  });

  // Scroll no volume overlay = ajusta volume
  volumeOverlay.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    liveVolume = Math.max(0, Math.min(1.5, liveVolume + delta));
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
    if (!video || !video.srcObject) return;

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
    peers.clear();
    stage.innerHTML = '';
    thumbStrip.innerHTML = '';
    thumbStrip.hidden = true;
    chatLog.innerHTML = '';
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
