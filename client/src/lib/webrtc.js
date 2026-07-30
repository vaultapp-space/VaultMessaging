// ============================================================
// Vault — Persistent WebRTC Call Manager
// Owns the RTCPeerConnection, media streams, and E2EE signaling
// relay for the lifetime of a call, independent of which
// conversation is currently open. This is what lets a call
// survive the user navigating to a different chat (mini call bar).
// ============================================================

import { get, writable } from 'svelte/store';
import { activeCall, recentCalls, currentUser } from './stores/session.js';
import { onWsEvent, wsSend } from './api/ws.js';
import { fetchTurnCredentials, sendClientDebugLog } from './api/http.js';
import { encrypt as encryptSelf, decrypt as decryptSelf, importStaticKey } from './crypto/keys.js';
import { toBase64 } from './crypto/utils.js';

// ─── Reactive state (safe to import from any component) ───────
export const localStreamStore = writable(null);
export const remoteStreamStore = writable(null);
export const micMuted = writable(false);
export const cameraOff = writable(false);
export const remoteMicMuted = writable(false);
export const remoteCameraOff = writable(false);
export const isScreenSharing = writable(false);
export const verificationWords = writable('');
export const dataChannelReady = writable(false);
export const p2pFileTransferState = writable({
  role: null, // 'sender' | 'receiver'
  filename: '',
  mimeType: '',
  size: 0,
  progress: 0,
  status: 'idle', // 'idle' | 'sending' | 'receiving' | 'completed' | 'failed'
  error: ''
});

// ─── Non-reactive transport state (module-scoped, persistent) ─
let peerConnection = null;
let peerConnectionPromise = null;
let localStream = null;
let localStreamPromise = null;
let screenStream = null;
let iceCandidatesQueue = [];
let fileDataChannel = null;
let currentCallKey = null;
let sentInitialMediaState = false;

export const isScreenShareSupported = typeof navigator !== 'undefined' &&
  navigator.mediaDevices &&
  typeof navigator.mediaDevices.getDisplayMedia === 'function';

function resetP2pState() {
  p2pFileTransferState.set({
    role: null, filename: '', mimeType: '', size: 0, progress: 0, status: 'idle', error: ''
  });
}

function setupDataChannel(channel) {
  if (!channel) return;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 65536; // 64KB threshold

  let receivedChunks = [];
  let receivedSize = 0;

  channel.onopen = () => {
    console.log('[P2P] DataChannel opened');
    dataChannelReady.set(true);
  };

  channel.onclose = () => {
    console.log('[P2P] DataChannel closed');
    dataChannelReady.set(false);
    const state = get(p2pFileTransferState);
    if (state.status === 'sending' || state.status === 'receiving') {
      p2pFileTransferState.set({ ...state, status: 'failed', error: 'Connection closed' });
    }
  };

  channel.onerror = (err) => {
    console.error('[P2P] DataChannel error:', err);
    p2pFileTransferState.update(s => ({ ...s, status: 'failed', error: 'Channel error' }));
  };

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        const meta = JSON.parse(event.data);
        if (meta.type === 'start') {
          p2pFileTransferState.set({
            role: 'receiver',
            filename: meta.filename,
            mimeType: meta.mimeType,
            size: meta.size,
            progress: 0,
            status: 'receiving',
            error: ''
          });
          receivedChunks = [];
          receivedSize = 0;
        } else if (meta.type === 'end') {
          const state = get(p2pFileTransferState);
          const blob = new Blob(receivedChunks, { type: state.mimeType });
          const url = URL.createObjectURL(blob);

          const a = document.createElement('a');
          a.href = url;
          a.download = state.filename;
          a.click();

          p2pFileTransferState.set({ ...state, status: 'completed', progress: 100 });

          setTimeout(() => {
            URL.revokeObjectURL(url);
            p2pFileTransferState.update(s => ({ ...s, status: 'idle' }));
          }, 3000);
        }
      } catch (e) {
        console.error('[P2P] Failed to parse metadata:', e);
      }
    } else {
      receivedChunks.push(event.data);
      receivedSize += event.data.byteLength;
      p2pFileTransferState.update(s => ({
        ...s,
        progress: Math.min(99, Math.round((receivedSize / s.size) * 100))
      }));
    }
  };
}

