(() => {
  'use strict';

  const FALLBACK_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  let iceServers = FALLBACK_ICE_SERVERS;

  async function loadIceServers() {
    try {
      const res = await fetch('/api/turn-credentials');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const servers = await res.json();
      if (Array.isArray(servers) && servers.length) {
        iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, ...servers];
        console.log('[PulseCord] Usando servidores TURN do Metered:', servers.map((s) => s.urls));
      } else {
        console.log('[PulseCord] Servidor não tem TURN configurado, usando reserva comunitária.');
      }
    } catch (err) {
      console.warn('[PulseCord] Não consegui buscar TURN do servidor, usando reserva comunitária:', err);
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
  const peers = new Map();

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
      if (!res.ok) throw new Error(data.error || 'Não foi possível criar a sala.');
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
      if (!res.ok) throw new Error(data.error || 'Não foi possível entrar na sala.');
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
        lobbyError.textContent = 'Precisamos de acesso ao microfone (e câmera, se quiser vídeo).';
        return;
      }
    }

    await iceServersReady;

    lobby.hidden = true;
    callScreen.hidden = false;
    document.getElementById('room-code-display').textContent = code;

    socket.emit('join-room', { code, displayName: name });
  }

  // ---------- sinalização ----------
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
    if (!peer) peer = createPeerConnection(from, 'Amigo', false);

    if (data.type === 'offer') {
      await peer.pc.setRemoteDescription(data);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: peer.pc.localDescription });
    } else if (data.type === 'answer') {
      await peer.pc.setRemoteDescription(data);
    } else if (data.candidate) {
      try {
        await peer.pc.addIceCandidate(data);
      } catch (_) {}
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
  function createPeerConnection(id, name, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers });
    const tileEl = createTile(name);
    stage.appendChild(tileEl);

    const peer = {
      pc,
      name,
      tileEl,
      videoEl: tileEl.querySelector('video'),
      ring: tileEl.querySelector('.ember-ring'),
      analyser: null,
      raf: null,
      sharingScreen: false,
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
      peer.videoEl.srcObject = e.streams[0];
      peer.tileEl.querySelector('.avatar-fallback').style.display = 'none';
      startAudioMeter(peer, e.streams[0]);

      // Aplica o estado de mute remoto ao receber nova stream
      if (remoteAudioMuted) {
        e.streams[0].getAudioTracks().forEach((t) => { t.enabled = false; });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[PulseCord] ICE com', name, ':', pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        // peer-left do servidor cuida da limpeza visual
      }
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
    peer.pc.close();
    peer.tileEl.remove();
    peers.delete(id);
    refreshStageLayout();
  }

  // ---------- tiles / vídeo ----------
  function createTile(name) {
    const node = tileTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.tile-name').textContent = name;
    node.querySelector('.avatar-fallback').textContent = initials(name);
    return node;
  }

  function addLocalTile() {
    const tileEl = createTile(`${displayName} (você)`);
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
    const words = name
      .replace(/\(.*?\)/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return words
      .slice(0, 2)
      .map((w) => Array.from(w)[0]?.toUpperCase() || '')
      .join('');
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

  // ---------- brilho reativo ao áudio ----------
  function startAudioMeter(peer, stream) {
    if (!stream.getAudioTracks().length) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
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

  // ---------- sons de notificação ----------
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

  // ---------- lista de participantes ----------
  function updateParticipantsList() {
    participantsList.innerHTML = '';
    const rows = [{ id: 'self', name: `${displayName} (você)` }, ...[...peers.entries()]
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

  screenBtn.addEventListener('click', async () => {
    if (!isSharingScreen) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 60, max: 60 },
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
          },
          audio: true,
        });
      } catch (_) {
        return;
      }
      const screenTrack = screenStream.getVideoTracks()[0];
      screenTrack.contentHint = 'motion';

      await sendVideoTrackToPeers(screenTrack, screenStream);

      // Envia o áudio da tela se existir
      const screenAudioTrack = screenStream.getAudioTracks()[0];
      if (screenAudioTrack) {
        peers.forEach((peer, id) => {
          if (id === 'self') return;
          const existingAudioSender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio' && s.track !== localStream?.getAudioTracks()[0]);
          if (existingAudioSender) {
            existingAudioSender.replaceTrack(screenAudioTrack);
          } else {
            peer.pc.addTrack(screenAudioTrack, screenStream);
            renegotiate(id, peer.pc);
          }
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
    } else {
      stopScreenShare();
    }
  });

  function stopScreenShare() {
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());

    // Volta o áudio do microfone para todos os peers
    const micAudioTrack = localStream?.getAudioTracks()[0];
    peers.forEach((peer, id) => {
      if (id === 'self') return;
      const audioSender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (audioSender && micAudioTrack) {
        audioSender.replaceTrack(micAudioTrack);
      }
    });

    const camTrack = localStream.getVideoTracks()[0];
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
      params.encodings[0].maxBitrate = 8_000_000;
      params.encodings[0].maxFramerate = 60;
      sender.setParameters(params).catch(() => {});
    } catch (_) {}
  }

  // ---------- botão de áudio remoto (mute/unmute da live) ----------
  remoteAudioBtn.addEventListener('click', () => {
    remoteAudioMuted = !remoteAudioMuted;
    remoteAudioBtn.setAttribute('aria-pressed', String(!remoteAudioMuted));
    remoteAudioBtn.querySelector('.icon').textContent = remoteAudioMuted ? '🔇' : '🔊';

    // Aplica a todos os peers
    peers.forEach((peer, id) => {
      if (id === 'self') return;
      const stream = peer.videoEl.srcObject;
      if (stream) {
        stream.getAudioTracks().forEach((t) => { t.enabled = !remoteAudioMuted; });
      }
    });
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
    el.innerHTML = `<span class="who">${escapeHtml(isSelf ? 'Você' : name)}</span>${escapeHtml(text)}`;
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

  // ---------- saída ----------
  function teardownAllAndReturnToLobby(errorMsg) {
    peers.forEach((peer, id) => {
      if (peer.raf) cancelAnimationFrame(peer.raf);
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
