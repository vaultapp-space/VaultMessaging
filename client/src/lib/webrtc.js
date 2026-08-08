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
import { showToast } from './stores/toast.js';
import { hapticMedium } from './haptics.js';

// NotAllowedError means the permission prompt won't fire again — a generic
// "could not access" toast is a dead end every time after that.
function showMediaAccessError(err) {
  showToast(
    err?.name === 'NotAllowedError'
      ? 'Microphone/camera access is blocked. Enable it in your phone\'s Settings → Apps → Vault → Permissions.'
      : 'Could not access microphone/camera',
    { duration: err?.name === 'NotAllowedError' ? 7000 : 4000 }
  );
}

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
// Set with a human-readable reason whenever a call cannot be established at
// all (no TURN relay available, or ICE never connects) so the UI can tell
// the user instead of silently showing "on call" over a dead connection.
export const callFailureStore = writable(null);
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
// Bumped by resetCallState() on every hangup/reset. initializePeerConnection
// captures this before its TURN-credential fetch (an async gap the user can
// hang up during) and checks it again after — a mismatch means this call
// attempt was cancelled while waiting, so it bails out instead of creating
// an RTCPeerConnection nothing will ever close.
let callGeneration = 0;

// How long an outgoing call rings before giving up on it. There was
// previously no limit at all: calling someone offline (the server has
// nowhere to deliver call_invite to — unlike messages, signaling isn't
// queued for later) meant no call_accept/call_reject could ever arrive, and
// the caller's UI — both the active-call screen and the Calls tab entry —
// stayed on "ringing" forever. 45s matches ordinary phone/VoIP ring timeout
// conventions.
const RING_TIMEOUT_MS = 45000;
let ringTimeoutId = null;
let localStream = null;
let localStreamPromise = null;
let screenStream = null;
let iceCandidatesQueue = [];
let fileDataChannel = null;
let currentCallKey = null;

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
    showToast('P2P connection is not ready for file transfer.');
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

// Every call is forced through TURN (iceTransportPolicy: 'relay') so a peer
// never learns the other's real IP. That means a STUN-only server list is
// useless here — it cannot yield a single relay candidate, so ICE gathering
// completes empty and the connection fails without ever calling anyone's
// attention to it. Fail fast instead so callers can end the call cleanly.
function hasTurnServer(iceServers) {
  return iceServers.some(s => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some(u => typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:')));
  });
}

function initializePeerConnection(peerId) {
  if (peerConnectionPromise) return peerConnectionPromise;

  const myGeneration = callGeneration;

  peerConnectionPromise = (async () => {
    let iceServers;

    try {
      const data = await fetchTurnCredentials();
      if (myGeneration !== callGeneration) return; // cancelled while fetching TURN creds
      if (!data || !data.iceServers || !hasTurnServer(data.iceServers)) {
        throw new Error('TURN credentials response contained no relay servers');
      }
      iceServers = data.iceServers;
    } catch (e) {
      if (myGeneration !== callGeneration) return; // already hung up — nothing to report
      console.error('Failed to fetch TURN relay credentials — cannot start a privacy-preserving call:', e);
      sendClientDebugLog('fetchTurnCredentials failed', e);
      peerConnectionPromise = null;
      const message = 'Could not reach the relay server needed for a private call. Please try again shortly.';
      callFailureStore.set(message);
      showToast(message);
      if (get(activeCall)) hangupCall();
      throw e;
    }

    try {
      // Always relay through TURN — never let a direct/host or srflx candidate
      // pair win, since that would expose each party's real IP to the other.
      peerConnection = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'relay'
      });
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

    let iceRestartAttempts = 0;
    let connectedHapticFired = false;
    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection?.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        iceRestartAttempts = 0;
        if (!connectedHapticFired) {
          connectedHapticFired = true;
          hapticMedium();
        }
      } else if (state === 'failed') {
        iceRestartAttempts += 1;
        if (iceRestartAttempts > 3) {
          // Restarting ICE hasn't recovered the connection after several
          // tries — stop looping silently and let the user know the call
          // could not be established, instead of leaving the UI stuck on
          // "on call" over a connection that will never carry media.
          const message = 'Call connection failed. Please check your network and try again.';
          callFailureStore.set(message);
          showToast(message);
          hangupCall();
          return;
        }
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
    showMediaAccessError(err);
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

    if (ringTimeoutId) clearTimeout(ringTimeoutId);
    ringTimeoutId = setTimeout(() => {
      ringTimeoutId = null;
      // Guards against a call that already resolved (accepted/rejected/
      // hung up) by the time this fires, and against it firing for a
      // *different*, later call — status/id are re-checked live rather than
      // clearing this timer from every place a call can end.
      const call = get(activeCall);
      if (!call || call.id !== callId || call.status !== 'ringing') return;

      wsSend({ type: 'call_hangup', recipientId: peer.id });
      recentCalls.update(calls => {
        const found = calls.find(c => c.id === callId);
        if (found) found.status = 'missed';
        return [...calls];
      });
      activeCall.set(null);
      showToast(`${peer.username} didn't answer.`, { type: 'info' });
    }, RING_TIMEOUT_MS);
  } catch (err) {
    console.error('Failed to complete call initialization:', err);
    showToast('Failed to establish encrypted call session.');
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
    showMediaAccessError(err);
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
  hapticMedium();
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
  callGeneration++;
  if (ringTimeoutId) {
    clearTimeout(ringTimeoutId);
    ringTimeoutId = null;
  }
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
  if (!hadCall) {
    callFailureStore.set(null);
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