export function startP2PFileSend(file) {
  if (!file || !fileDataChannel || fileDataChannel.readyState !== 'open') {
    alert('P2P connection is not ready for file transfer.');
    return;
  }

  p2pFileTransferState.set({
    role: 'sender',
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    progress: 0,
    status: 'sending',
    error: ''
  });

  fileDataChannel.send(JSON.stringify({
    type: 'start',
    filename: file.name,
    mimeType: file.type,
    size: file.size
  }));

  const chunkSize = 16384; // 16KB
  let offset = 0;
  const fileReader = new FileReader();

  const sendChunk = () => {
    if (fileDataChannel.readyState !== 'open') return;

    if (fileDataChannel.bufferedAmount > 65536) {
      fileDataChannel.onbufferedamountlow = () => {
        fileDataChannel.onbufferedamountlow = null;
        sendChunk();
      };
      return;
    }

    if (offset < file.size) {
      const slice = file.slice(offset, offset + chunkSize);
      fileReader.readAsArrayBuffer(slice);
    } else {
      fileDataChannel.send(JSON.stringify({ type: 'end' }));
      p2pFileTransferState.update(s => ({ ...s, status: 'completed' }));

      setTimeout(() => {
        p2pFileTransferState.update(s => ({ ...s, status: 'idle' }));
      }, 3000);
    }
  };

  fileReader.onload = (event) => {
    const buffer = event.target.result;
    if (fileDataChannel && fileDataChannel.readyState === 'open') {
      fileDataChannel.send(buffer);
      offset += buffer.byteLength;
      p2pFileTransferState.update(s => ({ ...s, progress: Math.round((offset / file.size) * 100) }));
      sendChunk();
    }
  };

  sendChunk();
}

async function calculateVerificationWords() {
  if (!currentCallKey) {
    verificationWords.set('');
    return;
  }
  try {
    const rawKey = await crypto.subtle.exportKey('raw', currentCallKey);
    const hash = await crypto.subtle.digest('SHA-256', rawKey);
    const hashArray = new Uint8Array(hash);
    const wordList = [
      'Amber', 'Bronze', 'Cobalt', 'Diamond', 'Emerald', 'Forest', 'Garnet', 'Hazel',
      'Indigo', 'Jade', 'Krypton', 'Lemon', 'Magenta', 'Neon', 'Onyx', 'Pearl'
    ];
    const word1 = wordList[hashArray[0] % 16];
    const word2 = wordList[hashArray[1] % 16];
    const word3 = wordList[hashArray[2] % 16];
    verificationWords.set(`${word1} ${word2} ${word3}`);
  } catch (e) {
    console.error('Failed to calculate call verification words:', e);
    verificationWords.set('');
  }
}

async function encryptStaticSignalingPayload(payloadObj) {
  if (!currentCallKey) throw new Error('No call session key active');
  const plaintext = JSON.stringify(payloadObj);
  const { iv, ciphertext } = await encryptSelf(currentCallKey, plaintext);
  return { iv, ciphertext };
}

async function decryptStaticSignalingPayload(data) {
  if (!currentCallKey) throw new Error('No call session key active');
  const plaintext = await decryptSelf(currentCallKey, data.iv, data.ciphertext);
  return JSON.parse(plaintext);
}

function initializePeerConnection(peerId) {
  if (peerConnectionPromise) return peerConnectionPromise;

  peerConnectionPromise = (async () => {
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

    try {
      const data = await fetchTurnCredentials();
      if (data && data.iceServers) {
        iceServers = data.iceServers;
      }
    } catch (e) {
      console.warn('Failed to fetch ephemeral TURN credentials, falling back to public STUN:', e);
      sendClientDebugLog('fetchTurnCredentials failed', e);
    }

    try {
      peerConnection = new RTCPeerConnection({ iceServers });
    } catch (e) {
      sendClientDebugLog('RTCPeerConnection instantiation failed', e);
      throw e;
    }

    if (localStream) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }

    peerConnection.ondatachannel = (event) => {
      if (event.channel.label === 'file-transfer') {
        fileDataChannel = event.channel;
        setupDataChannel(fileDataChannel);
      }
    };

    peerConnection.ontrack = (event) => {
      remoteStreamStore.set(event.streams[0]);
    };

    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection?.iceConnectionState;
      if (state === 'failed') {
        peerConnection.restartIce();
      } else if (state === 'disconnected') {
        setTimeout(() => {
          if (peerConnection?.iceConnectionState === 'disconnected') {
            peerConnection.restartIce();
          }
        }, 5000);
      }
    };

    peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        try {
          const encrypted = await encryptStaticSignalingPayload(event.candidate);
          wsSend({ type: 'webrtc_ice', recipientId: peerId, ...encrypted });
        } catch (e) {
          console.error('Failed to encrypt ICE candidate:', e);
          sendClientDebugLog('Failed to encrypt ICE candidate', e);
        }
      }
    };
  })();

  return peerConnectionPromise;
}

