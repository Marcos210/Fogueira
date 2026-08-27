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

  // ---------- toast (avisos na tela) ----------
  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  function showToast(msg, ms = 4500) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  // ---------- estado ----------
  let selfId = null;
  let displayName = '';
  let roomCode = '';
  let localStream = null;
  let screenStream = null;
  let isSharingScreen = false;
  let remoteAudioMuted = false;
  let liveVolume = 1.0;
  const peers = new Map();       // id -> conexao WebRTC
  const relayPeers = new Map();  // id -> tile recebido via relay
  const peerNames = new Map();   // id -> nome real do peer

  // ---------- relay sender state ----------
  let relayVideoInterval = null;
  let relaySenderNodes = null; // { videoEl, processor, source, silentGain }

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

  function showVolumeOverlay(e, peerId) {
    volumeSlider.value = liveVolume;
    updateVolumeLabel();
    volumeOverlay.hidden = false;
    // position:fixed -> coordenadas de viewport direto
    const pad = 60;
    const x = Math.max(pad, Math.min(e.clientX, window.innerWidth - pad));
    const y = Math.max(pad, Math.min(e.clientY - 20, window.innerHeight - pad));
    volumeOverlay.style.left = x + 'px';
    volumeOverlay.style.top = y + 'px';
  }

  function hideVolumeOverlay() {
    volumeOverlay.hidden = true;
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
    const v = remoteAudioMuted ? 0 : liveVolume;
    peers.forEach((peer, id) => {
      if (id === 'self') return;
      if (peer.gainNode) peer.gainNode.gain.value = v;
    });
    relayPeers.forEach((rp) => {
      if (rp.gainNode) rp.gainNode.gain.value = v;
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
    existingPeers.forEach((p) => {
      peerNames.set(p.id, p.name);
      createPeerConnection(p.id, p.name, true);
    });
    updateParticipantsList();
  });

  socket.on('peer-joined', ({ id, name }) => {
    peerNames.set(id, name);
    createPeerConnection(id, name, false);
    updateParticipantsList();
    logSystem(`${name} entrou na sala.`);
    playNotificationSound('join');
  });

  socket.on('peer-left', ({ id }) => {
    const name = peerNames.get(id) || peers.get(id)?.name || relayPeers.get(id)?.name || 'Alguem';
    logSystem(`${name} saiu.`);
    peerNames.delete(id);
    if (peers.has(id)) teardownPeer(id);
    if (relayPeers.has(id)) teardownRelayPeer(id);
    updateParticipantsList();
    playNotificationSound('leave');
  });

  socket.on('signal', async ({ from, data }) => {
    let peer = peers.get(from);
    if (data.type === 'offer') {
      // Offer nova: derruba conexao antiga E tile relay desse peer pra nao duplicar
      if (peer) teardownPeer(from);
      if (relayPeers.has(from)) teardownRelayPeer(from);
      peer = createPeerConnection(from, peerNames.get(from) || 'Amigo', false);
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
        if (peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(data);
        }
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
  let pendingRelaySharers = [];

  socket.on('relay-sharers', ({ ids }) => {
    pendingRelaySharers = ids || [];
    applyPendingRelaySharers();
  });

  function applyPendingRelaySharers() {
    pendingRelaySharers.forEach((id) => {
      const rp = relayPeers.get(id);
      if (rp && !rp.sharingScreen) {
        rp.sharingScreen = true;
        rp.tileEl.classList.add('screen-tile');
        rp.tileEl.querySelector('.screen-badge').hidden = false;
      }
    });
    refreshStageLayout();
  }

  // O outro lado avisou que desistiu do WebRTC comigo — entro em relay com ele tambem
  socket.on('relay-mode', ({ from }) => {
    if (from === selfId || relayPeers.has(from)) return;
    const peer = peers.get(from);
    if (peer) teardownPeer(from);
    createRelayPeer(from, peerNames.get(from) || 'Amigo');
    socket.emit('relay-subscribe');
    updateParticipantsList();
  });

  socket.on('relay-media', ({ from, type, data }) => {
    // Se ja tenho WebRTC conectado com essa pessoa, ignoro o relay (evita tile duplicado)
    const wp = peers.get(from);
    if (wp && wp.pc.connectionState === 'connected' && type !== 'state') return;

    let rp = relayPeers.get(from);
    if (!rp) rp = createRelayPeer(from, peerNames.get(from) || 'Amigo');

    if (type === 'video' && data) {
      const img = new Image();
      img.onload = () => {
        // Letterbox: mantem aspect ratio sem distorcer
        const cw = rp.canvas.width, ch = rp.canvas.height;
        rp.ctx.fillStyle = '#000';
        rp.ctx.fillRect(0, 0, cw, ch);
        const scale = Math.min(cw / img.width, ch / img.height);
        const w = img.width * scale, h = img.height * scale;
        rp.ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
        rp.tileEl.querySelector('.avatar-fallback').style.display = 'none';
      };
      img.src = 'data:image/jpeg;base64,' + data;
    } else if ((type === 'audio' || type === 'mic') && data) {
      try {
        const buf = data instanceof ArrayBuffer ? data : Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer;
        const int16 = new Int16Array(buf);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
        const audioCtx = rp.audioCtx;
        const buffer = audioCtx.createBuffer(1, float32.length, 16000);
        buffer.getChannelData(0).set(float32);

        // Jitter buffer: agenda chunks em sequencia suave
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(rp.gainNode);
        const now = audioCtx.currentTime;
        if (rp.nextTime === undefined || rp.nextTime < now) rp.nextTime = now + 0.05;
        source.start(rp.nextTime);
        rp.nextTime += buffer.duration;
      } catch (_) {}
    } else if (type === 'state') {
      rp.sharingScreen = !!data;
      rp.tileEl.classList.toggle('screen-tile', rp.sharingScreen);
      rp.tileEl.querySelector('.screen-badge').hidden = !rp.sharingScreen;
      if (!rp.sharingScreen) {
        rp.ctx.fillStyle = '#000';
        rp.ctx.fillRect(0, 0, rp.canvas.width, rp.canvas.height);
      }
      refreshStageLayout();
    }
  });

  function createRelayPeer(id, name) {
    const tileEl = createTile(name);
    stage.appendChild(tileEl);

    const videoEl = tileEl.querySelector('video');
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
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
      nextTime: undefined,
      sharingScreen: false,
    };
    relayPeers.set(id, rp);
    startMicRelay(); // garante que meu mic chega pra quem so tem relay comigo
    applyPendingRelaySharers();
    refreshStageLayout();
    return rp;
  }

  function teardownRelayPeer(id) {
    const rp = relayPeers.get(id);
    if (!rp) return;
    if (rp.gainNode) { try { rp.gainNode.disconnect(); } catch (_) {} }
    rp.tileEl.remove();
    relayPeers.delete(id);
    if (relayPeers.size === 0) stopMicRelay();
    refreshStageLayout();
  }

  // ---------- RELAY: microfone (quem so tem relay comigo precisa me ouvir) ----------
  let micRelayNodes = null;

  function startMicRelay() {
    if (micRelayNodes) return;
    const micTrack = localStream?.getAudioTracks()[0];
    if (!micTrack) return;
    const audioCtx = getRemoteAudioCtx();
    const source = audioCtx.createMediaStreamSource(localStream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0; // sem eco: o mic NAO volta pros meus alto-falantes
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioCtx.destination);
    const ratio = Math.max(1, Math.round(audioCtx.sampleRate / 16000));
    processor.onaudioprocess = (e) => {
      if (relayPeers.size === 0) return;
      if (!micTrack.enabled) return; // mic mutado = nao envia
      const input = e.inputBuffer.getChannelData(0);
      const outLen = Math.floor(input.length / ratio);
      if (outLen < 1) return;
      const int16 = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const s = Math.max(-1, Math.min(1, input[i * ratio]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      socket.emit('relay-media', { type: 'mic', data: int16.buffer });
    };
    micRelayNodes = { source, processor, silentGain };
  }

  function stopMicRelay() {
    if (!micRelayNodes) return;
    try { micRelayNodes.processor.disconnect(); } catch (_) {}
    try { micRelayNodes.source.disconnect(); } catch (_) {}
    try { micRelayNodes.silentGain.disconnect(); } catch (_) {}
    micRelayNodes = null;
  }

  // ---------- RELAY: enviar midia via Socket.io ----------
  function startRelaySender(stream) {
    stopRelaySender(); // garante que nao duplica

    const videoEl = document.createElement('video');
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    let relayQuality = 0.7;
    relayVideoInterval = setInterval(() => {
      if (!isSharingScreen) return;
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      if (!vw || !vh) return;
      // Max 1280 de largura, mantem aspect ratio real
      const scale = Math.min(1, 1280 / vw);
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      let b64 = canvas.toDataURL('image/jpeg', relayQuality).split(',')[1];
      // Se frame > 200KB, reduz qualidade automaticamente
      if (b64.length > 200_000 && relayQuality > 0.4) {
        relayQuality = Math.max(0.4, relayQuality - 0.1);
        b64 = canvas.toDataURL('image/jpeg', relayQuality).split(',')[1];
      } else if (b64.length < 80_000 && relayQuality < 0.8) {
        relayQuality = Math.min(0.8, relayQuality + 0.05);
      }
      socket.emit('relay-media', { type: 'video', data: b64 });
    }, 50); // ~20fps

    // Audio: PCM 16kHz mono, sem eco (silent gain) e sem throttle
    if (stream.getAudioTracks().length) {
      const audioCtx = getRemoteAudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0; // FIX: sem isso, quem compartilha ouve o proprio audio (echo)
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      // Ratio real de downsample baseado no sampleRate do contexto (48k->3, 44.1k->3)
      const ratio = Math.max(1, Math.round(audioCtx.sampleRate / 16000));

      processor.onaudioprocess = (e) => {
        if (!isSharingScreen) return;
        const input = e.inputBuffer.getChannelData(0);
        const outLen = Math.floor(input.length / ratio);
        if (outLen < 1) return;
        const int16 = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const s = Math.max(-1, Math.min(1, input[i * ratio]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        socket.emit('relay-media', { type: 'audio', data: int16.buffer });
      };

      relaySenderNodes = { videoEl, processor, source, silentGain };
    } else {
      relaySenderNodes = { videoEl };
    }
  }

  function stopRelaySender() {
    if (relaySenderNodes) {
      try { relaySenderNodes.processor.disconnect(); } catch (_) {}
      try { relaySenderNodes.source.disconnect(); } catch (_) {}
      try { relaySenderNodes.silentGain.disconnect(); } catch (_) {}
      if (relaySenderNodes.videoEl.srcObject) {
        // Nao paramos os tracks daqui (o screenStream dono cuida disso)
        relaySenderNodes.videoEl.srcObject = null;
      }
      relaySenderNodes = null;
    }
    if (relayVideoInterval) {
      clearInterval(relayVideoInterval);
      relayVideoInterval = null;
    }
  }

  function enterRelayMode(id, name) {
    if (relayPeers.has(id)) return; // ja esta em relay
    console.log('[PulseCord] Entrando em modo RELAY com', name);
    const peer = peers.get(id);
    if (peer) teardownPeer(id);
    createRelayPeer(id, name);
    socket.emit('relay-subscribe');      // quero receber relay
    socket.emit('relay-mode', { to: id }); // avisa o outro lado pra fazer o mesmo
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
      const stream = e.streams[0];
      if (!stream) return;
      peer.tileEl.querySelector('.avatar-fallback').style.display = 'none';
      if (e.track.kind === 'video') peer.videoEl.srcObject = stream;
      peer.videoEl.muted = true; // audio sempre via GainNode
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
    const relayAttempted = forceRelay || false;

    // Timeout: se nao conectar em 12s, vai pro relay (em vez de esperar ICE eternamente)
    const connectTimeout = setTimeout(() => {
      if (pc.connectionState !== 'connected' && pc.iceConnectionState !== 'connected' && !relayAttempted) {
        console.log('[PulseCord] Timeout de conexao com', name, '— fallback para RELAY');
        enterRelayMode(id, name);
      }
    }, 12000);

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;

      if (state === 'disconnected') {
        disconnectTimer = setTimeout(async () => {
          if (pc.iceConnectionState === 'disconnected' && iceRestartCount < 3) {
            iceRestartCount++;
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              socket.emit('signal', { to: id, data: pc.localDescription });
            } catch (_) {}
          }
        }, 3000);
      } else if (state === 'failed') {
        clearTimeout(connectTimeout);
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
        if (!relayAttempted && !relayPeers.has(id)) {
          console.log('[PulseCord] WebRTC falhou com', name, '— fallback para RELAY');
          enterRelayMode(id, name);
        }
      } else if (state === 'connected' || state === 'completed') {
        clearTimeout(connectTimeout);
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
        iceRestartCount = 0;
      }
    };

    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: id, data: pc.localDescription });
        } catch (err) {
          console.warn('[PulseCord] Erro na negociacao:', err.message);
        }
      };
    }

    return peer;
  }

  function teardownPeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    if (peer.raf) cancelAnimationFrame(peer.raf);
    if (peer.sourceNode) { try { peer.sourceNode.disconnect(); } catch (_) {} }
    if (peer.gainNode) { try { peer.gainNode.disconnect(); } catch (_) {} }
    try { peer.pc.close(); } catch (_) {}
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
    // Prioridade: MEU share ocupa o palco (senao eu nao vejo a minha propria live);
    // senao, o primeiro outro sharer (WebRTC ou relay)
    let sharerId = null;
    const selfPeer = peers.get('self');
    if (selfPeer && selfPeer.tileEl.classList.contains('screen-tile')) {
      sharerId = 'self';
    } else {
      const sharingEntry = [...peers.entries()].find(([id, p]) => id !== 'self' && p.tileEl.classList.contains('screen-tile'));
      if (sharingEntry) {
        sharerId = sharingEntry[0];
      } else {
        const relaySharing = [...relayPeers.entries()].find(([, p]) => p.sharingScreen);
        if (relaySharing) sharerId = relaySharing[0];
      }
    }
    const anySharing = !!sharerId;
    stage.classList.toggle('has-screen', anySharing);
    thumbStrip.hidden = !anySharing;

    peers.forEach((peer, id) => {
      const target = anySharing && id !== sharerId ? thumbStrip : stage;
      if (peer.tileEl.parentElement !== target) target.appendChild(peer.tileEl);
    });
    relayPeers.forEach((rp, id) => {
      const target = anySharing && id !== sharerId ? thumbStrip : stage;
      if (rp.tileEl.parentElement !== target) target.appendChild(rp.tileEl);
    });
  }

  // ---------- audio meter ----------
  function startAudioMeter(peer, stream) {
    if (!stream.getAudioTracks().length) return;
    try {
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
    } catch (_) {}
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
    const allIds = new Set();
    peers.forEach((_, id) => { if (id !== 'self') allIds.add(id); });
    relayPeers.forEach((_, id) => allIds.add(id));
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

  // ---------- compartilhamento de tela com seletor de qualidade ----------
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

  screenBtn.addEventListener('click', () => {
    if (isSharingScreen) {
      stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showToast('Seu navegador não suporta compartilhamento de tela. Use Chrome ou Edge no computador.');
      return;
    }
    qualityPopover.hidden = !qualityPopover.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!qualityPopover.hidden && !qualityPopover.contains(e.target) && !screenBtn.contains(e.target)) {
      qualityPopover.hidden = true;
    }
  });

  async function startScreenShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: selectedFps, max: selectedFps },
          width: { ideal: selectedWidth, max: selectedWidth },
          height: { ideal: selectedHeight, max: selectedHeight },
        },
        audio: true,
        selfBrowserSurface: 'exclude',  // nao deixa compartilhar a propria aba (evita efeito espelho)
        surfaceSwitching: 'include',    // trocar de janela sem parar a live
        systemAudio: 'include',         // permite capturar audio do sistema
      });
    } catch (err) {
      if (err?.name === 'NotAllowedError') showToast('Compartilhamento cancelado ou permissão negada.');
      else showToast('Não foi possível compartilhar a tela (' + (err?.name || 'erro desconhecido') + ').');
      return;
    }

    const screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.contentHint = 'motion';

    // WebRTC pra quem tem conexao
    await sendVideoTrackToPeers(screenTrack, screenStream);

    // Relay pra quem nao tem (server filtra: so recebe quem pediu relay-subscribe)
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
      console.warn('[PulseCord] Falha ao renegociar:', err.message);
    }
  }

  function boostVideoQuality(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = selectedHeight >= 1080 ? 6_000_000 : 2_500_000;
      params.encodings[0].maxFramerate = selectedFps;
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
    relayPeers.forEach((rp, id) => { if (rp.tileEl === tile) peerId = id; });
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
    stopRelaySender(); // ANTES de limpar os mapas (usa relaySenderNodes)
    stopMicRelay();
    isSharingScreen = false;
    peers.forEach((peer, id) => {
      if (peer.raf) cancelAnimationFrame(peer.raf);
      if (peer.sourceNode) { try { peer.sourceNode.disconnect(); } catch (_) {} }
      if (peer.gainNode) { try { peer.gainNode.disconnect(); } catch (_) {} }
      if (peer.pc) { try { peer.pc.close(); } catch (_) {} }
    });
    relayPeers.forEach((rp) => {
      if (rp.gainNode) { try { rp.gainNode.disconnect(); } catch (_) {} }
      rp.tileEl.remove();
    });
    peers.clear();
    relayPeers.clear();
    peerNames.clear();
    stage.innerHTML = '';
    thumbStrip.innerHTML = '';
    thumbStrip.hidden = true;
    chatLog.innerHTML = '';
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    screenStream = null;
    socket.disconnect();
    callScreen.hidden = true;
    lobby.hidden = false;
    if (errorMsg) lobbyError.textContent = errorMsg;
    socket.connect();
  }

  window.addEventListener('beforeunload', () => {
    stopRelaySender();
    stopMicRelay();
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  });
})();