let offerNegotiationStarted = false;
async function startOfferNegotiation(peerId) {
  if (offerNegotiationStarted) return;
  offerNegotiationStarted = true;
  try {
    await initializePeerConnection(peerId);
    if (!localStream) throw new Error('localStream is null inside startOfferNegotiation');
    if (!peerConnection) throw new Error('peerConnection is null inside startOfferNegotiation');

    fileDataChannel = peerConnection.createDataChannel('file-transfer', { ordered: true });
    setupDataChannel(fileDataChannel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const encrypted = await encryptStaticSignalingPayload(offer);
    wsSend({ type: 'webrtc_sdp', recipientId: peerId, ...encrypted });
  } catch (err) {
    console.error('Failed to create offer:', err);
    sendClientDebugLog('startOfferNegotiation failed error caught', err, { peerId });
  }
}

/**
 * Start an outgoing call. `encryptCallKeyFn` performs the ratchet-based E2EE
 * key exchange (owned by the messaging layer, not this module) and must
 * resolve to a signaling payload suitable for the `call_invite` message.
 */
export async function startCall(peer, type, encryptCallKeyFn) {
  const rawKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const staticCallKeyBase64 = toBase64(rawKeyBytes);
  currentCallKey = await importStaticKey(rawKeyBytes);

  const callId = crypto.randomUUID();

  activeCall.set({
    id: callId,
    status: 'ringing',
    peerId: peer.id,
    peerUsername: peer.username,
    type,
    direction: 'outgoing',
    currentCallKey
  });

  const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const videoConstraints = type === 'video' ? {
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 30, max: 60 },
    facingMode: 'user'
  } : false;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraints });
    localStreamPromise = Promise.resolve(localStream);
    localStreamStore.set(localStream);
  } catch (err) {
    console.error('Failed to get media devices:', err);
    alert('Could not access microphone/camera');
    activeCall.set(null);
    currentCallKey = null;
    return;
  }

  try {
    const encryptedKey = await encryptCallKeyFn(peer.id, { key: staticCallKeyBase64 });

    recentCalls.update(calls => [
      { id: callId, peerId: peer.id, peerUsername: peer.username, type, direction: 'outgoing', status: 'ringing', timestamp: new Date().toISOString() },
      ...calls
    ]);

    wsSend({
      type: 'call_invite',
      recipientId: peer.id,
      callType: type,
      senderUsername: get(currentUser)?.username,
      encryptedKey
    });
  } catch (err) {
    console.error('Failed to complete call initialization:', err);
    alert('Failed to establish encrypted call session.');
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
      localStreamStore.set(null);
    }
    activeCall.set(null);
    currentCallKey = null;
  }
}

/** Called once the callee's key has been decrypted (ratchet layer, owned by the caller). */
export function setCurrentCallKey(key) {
  currentCallKey = key;
  calculateVerificationWords();
}

export async function acquireMediaForIncomingCall(callType) {
  const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const videoConstraints = callType === 'video' ? {
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 30, max: 60 },
    facingMode: 'user'
  } : false;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraints });
    localStreamStore.set(localStream);
    if (peerConnection) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }
    return localStream;
  } catch (err) {
    console.error('Failed to get media devices for incoming call:', err);
    alert('Could not access microphone/camera');
    hangupCall();
    throw err;
  }
}

export async function ensureLocalStream() {
  if (localStreamPromise) await localStreamPromise;
}

async function processQueuedIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  const candidates = [...iceCandidatesQueue];
  iceCandidatesQueue = [];
  for (const candidate of candidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Failed to add queued ICE candidate:', err);
    }
  }
}

export function hangupCall() {
  const call = get(activeCall);
  if (call) {
    wsSend({ type: 'call_hangup', recipientId: call.peerId });
  }
  activeCall.set(null);
  resetCallState();
}

export function sendMediaState() {
  const call = get(activeCall);
  if (call) {
    wsSend({
      type: 'webrtc_media_state',
      recipientId: call.peerId,
      micMuted: get(micMuted),
      cameraOff: get(cameraOff)
    });
  }
}

export function toggleMic() {
  const muted = !get(micMuted);
  micMuted.set(muted);
  if (localStream) {
    localStream.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }
  sendMediaState();
}

export function toggleCamera() {
  const off = !get(cameraOff);
  cameraOff.set(off);
  if (localStream && !get(isScreenSharing)) {
    localStream.getVideoTracks().forEach(track => { track.enabled = !off; });
  }
  sendMediaState();
}

export async function toggleScreenShare() {
  if (get(isScreenSharing)) {
    await stopScreenShare();
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
    isScreenSharing.set(true);

    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) {
      screenTrack.onended = () => stopScreenShare();
    }

    if (peerConnection) {
      const senders = peerConnection.getSenders();
      const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
      if (videoSender) await videoSender.replaceTrack(screenTrack);
    }

    localStreamStore.set(screenStream);
  } catch (err) {
    console.error('Failed to start screen share:', err);
  }
}

export async function stopScreenShare() {
  if (!get(isScreenSharing)) return;
  isScreenSharing.set(false);
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !get(cameraOff);
      if (peerConnection) {
        const senders = peerConnection.getSenders();
        const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
        if (videoSender) await videoSender.replaceTrack(videoTrack);
      }
    }
    localStreamStore.set(localStream);
  }
}

export function resetCallState() {
  if (fileDataChannel) {
    try { fileDataChannel.close(); } catch (e) {}
    fileDataChannel = null;
  }
  dataChannelReady.set(false);
  resetP2pState();

  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  isScreenSharing.set(false);
  remoteMicMuted.set(false);
  remoteCameraOff.set(false);
  sentInitialMediaState = false;

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  localStreamStore.set(null);

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteStreamStore.set(null);

  micMuted.set(false);
  cameraOff.set(false);
  currentCallKey = null;
  verificationWords.set('');
  peerConnectionPromise = null;
  localStreamPromise = null;
  iceCandidatesQueue = [];
  offerNegotiationStarted = false;
}

export function markInitialMediaStateSent() {
  sentInitialMediaState = true;
}
export function hasSentInitialMediaState() {
  return sentInitialMediaState;
}

export function beginOutgoingNegotiation(peerId) {
  return startOfferNegotiation(peerId);
}

export function connectIncomingPeer(peerId) {
  return initializePeerConnection(peerId);
}

// ─── Persistent WebSocket signaling listeners ──────────────────
// Registered once at module load — survives regardless of which
// conversation (if any) is currently open.
let listenersRegistered = false;
export function registerCallSignaling() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  onWsEvent('webrtc_sdp', async (data) => {
    try {
      const decryptedSdp = await decryptStaticSignalingPayload(data);
      if (!decryptedSdp) return;

      await initializePeerConnection(data.senderId);
      if (!peerConnection) return;

      await peerConnection.setRemoteDescription(new RTCSessionDescription(decryptedSdp));
      await processQueuedIceCandidates();

      if (decryptedSdp.type === 'offer') {
        await ensureLocalStream();
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        const encrypted = await encryptStaticSignalingPayload(answer);
        wsSend({ type: 'webrtc_sdp', recipientId: data.senderId, ...encrypted });
      }
    } catch (err) {
      console.error('Failed to process incoming SDP:', err);
    }
  });

  onWsEvent('webrtc_ice', async (data) => {
    try {
      const decryptedCandidate = await decryptStaticSignalingPayload(data);
      if (!decryptedCandidate) return;

      await initializePeerConnection(data.senderId);
      if (!peerConnection) return;

      if (peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(decryptedCandidate));
      } else {
        iceCandidatesQueue.push(decryptedCandidate);
      }
    } catch (err) {
      console.error('Failed to process incoming ICE candidate:', err);
    }
  });

  onWsEvent('webrtc_media_state', (data) => {
    const call = get(activeCall);
    if (call && data.senderId === call.peerId) {
      remoteMicMuted.set(data.micMuted);
      remoteCameraOff.set(data.cameraOff);
    }
  });
}

// ─── Call orchestration ─────────────────────────────────────────
// Drives the connection lifecycle purely off the activeCall store, so it
// works identically whether or not any chat/component happens to be
// mounted (e.g. a call accepted while no conversation is open).
let hadCall = false;
let incomingKeyApplied = false;
activeCall.subscribe((call) => {
  if (!call) {
    incomingKeyApplied = false;
    if (hadCall) {
      hadCall = false;
      resetCallState();
    }
    return;
  }
  hadCall = true;

  if (call.status === 'ongoing' && call.currentCallKey && call.direction === 'incoming' && !incomingKeyApplied) {
    incomingKeyApplied = true;
    setCurrentCallKey(call.currentCallKey);
    initializePeerConnection(call.peerId);
  }

  if (call.peerAccepted && call.direction === 'outgoing') {
    startOfferNegotiation(call.peerId);
  }

  if (call.status === 'ongoing' && call.direction === 'incoming' && !localStream && !localStreamPromise) {
    localStreamPromise = acquireMediaForIncomingCall(call.type);
  }
});

// Self-register signaling listeners on first import — mirrors the pattern
// used by lib/api/ws.js. No component needs to remember to call this.
registerCallSignaling();
