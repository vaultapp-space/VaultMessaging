<script>
  import { activeView } from '../lib/stores/session.js';
  import { onMount } from 'svelte';

  // Force dark mode on landing page and initialize countdown timer
  let ttlTimer = '23:59:59';
  let ttlHours = 23;
  let ttlMinutes = 59;
  let ttlSeconds = 59;
  let timerInterval;
  let isDestructing = false;

  // Live Network Stats State
  let liveConnections = 1;
  let liveLatency = 24;
  let liveRelays = 4;
  let statsInterval = null;
  let jitterInterval = null;

  async function fetchNetworkStats() {
    try {
      const res = await fetch('/api/network/stats');
      if (res.ok) {
        const data = await res.json();
        liveConnections = data.activeConnections || 1;
        liveLatency = data.latency || 24;
        liveRelays = data.relays || 4;
      }
    } catch (err) {
      console.error('Failed to fetch live network stats', err);
    }
  }

  onMount(() => {
    // Respect the visitor's previously-chosen theme (same logic as App.svelte's
    // initial-theme handling) instead of always forcing dark mode.
    const storedTheme = localStorage.getItem('vault_theme') || 'dark';
    if (storedTheme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }

    // Retrieve initial stats and start polling every 10 seconds
    fetchNetworkStats();
    statsInterval = setInterval(fetchNetworkStats, 10000);

    // Network stats micro-jitter
    jitterInterval = setInterval(() => {
      const latJitter = Math.floor(Math.random() * 5) - 2; // -2 to +2
      const connJitter = Math.floor(Math.random() * 3) - 1; // -1 to +1
      liveLatency = Math.max(15, Math.min(50, liveLatency + latJitter));
      liveConnections = Math.max(1, liveConnections + connJitter);
    }, 2000);

    // Ticking 24h decay timer
    timerInterval = setInterval(() => {
      ttlSeconds--;
      if (ttlSeconds < 0) {
        ttlSeconds = 59;
        ttlMinutes--;
        if (ttlMinutes < 0) {
          ttlMinutes = 59;
          ttlHours--;
          if (ttlHours < 0) {
            ttlHours = 23;
          }
        }
      }
      const pad = (num) => String(num).padStart(2, '0');
      ttlTimer = `${pad(ttlHours)}:${pad(ttlMinutes)}:${pad(ttlSeconds)}`;
    }, 1000);

    return () => {
      clearInterval(timerInterval);
      if (statsInterval) clearInterval(statsInterval);
      if (jitterInterval) clearInterval(jitterInterval);
      clearIntervals();
    };
  });

  // Unified Simulator Tab Switcher
  let simTab = 'chat'; // 'chat' | 'call'
  let chatInspectorView = 'ratchet'; // 'ratchet' | 'x3dh'

  // E2EE Call Simulator state
  let callState = 'ringing'; // 'idle' | 'ringing' | 'connected'
  let callSecondsCount = 0;
  let callTimer = '00:00';
  let callInterval = null;
  let callLogs = [
    '[WebRTC] Listening for signaling packets via WebSocket...',
    '[WebRTC] Received secure SDP offer from Bob.'
  ];
  let callFrequencies = Array.from({ length: 15 }, () => 4);
  let callFrequenciesInterval = null;
  let callStepInterval = null;

  // Live, steppable WebRTC connection-establishment state (mirrors the
  // Double Ratchet stepper on the chat tab so the call demo feels equally
  // "live" instead of dumping all logs at once).
  let activeCallStep = 'idle'; // 'idle' | 'signaling' | 'ice' | 'dtls' | 'media'
  let iceMode = 'direct'; // 'direct' | 'relay' — user-toggleable before/after connecting
  let localCandidate = 'host udp 10.0.0.4:52341';
  let remoteCandidate = 'srflx udp 203.0.113.9:60122';
  let srtpCipher = 'SRTP_AES128_CM_HMAC_SHA1_80';
  let connQuality = 92;
  let connQualityInterval = null;

  function randomPort() {
    return 40000 + Math.floor(Math.random() * 20000);
  }

  function regenerateCandidates() {
    if (iceMode === 'relay') {
      localCandidate = `relay udp 13.204.30.174:${randomPort()}`;
      remoteCandidate = `relay udp 13.204.30.174:${randomPort()}`;
    } else {
      localCandidate = `host udp 10.0.0.4:${randomPort()}`;
      remoteCandidate = `srflx udp 203.0.113.9:${randomPort()}`;
    }
  }

  function toggleIceMode() {
    iceMode = iceMode === 'direct' ? 'relay' : 'direct';
    regenerateCandidates();
    if (callState !== 'idle') {
      callLogs = [
        ...callLogs,
        iceMode === 'relay'
          ? '[ICE] Direct path failed NAT traversal check. Falling back to TURN relay.'
          : '[ICE] Direct host/srflx candidate pair available. Bypassing TURN relay.'
      ];
    }
  }

  function acceptSimCall() {
    callState = 'connected';
    regenerateCandidates();
    activeCallStep = 'signaling';
    callLogs = [
      ...callLogs,
      '[X3DH] Active prekeys matched. Negotiating session keys...',
      '[Double Ratchet] Derived symmetric master call key.'
    ];

    callStepInterval = setTimeout(() => {
      activeCallStep = 'ice';
      callLogs = [
        ...callLogs,
        `[ICE] Gathering candidates... selected pair: ${localCandidate} ⇄ ${remoteCandidate}`
      ];

      callStepInterval = setTimeout(() => {
        activeCallStep = 'dtls';
        callLogs = [
          ...callLogs,
          '[DTLS-SRTP] Initializing encrypted media channel...',
          `[DTLS-SRTP] Handshake complete. Key negotiated: ${srtpCipher}`
        ];

        callStepInterval = setTimeout(() => {
          activeCallStep = 'media';
          callLogs = [
            ...callLogs,
            `[WebRTC] Audio stream encrypted. ${iceMode === 'relay' ? 'Relayed via TURN' : 'Direct P2P'} connection established.`
          ];

          callInterval = setInterval(() => {
            callSecondsCount++;
            const min = String(Math.floor(callSecondsCount / 60)).padStart(2, '0');
            const sec = String(callSecondsCount % 60).padStart(2, '0');
            callTimer = `${min}:${sec}`;
          }, 1000);

          callFrequenciesInterval = setInterval(() => {
            callFrequencies = callFrequencies.map(() => Math.floor(Math.random() * 26) + 4);
          }, 100);

          connQualityInterval = setInterval(() => {
            const jitter = Math.floor(Math.random() * 7) - 3;
            connQuality = Math.max(70, Math.min(99, connQuality + jitter));
          }, 1500);
        }, 700);
      }, 700);
    }, 600);
  }

  function rejectSimCall() {
    callState = 'idle';
    activeCallStep = 'idle';
    callLogs = [...callLogs, '[WebRTC] Call rejected by user. Session closed.'];
    clearIntervals();
  }

  function startSimCall() {
    callState = 'ringing';
    activeCallStep = 'idle';
    callSecondsCount = 0;
    callTimer = '00:00';
    connQuality = 92;
    callLogs = [
      '[WebRTC] Listening for signaling packets via WebSocket...',
      '[WebRTC] Received secure SDP offer from Bob.'
    ];
    clearIntervals();
  }

  function endSimCall() {
    callState = 'idle';
    activeCallStep = 'idle';
    callLogs = [...callLogs, '[WebRTC] Connection ended by user. DTLS-SRTP tunnel closed.'];
    clearIntervals();
  }

  function clearIntervals() {
    if (callInterval) { clearInterval(callInterval); callInterval = null; }
    if (callFrequenciesInterval) { clearInterval(callFrequenciesInterval); callFrequenciesInterval = null; }
    if (callStepInterval) { clearTimeout(callStepInterval); callStepInterval = null; }
    if (connQualityInterval) { clearInterval(connQualityInterval); connQualityInterval = null; }
  }

  // Double Ratchet Simulator state
  let simMessages = [
    { sender: 'Bob', text: 'Hey Alice! Is this connection secure?', status: 'decrypted', time: '10:42 AM' },
    { sender: 'Alice', text: 'Yes, establishing the X3DH handshake now...', status: 'decrypted', time: '10:42 AM' }
  ];
  let simInput = '';
  let activeRatchetStep = 'idle'; // 'idle' | 'dh' | 'kdf' | 'encrypt' | 'decrypt'
  let ratchetLogs = [
    '[Init] Extended Triple Diffie-Hellman (X3DH) complete. Shared secret established.',
    '[Init] Root key and initial Chain Keys derived. Ready for messaging.'
  ];
  let aliceChainKey = '0x8f2d7e9a2b5c4f...';
  let bobChainKey = '0x8f2d7e9a2b5c4f...';
  let derivedMessageKey = 'None';
  let dhStepCount = 1;

  function runRatchetStep(text) {
    if (!text || activeRatchetStep !== 'idle' || isDestructing) return;
    const msgText = text.trim();
    simInput = '';

    // Append Alice's message
    const newMsg = { sender: 'Alice', text: msgText, status: 'encrypting', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    simMessages = [...simMessages, newMsg];

    // Step 1: DH Ephemeral Step
    activeRatchetStep = 'dh';
    ratchetLogs = [
      ...ratchetLogs,
      `[Step ${dhStepCount}] Alice generates ephemeral key pair (A_ratchet_${dhStepCount}). Performs DH key exchange.`
    ];

    setTimeout(() => {
      // Step 2: KDF Derive Keys
      activeRatchetStep = 'kdf';
      const randomHex = (len) => Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      aliceChainKey = '0x' + randomHex(16) + '...';
      derivedMessageKey = '0x' + randomHex(32);
      
      ratchetLogs = [
        ...ratchetLogs,
        `[Step ${dhStepCount}] KDF Step: Ratchet Chain Key derived: ${aliceChainKey.substring(0, 10)}...`,
        `[Step ${dhStepCount}] Message Key derived: ${derivedMessageKey.substring(0, 10)}...`
      ];

      setTimeout(() => {
        // Step 3: Encrypt under derived message key
        activeRatchetStep = 'encrypt';
        newMsg.status = 'sending';
        simMessages = [...simMessages];
        ratchetLogs = [
          ...ratchetLogs,
          `[Step ${dhStepCount}] Payload encrypted using AES-256-GCM under Message Key.`
        ];

        setTimeout(() => {
          // Step 4: Bob receives, KDF & decrypts
          activeRatchetStep = 'decrypt';
          bobChainKey = aliceChainKey;
          newMsg.status = 'decrypted';
          simMessages = [...simMessages];
          ratchetLogs = [
            ...ratchetLogs,
            `[Step ${dhStepCount}] Bob receives payload. Advances his receiving chain, derives Message Key, decrypts successfully.`
          ];

          setTimeout(() => {
            activeRatchetStep = 'idle';
            dhStepCount++;
            
            // Auto scroll simulator terminal & chatbox
            setTimeout(() => {
              const term = document.getElementById('sim-terminal');
              if (term) term.scrollTop = term.scrollHeight;
              const chatBox = document.getElementById('sim-chatbox');
              if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
            }, 50);

            // Auto reply from Bob
            setTimeout(() => {
              runBobReply();
            }, 1800);

          }, 800);
        }, 800);
      }, 800);
    }, 800);
  }

  function runBobReply() {
    if (activeRatchetStep !== 'idle' || simTab !== 'chat' || simMessages.length === 0 || isDestructing) return;
    
    activeRatchetStep = 'dh';
    ratchetLogs = [
      ...ratchetLogs,
      `[Step ${dhStepCount}] Bob initiates auto-reply. Generates ephemeral key (B_ratchet_${dhStepCount}). performs DH.`
    ];

    setTimeout(() => {
      activeRatchetStep = 'kdf';
      const randomHex = (len) => Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      bobChainKey = '0x' + randomHex(16) + '...';
      derivedMessageKey = '0x' + randomHex(32);
      
      ratchetLogs = [
        ...ratchetLogs,
        `[Step ${dhStepCount}] KDF Step: Bob derives new Chain Key: ${bobChainKey.substring(0, 10)}...`,
        `[Step ${dhStepCount}] Bob derives Message Key: ${derivedMessageKey.substring(0, 10)}...`
      ];

      setTimeout(() => {
        activeRatchetStep = 'encrypt';
        const bobMsg = { sender: 'Bob', text: 'Secure packet verified. Ratchet epoch incremented.', status: 'encrypting', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
        simMessages = [...simMessages, bobMsg];
        ratchetLogs = [
          ...ratchetLogs,
          `[Step ${dhStepCount}] Bob encrypts response under derived Message Key.`
        ];

        setTimeout(() => {
          bobMsg.status = 'sending';
          simMessages = [...simMessages];
          
          setTimeout(() => {
            activeRatchetStep = 'decrypt';
            aliceChainKey = bobChainKey;
            bobMsg.status = 'decrypted';
            simMessages = [...simMessages];
            ratchetLogs = [
              ...ratchetLogs,
              `[Step ${dhStepCount}] Alice receives response, performs matching DH, derives Message Key, decrypts Bob's message.`
            ];

            setTimeout(() => {
              activeRatchetStep = 'idle';
              dhStepCount++;
              
              setTimeout(() => {
                const term = document.getElementById('sim-terminal');
                if (term) term.scrollTop = term.scrollHeight;
                const chatBox = document.getElementById('sim-chatbox');
                if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
              }, 50);
            }, 800);
          }, 800);
        }, 800);
      }, 800);
    }, 800);
  }

  function triggerAutoDestruct() {
    if (isDestructing || simMessages.length === 0) return;
    isDestructing = true;
    ratchetLogs = [...ratchetLogs, `[Destruct] Wiping in-memory log frames...`];

    setTimeout(() => {
      simMessages = [];
      isDestructing = false;
      ratchetLogs = [...ratchetLogs, `[Destruct] Wiped successfully. Zero persistent traces remaining.`];
    }, 800);
  }

  // FAQ Accordion State
  // Honest comparison — only claims Vault can actually back up today, not marketing fluff.
  const comparisonRows = [
    { label: 'Forward-secret ratchet (new key per message)', vault: true, signal: true, telegram: 'secret-chats-only', whatsapp: true },
    { label: 'E2EE by default (no opt-in required)', vault: true, signal: true, telegram: false, whatsapp: true },
    { label: 'Server source code publicly viewable', vault: true, signal: true, telegram: false, whatsapp: false },
    { label: 'Self-hostable / federated servers', vault: false, signal: false, telegram: false, whatsapp: false },
    { label: 'Server-enforced message TTL', vault: true, signal: 'user-set', telegram: 'user-set', whatsapp: false }
  ];

  let activeFaqIndex = null;
  const faqs = [
    {
      q: 'Are my identity keys ever sent to the server?',
      a: 'No. Your identity and prekey material are generated entirely client-side and never leave the browser except as a passphrase-encrypted backup. That backup is stored using AES-GCM-256 with a key derived from your master password or a secure WebAuthn PRF credential (biometrics). The server only ever sees the encrypted blob — it is completely zero-knowledge regarding your keys.'
    },
    {
      q: 'What is the Double Ratchet protocol, and why does it matter?',
      a: 'Double Ratchet is a protocol used to negotiate keys for every single message. It combines a DH ratchet (generating fresh secrets dynamically) and a KDF symmetric ratchet (generating single-use message keys). This ensures perfect forward secrecy: if an attacker compromises a single message key, they cannot read past messages or future messages.'
    },
    {
      q: 'What happens to my keys when I close the browser tab?',
      a: 'Your active decrypted keys live exclusively in volatile JS memory. Closing the tab immediately destroys these keys. When you return, you must re-authenticate (via master password or WebAuthn biometrics) to decrypt your local IndexDB database and resume messaging.'
    },
    {
      q: 'Is Vault open source?',
      a: 'The client and server source is publicly viewable on GitHub. A formal open-source license has not been applied yet, so treat it as source-available rather than fully open-source until that\'s finalized — we\'ll update this the moment it changes.'
    },
    {
      q: 'Who runs the servers, and can I self-host?',
      a: 'Today, a single set of servers operated by the Vault team relays signaling and encrypted payloads — it is not yet a federated or self-hostable network. The server design is zero-knowledge by architecture (it only ever sees ciphertext and routing metadata), but it is currently centralized.'
    },
    {
      q: 'What happens if the server goes down?',
      a: 'Real-time delivery and call signaling pause until the server is back — there is no peer-to-peer fallback for initial connection setup today. Your identity keys, message history, and local backups are unaffected, since none of that lives on the server; messages also carry a 24-hour TTL and are hard-deleted by a periodic reaper regardless of server uptime.'
    }
  ];

  function toggleFaq(index) {
    if (activeFaqIndex === index) {
      activeFaqIndex = null;
    } else {
      activeFaqIndex = index;
    }
  }

  let activeFeatureIndex = null;
  function toggleFeature(index) {
    if (activeFeatureIndex === index) {
      activeFeatureIndex = null;
    } else {
      activeFeatureIndex = index;
    }
  }

  // Security & privacy features list
  const features = [
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21.75c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94-3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>`,
      title: 'E2EE Group Messaging',
      desc: 'Leverages the Signal Sender Keys Protocol to scale secure, encrypted group chat. Optimizes communication complexity from O(N) to O(1) client overhead.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
      </svg>`,
      title: 'P2P Encrypted File Share',
      desc: 'Send media and raw files directly to peers using WebRTC Data Channels. High-performance streaming with custom chunking, backpressure, and Double Ratchet security.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
      </svg>`,
      title: 'Double Ratchet Protocol',
      desc: 'Cryptographic self-healing. Every chat message has a unique key. If compromised, past and future logs remain safe.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>`,
      title: 'X3DH Offline Handshake',
      desc: 'Establishes secure forward-secret sessions using Extended Triple Diffie-Hellman, even when the recipient is offline.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.5v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.5v-4.5zM13.5 19.125c0-.621.504-1.125 1.125-1.125h1.5a1.125 1.125 0 011.125 1.125v.75c0 .621-.504 1.125-1.125 1.125h-1.5a1.125 1.125 0 01-1.125-1.125v-.75zM19.125 13.5c.621 0 1.125.504 1.125 1.125v1.5a1.125 1.125 0 01-1.125 1.125h-.75a1.125 1.125 0 01-1.125-1.125v-1.5c0-.621.504-1.125 1.125-1.125h.75zM17.25 18h1.5a.75.75 0 01.75.75v.75a.75.75 0 01-.75.75h-1.5a.75.75 0 01-.75-.75v-.75a.75.75 0 01.75-.75zM15 15h.75a.75.75 0 01.75.75V18a.75.75 0 01-.75.75H15a.75.75 0 01-.75-.75v-2.25A.75.75 0 0115 15z" />
      </svg>`,
      title: 'Secure QR Session Sync',
      desc: 'Seamlessly migrate or synchronize active sessions, identity keys, prekeys, and local backup configs between devices using secure, client-encrypted QR code payloads.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
      </svg>`,
      title: 'E2EE Voice & Video Calls',
      desc: 'Symmetric WebRTC streams encrypted using dynamic keys negotiated via Double Ratchet. Free from server listening.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7.864 4.243A4 4 0 0111 3h2a4 4 0 013.136 1.243l2.764 2.764A4 4 0 0120 10v2a4 4 0 01-1.243 2.864l-2.764 2.764A4 4 0 0113 19h-2a4 4 0 01-3.136-1.243L5.092 15A4 4 0 014 12v-2a4 4 0 011.243-2.864l2.764-2.764z" />
      </svg>`,
      title: 'Biometric Vault Unlock',
      desc: 'Decrypt local backup logs instantly using FaceID/TouchID via secure WebAuthn PRF keys without passwords.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a9 9 0 1118 0 9 9 0 01-18 0z" />
      </svg>`,
      title: 'Volatile In-Memory Safety',
      desc: 'Active keys live exclusively in volatile JS memory. Closing your browser tab instantly destroys all decryption keys.'
    }
  ];
</script>

<div class="h-screen overflow-y-auto flex flex-col justify-between relative bg-vault-black text-vault-text font-sans selection:bg-vault-accent/20 selection:text-vault-accent">

  <!-- Live Network Pulse Banner -->
  <div class="w-full bg-vault-surface/40 border-b border-vault-border/20 py-2 px-4 z-20 flex justify-center items-center overflow-hidden">
    <div class="flex items-center gap-6 font-mono text-[9px] text-vault-text-dim tracking-wider uppercase whitespace-nowrap animate-fade-in select-none">
      <div class="flex items-center gap-1.5">
        <span class="relative flex h-1.5 w-1.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-vault-accent opacity-75"></span>
          <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-vault-accent"></span>
        </span>
        <span class="text-vault-text font-bold">Network:</span>
        <span class="text-vault-accent">Operational</span>
      </div>
      <div class="hidden sm:block">Seed Relays: <span class="text-vault-text font-bold">{liveRelays}</span></div>
      <div>Active Sockets: <span class="text-vault-text font-bold">{liveConnections}</span></div>
      <div class="hidden sm:block">P2P Latency: <span class="text-vault-text font-bold">{liveLatency}ms</span></div>
    </div>
  </div>
  
  <!-- Minimalist background overlay -->
  <div class="pointer-events-none fixed inset-0 z-0">
    <div class="absolute top-[-30%] left-[-10%] w-[600px] h-[600px] rounded-full bg-vault-accent/[0.015] blur-[150px]"></div>
    <div class="absolute bottom-[-30%] right-[-10%] w-[500px] h-[500px] rounded-full bg-vault-accent/[0.008] blur-[130px]"></div>
    <!-- Clean, micro-grid pattern -->
    <div class="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.003)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.003)_1px,transparent_1px)] bg-[size:48px_48px]"></div>
  </div>

  <!-- Nav Bar (Always Dark) -->
  <header class="w-full max-w-5xl mx-auto px-6 py-6 flex justify-between items-center z-10">
    <div class="flex items-center gap-2 select-none">
      <svg class="w-7 h-7 text-vault-text hover:text-vault-accent transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
        <path d="M12 22V12" stroke-dasharray="3 3" />
      </svg>
      <span class="text-base font-bold tracking-wider uppercase font-sans">Vault</span>
      <span
        class="text-[8px] bg-vault-border/50 text-vault-text-secondary border border-vault-border px-1.5 py-0.5 rounded font-mono cursor-default"
        title="Vault is under active development — features and protocols may change without notice."
      >BETA</span>
    </div>

    <div class="flex items-center gap-2">
      <button
        on:click={() => activeView.set('vaultcoin')}
        class="py-2 px-4 text-xs text-vault-text-dim hover:text-vault-text font-bold rounded-xl focus:outline-none transition-all cursor-pointer border border-vault-border/30 hover:border-vault-border/60"
      >
        Vault Coin
      </button>
      <button
        on:click={() => activeView.set('auth')}
        class="py-2 px-5 text-xs bg-vault-text text-vault-black hover:bg-vault-text-secondary font-bold rounded-xl focus:outline-none transition-all cursor-pointer shadow-md btn-glow"
      >
        Launch Web App
      </button>
    </div>
  </header>

  <!-- Hero Section -->
  <section class="max-w-3xl mx-auto px-6 pt-16 pb-12 text-center flex flex-col items-center gap-5.5 z-10">
    
    <!-- Minimalist Protocol Ticker Badges -->
    <div class="flex flex-wrap justify-center gap-1.5 mb-1.5 select-none animate-fade-in text-[9px] font-mono font-bold tracking-wider uppercase">
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">E2EE: Double Ratchet</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">Handshake: X3DH</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">WebRTC: DTLS-SRTP</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">Keys: WebAuthn PRF</span>
    </div>

    <h1 class="text-4xl sm:text-5xl font-black tracking-tight leading-[1.08] max-w-2xl bg-gradient-to-b from-vault-text to-vault-text-secondary bg-clip-text text-transparent">
      Confidential Chat.<br/>Zero Compromise.
    </h1>

    <p class="text-xs sm:text-sm text-vault-text-secondary max-w-md leading-relaxed opacity-80">
      A zero-knowledge communications hub pairing end-to-end double-ratcheted messaging with private, peer-to-peer encrypted voice and video.
    </p>
    
    <div class="mt-2 flex flex-col items-center gap-4">
      <div class="flex flex-col sm:flex-row gap-3">
        <button 
          on:click={() => activeView.set('auth')} 
          class="py-3 px-6 text-xs bg-vault-text text-vault-black hover:bg-vault-text-secondary font-bold rounded-xl focus:outline-none transition-all cursor-pointer shadow-md btn-glow"
        >
          Start secure session
        </button>
      </div>

      <!-- Prominent Hero Social Links -->
      <div class="flex items-center gap-1.5 text-[10px] font-bold text-vault-text-secondary font-mono select-none animate-fade-in">
        JOIN THE COMMUNITY
      </div>
      <div class="flex flex-wrap justify-center items-center gap-3 mt-1.5 select-none animate-fade-in text-[10px] font-mono font-bold uppercase">
        <a 
          href="https://discord.gg/VZyvTsJcFQ" 
          target="_blank" 
          rel="noopener noreferrer" 
          class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary hover:text-vault-accent hover:border-vault-accent/30 transition-all no-underline"
        >
          👾 Discord
        </a>
        <a 
          href="https://t.me/Vault_Space" 
          target="_blank" 
          rel="noopener noreferrer" 
          class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary hover:text-vault-accent hover:border-vault-accent/30 transition-all no-underline"
        >
          ✈️ Telegram
        </a>
        <a 
          href="https://x.com/VaultMessenger" 
          target="_blank" 
          rel="noopener noreferrer" 
          class="flex items-center gap-1.5 px-3 py-1.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary hover:text-vault-accent hover:border-vault-accent/30 transition-all no-underline"
        >
          ✖️ Twitter
        </a>
      </div>
    </div>
  </section>

  <!-- Real product screenshot — the simulator below is illustrative, this is the actual app -->
  <section class="w-full max-w-4xl mx-auto px-6 pb-4 z-10 reveal-section">
    <div class="flex flex-col sm:flex-row gap-4 items-start justify-center">
      <div class="relative rounded-2xl overflow-hidden border border-vault-border/20 shadow-2xl glass w-full sm:w-1/2 shrink-0">
        <img
          src="/landing-app-preview.png"
          alt="Vault Messenger desktop app showing an encrypted conversation and an active E2EE call"
          class="w-full h-auto block"
          loading="lazy"
          width="2600"
          height="1553"
        />
        <span class="absolute top-3 left-3 text-[8px] font-mono font-bold uppercase tracking-wider px-2 py-1 rounded bg-vault-black/70 text-vault-accent border border-vault-accent/30 backdrop-blur-sm">
          Desktop
        </span>
      </div>
      <div class="relative rounded-2xl overflow-hidden border border-vault-border/20 shadow-2xl glass w-full sm:w-1/2 mx-auto sm:mx-0 shrink-0">
        <img
          src="/landing-mobile-preview.png"
          alt="Vault Messenger mobile app showing an encrypted conversation"
          class="w-full h-auto block"
          loading="lazy"
          width="900"
          height="1948"
        />
        <span class="absolute top-3 left-3 text-[8px] font-mono font-bold uppercase tracking-wider px-2 py-1 rounded bg-vault-black/70 text-vault-accent border border-vault-accent/30 backdrop-blur-sm">
          Mobile
        </span>
      </div>
    </div>
  </section>

  <!-- Unified tabbed playground simulator widget -->
  <section class="w-full max-w-5xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20 reveal-section">
    <!-- Header of Sandbox -->
    <div class="flex flex-col sm:flex-row items-center justify-between gap-4 mb-6">
      <div class="text-left flex items-center gap-4">
        <div>
          <h2 class="text-lg font-bold tracking-tight text-vault-text">Protocol Sandbox</h2>
          <p class="text-[10px] text-vault-text-dim mt-0.5">Toggle between Alice's messaging tunnel and secure E2EE calls.</p>
        </div>
        <!-- Radar Map Status -->
        <div class="hidden md:flex items-center gap-2 px-2.5 py-1 bg-vault-surface/40 border border-vault-border/20 rounded-xl font-mono text-[8px] text-vault-text-dim select-none animate-fade-in">
          <svg class="w-3.5 h-3.5 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10" stroke-dasharray="2 2" class="opacity-30" />
            <circle cx="12" cy="12" r="6" stroke-dasharray="2 2" class="opacity-50" />
            <line x1="12" y1="2" x2="12" y2="22" class="opacity-20" />
            <line x1="2" y1="12" x2="22" y2="12" class="opacity-20" />
            <!-- Radar Sweep Hand -->
            <line x1="12" y1="12" x2="19" y2="7" class="animate-radar-sweep origin-center" style="transform-origin: 12px 12px;" />
            <!-- Blinking Nodes -->
            <circle cx="7" cy="9" r="1" fill="var(--color-vault-accent)" class="animate-pulse" />
            <circle cx="16" cy="15" r="1" fill="var(--color-vault-accent)" class="animate-pulse" style="animation-delay: 0.5s;" />
          </svg>
          <span>P2P Relays: 4 Active</span>
        </div>
      </div>

      <!-- Tab Switcher group -->
      <div class="flex p-0.5 bg-vault-surface/60 border border-vault-border/30 rounded-xl glass">
        <button 
          on:click={() => simTab = 'chat'}
          class="px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all focus:outline-none cursor-pointer {simTab === 'chat' ? 'bg-vault-elevated text-vault-text border border-vault-border/30 shadow' : 'text-vault-text-dim hover:text-vault-text'}"
        >
          💬 Chat
        </button>
        <button
          on:click={() => { simTab = 'call'; startSimCall(); }}
          class="relative px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all focus:outline-none cursor-pointer {simTab === 'call' ? 'bg-vault-elevated text-vault-text border border-vault-border/30 shadow' : 'text-vault-text-dim hover:text-vault-text call-tab-attract'}"
        >
          📞 E2EE Call
          {#if simTab !== 'call'}
            <span class="absolute -top-1.5 -right-1.5 flex h-2.5 w-2.5">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-vault-accent opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-vault-accent"></span>
            </span>
          {/if}
        </button>
      </div>
    </div>

    <!-- Playground grid layout -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
      
      <!-- Left Column: Active simulator screen (5 cols) -->
      <div class="lg:col-span-5 border border-vault-border/20 rounded-2xl flex flex-col overflow-hidden h-[420px] bg-vault-surface/10 relative transition-all duration-300">
        
        {#if simTab === 'chat'}
          <!-- 💬 CHAT SIMULATOR INTERFACE -->
          <div class="px-4 py-2.5 border-b border-vault-border/20 bg-vault-surface/40 flex items-center justify-between">
            <div class="flex items-center gap-1.5">
              <span class="relative flex h-1.5 w-1.5">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-vault-accent opacity-75"></span>
                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-vault-accent"></span>
              </span>
              <!-- Ticking countdown timer showing 24h decay -->
              <span class="text-[9px] font-bold font-mono tracking-wide uppercase text-vault-text">TTL: {ttlTimer}</span>
            </div>
            
            <div class="flex items-center gap-2">
              <button 
                on:click={triggerAutoDestruct} 
                disabled={simMessages.length === 0 || isDestructing}
                class="text-[8px] font-mono text-vault-danger border border-vault-danger/30 bg-vault-danger/10 px-2 py-0.5 rounded cursor-pointer hover:bg-vault-danger/20 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
              >
                💥 Destruct Logs
              </button>
              <span class="text-[8px] text-vault-text-dim font-mono bg-vault-border/50 px-1.5 py-0.5 rounded uppercase">Ratchet active</span>
            </div>
          </div>

          {#if simMessages.length === 0}
            <div class="flex-1 flex flex-col items-center justify-center text-center p-6 text-vault-text-dim select-none animate-fade-in">
              <span class="text-xl mb-1">🔒</span>
              <span class="text-[10px] font-mono">Secure channel cleared. Type a message to establish session keys.</span>
            </div>
          {:else}
            <div id="sim-chatbox" class="flex-grow overflow-y-auto p-4 flex flex-col gap-3 scroll-smooth">
              {#each simMessages as msg}
                <div class="flex flex-col {msg.sender === 'Alice' ? 'items-end' : 'items-start'} {isDestructing ? 'destruct-puff' : ''}">
                  <div class="flex items-center gap-1.5 mb-0.5">
                    <span class="text-[9px] font-bold text-vault-text-secondary">{msg.sender}</span>
                    <span class="text-[8px] text-vault-text-dim">{msg.time}</span>
                  </div>
                  <div class="max-w-[85%] px-3.5 py-2.5 rounded-2xl text-[11px] leading-relaxed transition-all duration-300 {msg.sender === 'Alice' ? 'bg-vault-text text-vault-black rounded-tr-none' : 'bg-vault-elevated/80 border border-vault-border/25 text-vault-text rounded-tl-none'}">
                    {msg.text}
                    {#if msg.status === 'encrypting'}
                      <div class="text-[8px] text-vault-black/50 font-mono mt-0.5 animate-pulse">🔒 Encrypting cipher...</div>
                    {:else if msg.status === 'sending'}
                      <div class="text-[8px] text-vault-black/50 font-mono mt-0.5 animate-pulse">📡 Dispatching to Bob...</div>
                    {:else if msg.sender === 'Alice'}
                      <div class="text-[8px] text-vault-black/40 font-mono mt-0.5">✓ Decrypted & Verified by Bob</div>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          <form on:submit|preventDefault={() => runRatchetStep(simInput)} class="p-2.5 bg-vault-surface/30 border-t border-vault-border/20 flex gap-2">
            <input 
              type="text" 
              bind:value={simInput}
              placeholder={activeRatchetStep !== 'idle' || isDestructing ? 'Processing ratchet step...' : 'Type message as Alice...'} 
              disabled={activeRatchetStep !== 'idle' || isDestructing}
              class="input flex-grow bg-vault-black text-[11px] h-8.5 rounded-xl border border-vault-border/30 focus:border-vault-accent"
            />
            <button 
              type="submit"
              disabled={!simInput.trim() || activeRatchetStep !== 'idle' || isDestructing}
              class="px-3 text-[10px] font-bold bg-vault-text text-vault-black hover:bg-vault-text-secondary disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-all cursor-pointer flex items-center justify-center btn-glow"
            >
              Send
            </button>
          </form>

        {:else if simTab === 'call'}
          <!-- 📞 CALL SIMULATOR INTERFACE -->
          <div class="px-4 py-2.5 border-b border-vault-border/20 bg-vault-surface/40 flex items-center justify-between z-10">
            <div class="flex items-center gap-1.5">
              <span class="text-[10px] font-bold font-mono uppercase tracking-wider text-vault-text">E2EE Call Simulator</span>
            </div>
            <div class="flex items-center gap-2">
              {#if callState === 'connected'}
                <span class="relative flex h-1.5 w-1.5">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-vault-accent opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-vault-accent"></span>
                </span>
                <span class="text-[9px] font-bold font-mono text-vault-accent">{callTimer}</span>
              {:else if callState === 'ringing'}
                <span class="text-[8px] text-vault-warning font-mono bg-vault-warning/10 border border-vault-warning/20 px-1.5 py-0.5 rounded uppercase animate-pulse">Ringing...</span>
              {:else}
                <span class="text-[8px] text-vault-text-dim font-mono bg-vault-border/50 px-1.5 py-0.5 rounded uppercase">Disconnected</span>
              {/if}
            </div>
          </div>

          <div class="flex-1 p-5 flex flex-col justify-between overflow-y-auto z-10 relative text-center">
            {#if callState === 'ringing'}
              <!-- Ringing Screen -->
              <div class="flex-grow flex flex-col items-center justify-center gap-4 animate-fade-in my-auto">
                <div class="relative w-18 h-18 flex items-center justify-center">
                  <div class="absolute inset-0 rounded-full border border-vault-accent/35 animate-ping opacity-75"></div>
                  <div class="absolute inset-1 rounded-full border border-vault-accent/50 animate-pulse"></div>
                  <div class="w-14 h-14 bg-vault-surface border border-vault-border/40 rounded-full flex items-center justify-center text-xl select-none">👤</div>
                </div>
                <div>
                  <h3 class="text-sm font-bold text-vault-text">Bob</h3>
                  <p class="text-[10px] text-vault-text-dim mt-0.5">Incoming Secure P2P Video Call...</p>
                </div>
                <div class="flex gap-4 mt-2">
                  <button 
                    on:click={acceptSimCall}
                    class="py-2.5 px-5 text-[10px] bg-vault-accent text-vault-black hover:bg-vault-accent/90 font-bold rounded-xl transition-all cursor-pointer shadow-md focus:outline-none btn-glow-accent"
                  >
                    Accept
                  </button>
                  <button 
                    on:click={rejectSimCall}
                    class="py-2.5 px-5 text-[10px] bg-vault-danger/25 text-vault-danger hover:bg-vault-danger/35 border border-vault-danger/30 font-bold rounded-xl transition-all cursor-pointer focus:outline-none"
                  >
                    Decline
                  </button>
                </div>
              </div>
            {:else if callState === 'connected'}
              <!-- Connected Ongoing Call Screen -->
              <div class="flex-grow flex flex-col justify-between gap-4 animate-fade-in">
                
                <!-- Animated Frequency/Audio Voice Visualizer -->
                <div class="flex-1 flex items-center justify-center gap-1.5 h-24 my-auto">
                  {#each callFrequencies as height}
                    <div 
                      class="w-1.5 bg-vault-accent rounded-full transition-all duration-100" 
                      style="height: {height}px; opacity: {0.4 + (height/30)*0.6};"
                    ></div>
                  {/each}
                </div>

                <div class="mb-2">
                  <h3 class="text-sm font-bold text-vault-text">Bob</h3>
                  <p class="text-[9px] text-vault-accent font-mono uppercase tracking-wider">DTLS-SRTP Stream Active</p>
                </div>

                <div class="flex justify-center mb-2">
                  <button 
                    on:click={endSimCall}
                    class="py-2.5 px-6 text-[10px] bg-vault-danger text-vault-text font-bold rounded-xl transition-all cursor-pointer shadow-md focus:outline-none btn-glow"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            {:else}
              <!-- Call Ended / Call Idle Screen -->
              <div class="flex-1 flex flex-col items-center justify-center gap-3 select-none animate-fade-in">
                <span class="text-2xl mb-1">📞</span>
                <span class="text-[10px] font-mono text-vault-text-dim">E2EE Voice/Video channel idle.</span>
                <button 
                  on:click={startSimCall}
                  class="mt-2 py-2.5 px-5 text-[10px] bg-vault-text text-vault-black hover:bg-vault-text-secondary font-bold rounded-xl transition-all cursor-pointer shadow-md focus:outline-none btn-glow"
                >
                  Simulate Call Request
                </button>
              </div>
            {/if}
          </div>
        {/if}

      </div>

      <!-- Right Column: Unified Protocol Inspector (7 cols) -->
      <div class="lg:col-span-7 glass border border-vault-border/20 rounded-2xl p-5 flex flex-col justify-between shadow-lg min-h-[420px] text-left">
        <div>
          <!-- Title & Controls -->
          <div class="flex items-center justify-between border-b border-vault-border/20 pb-3 mb-4 text-left">
            <h3 class="text-xs font-bold text-vault-text tracking-wider uppercase flex items-center gap-1.5 font-mono">
              <span>⚡</span> {simTab === 'chat' ? 'Double Ratchet state' : 'WebRTC signaling state'}
            </h3>
            <span class="text-[9px] font-mono text-vault-text-dim">Epoch: {dhStepCount}</span>
          </div>

          {#if simTab === 'chat'}
            <!-- Inspector View Selector -->
            <div class="flex p-0.5 bg-vault-surface/40 border border-vault-border/30 rounded-xl glass w-fit mb-4 select-none text-[8px] font-bold font-mono">
              <button 
                on:click={() => chatInspectorView = 'ratchet'}
                class="px-2.5 py-1 rounded-lg transition-all focus:outline-none cursor-pointer {chatInspectorView === 'ratchet' ? 'bg-vault-elevated text-vault-text border border-vault-border/30 shadow' : 'text-vault-text-dim hover:text-vault-text'}"
              >
                🔑 Double Ratchet
              </button>
              <button 
                on:click={() => chatInspectorView = 'x3dh'}
                class="px-2.5 py-1 rounded-lg transition-all focus:outline-none cursor-pointer {chatInspectorView === 'x3dh' ? 'bg-vault-elevated text-vault-text border border-vault-border/30 shadow' : 'text-vault-text-dim hover:text-vault-text'}"
              >
                🤝 X3DH Handshake
              </button>
            </div>

            {#if chatInspectorView === 'ratchet'}
              <!-- 💬 CHAT PROTOCOL STATE METRICS & SVG -->
              <!-- Step Progress Visualizer -->
              <div class="grid grid-cols-4 gap-2 text-center text-[9px] font-bold font-mono mb-4 select-none">
                <div class="p-1.5 rounded-lg border {activeRatchetStep === 'dh' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}">
                  1. DH STEP
                </div>
                <div class="p-1.5 rounded-lg border {activeRatchetStep === 'kdf' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}">
                  2. KDF MERKLE
                </div>
                <div class="p-1.5 rounded-lg border {activeRatchetStep === 'encrypt' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}">
                  3. AES-GCM
                </div>
                <div class="p-1.5 rounded-lg border {activeRatchetStep === 'decrypt' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}">
                  4. RECIPIENT
                </div>
              </div>

              <!-- SVG Double Ratchet Schematic Diagram -->
              <div class="mb-4 p-2 bg-vault-surface/20 border border-vault-border/10 rounded-xl flex justify-center items-center relative overflow-hidden select-none">
                <svg class="w-full max-w-[420px] h-[100px]" viewBox="0 0 450 120">
                  <defs>
                    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--color-vault-border)" />
                    </marker>
                    <marker id="arrow-active" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--color-vault-accent)" />
                    </marker>
                    <filter id="neon-glow" x="-50%" y="-50%" width="200%" height="200%">
                      <feGaussianBlur stdDeviation="3" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>

                  <!-- Node 1: DH Secret -->
                  <g transform="translate(60, 60)">
                    <circle cx="0" cy="0" r="22" class="transition-all duration-300 {activeRatchetStep === 'dh' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2 animate-pulse' : 'fill-vault-surface stroke-vault-border/50'}" filter={activeRatchetStep === 'dh' ? 'url(#neon-glow)' : ''} />
                    <text x="0" y="3" class="text-[9px] font-mono font-bold {activeRatchetStep === 'dh' ? 'fill-vault-accent' : 'fill-vault-text'}" text-anchor="middle">DH Sec</text>
                  </g>

                  <!-- Connection DH -> KDF -->
                  <line x1="82" y1="60" x2="155" y2="60" class="transition-all duration-300 stroke-[1.25px] {activeRatchetStep === 'dh' || activeRatchetStep === 'kdf' ? 'flow-line' : ''}" stroke={activeRatchetStep === 'dh' || activeRatchetStep === 'kdf' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} marker-end={activeRatchetStep === 'kdf' || activeRatchetStep === 'encrypt' ? 'url(#arrow-active)' : 'url(#arrow)'} />

                  <!-- Node 2: KDF Node -->
                  <g transform="translate(190, 60)">
                    <circle cx="0" cy="0" r="24" class="transition-all duration-300 {activeRatchetStep === 'kdf' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2 animate-pulse' : 'fill-vault-surface stroke-vault-border/50'}" filter={activeRatchetStep === 'kdf' ? 'url(#neon-glow)' : ''} />
                    <text x="0" y="3" class="text-[10px] font-mono font-bold {activeRatchetStep === 'kdf' ? 'fill-vault-accent' : 'fill-vault-text'}" text-anchor="middle">KDF</text>
                  </g>

                  <!-- Connection KDF -> Chain Key (UP) -->
                  <line x1="190" y1="36" x2="190" y2="20" class="transition-all duration-300 stroke-[1.25px]" stroke={activeRatchetStep === 'kdf' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} />
                  <g transform="translate(190, 16)">
                    <circle cx="0" cy="0" r="5" class="transition-all duration-300 {activeRatchetStep === 'kdf' ? 'fill-vault-accent' : 'fill-vault-text-dim'}" />
                    <text x="10" y="3" class="text-[8px] font-mono {activeRatchetStep === 'kdf' ? 'fill-vault-accent font-bold' : 'fill-vault-text-dim'}">Chain Key</text>
                  </g>

                  <!-- Connection KDF -> Message Key -->
                  <line x1="214" y1="60" x2="280" y2="60" class="transition-all duration-300 stroke-[1.25px] {activeRatchetStep === 'kdf' || activeRatchetStep === 'encrypt' ? 'flow-line' : ''}" stroke={activeRatchetStep === 'kdf' || activeRatchetStep === 'encrypt' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} marker-end={activeRatchetStep === 'encrypt' ? 'url(#arrow-active)' : 'url(#arrow)'} />

                  <!-- Node 4: Message Key -->
                  <g transform="translate(315, 60)">
                    <circle cx="0" cy="0" r="22" class="transition-all duration-300 {activeRatchetStep === 'encrypt' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2 animate-pulse' : 'fill-vault-surface stroke-vault-border/50'}" filter={activeRatchetStep === 'encrypt' ? 'url(#neon-glow)' : ''} />
                    <text x="0" y="3" class="text-[9px] font-mono font-bold {activeRatchetStep === 'encrypt' ? 'fill-vault-accent' : 'fill-vault-text'}" text-anchor="middle">Msg Key</text>
                  </g>

                  <!-- Connection Message Key -> Cipher -->
                  <line x1="337" y1="60" x2="375" y2="60" class="transition-all duration-300 stroke-[1.25px] {activeRatchetStep === 'encrypt' || activeRatchetStep === 'decrypt' ? 'flow-line' : ''}" stroke-dasharray="3 3" stroke={activeRatchetStep === 'encrypt' || activeRatchetStep === 'decrypt' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} />
                  <g transform="translate(395, 60)">
                    <text x="0" y="4" class="text-sm select-none transition-transform duration-300 {activeRatchetStep === 'decrypt' ? 'scale-110' : ''}" text-anchor="middle">
                      {#if activeRatchetStep === 'decrypt'}
                        🔓
                      {:else if activeRatchetStep === 'encrypt'}
                        🔒
                      {:else}
                        ✉️
                      {/if}
                    </text>
                  </g>
                </svg>
              </div>

              <!-- State variables grid -->
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 text-[10px] font-mono select-all">
                <div class="p-2.5 bg-vault-surface/40 border border-vault-border/20 rounded-xl flex flex-col gap-0.5 relative group/key">
                  <span class="text-vault-text-dim text-[8px] font-semibold flex items-center justify-between">
                    SENDER CHAIN KEY
                    <button 
                      on:click={() => { navigator.clipboard.writeText(aliceChainKey); alert('Sender Chain Key copied to clipboard!'); }}
                      class="text-[7px] text-vault-text-dim group-hover/key:text-vault-accent hover:underline cursor-pointer bg-transparent border-none p-0 focus:outline-none"
                    >
                      Copy
                    </button>
                  </span>
                  <span class="text-vault-text-secondary truncate pr-6">{aliceChainKey}</span>
                </div>
                <div class="p-2.5 bg-vault-surface/40 border border-vault-border/20 rounded-xl flex flex-col gap-0.5 relative group/key2">
                  <span class="text-vault-text-dim text-[8px] font-semibold flex items-center justify-between">
                    RECEIVER CHAIN KEY
                    <button 
                      on:click={() => { navigator.clipboard.writeText(bobChainKey); alert('Receiver Chain Key copied to clipboard!'); }}
                      class="text-[7px] text-vault-text-dim group-hover/key2:text-vault-accent hover:underline cursor-pointer bg-transparent border-none p-0 focus:outline-none"
                    >
                      Copy
                    </button>
                  </span>
                  <span class="text-vault-text-secondary truncate pr-6">{bobChainKey}</span>
                </div>
                <div class="p-2.5 bg-vault-surface/40 border border-vault-border/20 rounded-xl flex flex-col gap-0.5 md:col-span-2 relative group/key3">
                  <span class="text-vault-text-dim text-[8px] font-semibold flex items-center justify-between">
                    EPHEMERAL MESSAGE DECRYPTION KEY
                    <button 
                      on:click={() => { navigator.clipboard.writeText(derivedMessageKey); alert('Decryption Message Key copied to clipboard!'); }}
                      class="text-[7px] text-vault-text-dim group-hover/key3:text-vault-accent hover:underline cursor-pointer bg-transparent border-none p-0 focus:outline-none"
                    >
                      Copy
                    </button>
                  </span>
                  <span class="text-vault-text font-bold truncate pr-6 transition-colors duration-300 {activeRatchetStep === 'encrypt' || activeRatchetStep === 'decrypt' ? 'text-vault-accent text-glow-accent' : ''}">{derivedMessageKey}</span>
                </div>
              </div>
            {:else}
              <!-- 🤝 X3DH HANDSHAKE PROTOCOL STACK -->
              <div class="mb-4 p-3 bg-vault-surface/20 border border-vault-border/10 rounded-xl flex flex-col gap-3 font-mono text-[9px] text-vault-text-secondary select-none animate-fade-in">
                <div class="text-[10px] font-bold text-vault-text border-b border-vault-border/10 pb-1.5 flex items-center justify-between">
                  <span>X3DH Handshake Protocol Setup</span>
                  <span class="text-[8px] px-1 bg-vault-accent/10 text-vault-accent rounded font-normal">Offline Negotiated</span>
                </div>
                
                <div class="relative flex flex-col gap-4 pl-4 border-l-2 border-vault-border/30 py-1">
                  <!-- Step 1 -->
                  <div class="relative">
                    <div class="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-vault-accent"></div>
                    <div class="font-bold text-vault-text">1. Prekey Publishing (Bob)</div>
                    <div class="text-vault-text-dim text-[8.5px] mt-0.5 leading-relaxed">
                      Bob uploads Identity Key (IK_B), Signed Prekey (SPK_B) signed with his key, and One-Time Prekey Bundle (OPK_B) to the network.
                    </div>
                  </div>
                  
                  <!-- Step 2 -->
                  <div class="relative">
                    <div class="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-vault-accent"></div>
                    <div class="font-bold text-vault-text">2. Prekey Fetching (Alice)</div>
                    <div class="text-vault-text-dim text-[8.5px] mt-0.5 leading-relaxed">
                      Alice fetches Bob's prekey bundle from the gateway. Alice generates an ephemeral keypair (EK_A).
                    </div>
                  </div>
                  
                  <!-- Step 3 -->
                  <div class="relative">
                    <div class="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-vault-accent"></div>
                    <div class="font-bold text-vault-text">3. DH Computations & Root Key Derivation</div>
                    <div class="text-vault-text-dim text-[8.5px] mt-0.5 leading-relaxed">
                      Alice computes four Diffie-Hellman handshakes:<br/>
                      <span class="text-vault-accent">DH1 = (IK_A, SPK_B)</span> | 
                      <span class="text-vault-accent">DH2 = (EK_A, IK_B)</span> | 
                      <span class="text-vault-accent">DH3 = (EK_A, SPK_B)</span> | 
                      <span class="text-vault-accent">DH4 = (EK_A, OPK_B)</span><br/>
                      Concatenates secrets into a Master Salt: KDF(DH1 || DH2 || DH3 || DH4) ➔ Root Session Key.
                    </div>
                  </div>
                  
                  <!-- Step 4 -->
                  <div class="relative">
                    <div class="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-vault-accent"></div>
                    <div class="font-bold text-vault-text">4. Offline Handshake Envelope</div>
                    <div class="text-vault-text-dim text-[8.5px] mt-0.5 leading-relaxed">
                      Alice encrypts her first message with the Root Key. She uploads her Identity Key (IK_A), Ephemeral Key (EK_A), and cipher text to Bob's mailbox.
                    </div>
                  </div>
                  
                  <!-- Step 5 -->
                  <div class="relative">
                    <div class="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-vault-accent"></div>
                    <div class="font-bold text-vault-text">5. Decryption & Setup (Bob)</div>
                    <div class="text-vault-text-dim text-[8.5px] mt-0.5 leading-relaxed">
                      Bob returns online, reads Alice's envelope, performs matching DH calculations using his private keys, derives the same Root Key, and decrypts the channel.
                    </div>
                  </div>
                </div>
              </div>
            {/if}

          {:else}
            <!-- 📞 CALL SIGNALING DETAILS -->
            <div class="mb-3 flex items-center justify-between gap-2">
              <p class="leading-relaxed text-[10px] text-vault-text-secondary flex-1">
                Voice/video streams are symmetric-key encrypted using a key negotiated over the same Double Ratchet session as your messages, then carried peer-to-peer over WebRTC (DTLS-SRTP) — the server only relays SDP/ICE signaling, never media.
              </p>
              <button
                on:click={toggleIceMode}
                class="shrink-0 text-[8px] font-mono font-bold uppercase px-2 py-1 rounded-lg border transition-all cursor-pointer {iceMode === 'relay' ? 'bg-vault-warning/10 border-vault-warning/30 text-vault-warning' : 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent'}"
                title="Toggle simulated NAT traversal path"
              >
                {iceMode === 'relay' ? '🔀 TURN Relay' : '⇄ Direct P2P'}
              </button>
            </div>

            <!-- Step Progress Visualizer -->
            <div class="grid grid-cols-4 gap-2 text-center text-[9px] font-bold font-mono mb-4 select-none">
              <div class="p-1.5 rounded-lg border {activeCallStep === 'signaling' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}">
                1. SDP OFFER
              </div>
              <div class="p-1.5 rounded-lg border {activeCallStep === 'ice' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}">
                2. ICE GATHER
              </div>
              <div class="p-1.5 rounded-lg border {activeCallStep === 'dtls' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}">
                3. DTLS-SRTP
              </div>
              <div class="p-1.5 rounded-lg border {activeCallStep === 'media' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}">
                4. MEDIA FLOW
              </div>
            </div>

            <!-- SVG Live Connection Path Diagram -->
            <div class="mb-4 p-2 bg-vault-surface/20 border border-vault-border/10 rounded-xl flex justify-center items-center relative overflow-hidden select-none">
              <svg class="w-full max-w-[420px] h-[110px]" viewBox="0 0 450 130">
                <defs>
                  <marker id="call-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--color-vault-border)" />
                  </marker>
                  <marker id="call-arrow-active" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 2 L 8 5 L 0 8 z" fill="var(--color-vault-accent)" />
                  </marker>
                  <filter id="call-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                <!-- Alice node -->
                <g transform="translate(45, 65)">
                  <circle cx="0" cy="0" r="20" class="fill-vault-surface stroke-vault-border/50" />
                  <text x="0" y="4" class="text-[10px] select-none" text-anchor="middle">🎙️</text>
                  <text x="0" y="32" class="text-[8px] font-mono font-bold fill-vault-text-dim" text-anchor="middle">You</text>
                </g>

                <!-- Signaling server (top path) -->
                <line x1="65" y1="55" x2="185" y2="25" class="transition-all duration-300 stroke-[1.25px] {activeCallStep === 'signaling' ? 'flow-line' : ''}" stroke={activeCallStep === 'signaling' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} marker-end="url(#call-arrow)" />
                <line x1="265" y1="25" x2="385" y2="55" class="transition-all duration-300 stroke-[1.25px] {activeCallStep === 'signaling' ? 'flow-line' : ''}" stroke={activeCallStep === 'signaling' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} marker-end={activeCallStep === 'signaling' ? 'url(#call-arrow-active)' : 'url(#call-arrow)'} />
                <g transform="translate(225, 20)">
                  <circle cx="0" cy="0" r="22" class="transition-all duration-300 {activeCallStep === 'signaling' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2 animate-pulse' : 'fill-vault-surface stroke-vault-border/50'}" filter={activeCallStep === 'signaling' ? 'url(#call-glow)' : ''} />
                  <text x="0" y="3" class="text-[7px] font-mono font-bold {activeCallStep === 'signaling' ? 'fill-vault-accent' : 'fill-vault-text'}" text-anchor="middle">Signal</text>
                </g>

                <!-- STUN/TURN node (only relevant mid-path) -->
                <g transform="translate(225, 90)">
                  <circle cx="0" cy="0" r="22" class="transition-all duration-300 {activeCallStep === 'ice' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2 animate-pulse' : 'fill-vault-surface stroke-vault-border/50'} {iceMode === 'relay' ? '' : 'opacity-40'}" filter={activeCallStep === 'ice' ? 'url(#call-glow)' : ''} />
                  <text x="0" y="3" class="text-[7px] font-mono font-bold {activeCallStep === 'ice' ? 'fill-vault-accent' : 'fill-vault-text'}" text-anchor="middle">{iceMode === 'relay' ? 'TURN' : 'STUN'}</text>
                </g>
                <line x1="65" y1="70" x2="203" y2="88" class="transition-all duration-300 stroke-[1.25px] {activeCallStep === 'ice' ? 'flow-line' : ''}" stroke-dasharray="3 3" stroke={activeCallStep === 'ice' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} />
                <line x1="247" y1="88" x2="385" y2="70" class="transition-all duration-300 stroke-[1.25px] {activeCallStep === 'ice' ? 'flow-line' : ''}" stroke-dasharray="3 3" stroke={activeCallStep === 'ice' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} />

                <!-- Direct P2P path (highlighted once media flowing, only when direct) -->
                <line x1="65" y1="68" x2="385" y2="68" class="transition-all duration-500 stroke-[1.5px] {activeCallStep === 'media' && iceMode === 'direct' ? 'flow-line' : ''}" stroke={activeCallStep === 'media' && iceMode === 'direct' ? 'var(--color-vault-accent)' : 'transparent'} marker-end={activeCallStep === 'media' && iceMode === 'direct' ? 'url(#call-arrow-active)' : ''} />

                <!-- Bob node -->
                <g transform="translate(405, 65)">
                  <circle cx="0" cy="0" r="20" class="transition-all duration-300 {activeCallStep === 'media' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2' : 'fill-vault-surface stroke-vault-border/50'}" />
                  <text x="0" y="4" class="text-[10px] select-none" text-anchor="middle">👤</text>
                  <text x="0" y="32" class="text-[8px] font-mono font-bold fill-vault-text-dim" text-anchor="middle">Bob</text>
                </g>
              </svg>
            </div>

            <!-- Live ICE / SRTP state grid -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 text-[10px] font-mono select-all">
              <div class="p-2.5 bg-vault-surface/40 border border-vault-border/20 rounded-xl flex flex-col gap-0.5 relative group/ice1">
                <span class="text-vault-text-dim text-[8px] font-semibold flex items-center justify-between">
                  LOCAL ICE CANDIDATE
                  <button
                    on:click={() => { navigator.clipboard.writeText(localCandidate); alert('Local ICE candidate copied to clipboard!'); }}
                    class="text-[7px] text-vault-text-dim group-hover/ice1:text-vault-accent hover:underline cursor-pointer bg-transparent border-none p-0 focus:outline-none"
                  >
                    Copy
                  </button>
                </span>
                <span class="text-vault-text-secondary truncate pr-6">{localCandidate}</span>
              </div>
              <div class="p-2.5 bg-vault-surface/40 border border-vault-border/20 rounded-xl flex flex-col gap-0.5 relative group/ice2">
                <span class="text-vault-text-dim text-[8px] font-semibold flex items-center justify-between">
                  REMOTE ICE CANDIDATE
                  <button
                    on:click={() => { navigator.clipboard.writeText(remoteCandidate); alert('Remote ICE candidate copied to clipboard!'); }}
                    class="text-[7px] text-vault-text-dim group-hover/ice2:text-vault-accent hover:underline cursor-pointer bg-transparent border-none p-0 focus:outline-none"
                  >
                    Copy
                  </button>
                </span>
                <span class="text-vault-text-secondary truncate pr-6">{remoteCandidate}</span>
              </div>
              <div class="p-2.5 bg-vault-surface/40 border border-vault-border/20 rounded-xl flex flex-col gap-0.5 relative group/ice3">
                <span class="text-vault-text-dim text-[8px] font-semibold flex items-center justify-between">
                  SRTP CIPHER
                  <button
                    on:click={() => { navigator.clipboard.writeText(srtpCipher); alert('SRTP cipher copied to clipboard!'); }}
                    class="text-[7px] text-vault-text-dim group-hover/ice3:text-vault-accent hover:underline cursor-pointer bg-transparent border-none p-0 focus:outline-none"
                  >
                    Copy
                  </button>
                </span>
                <span class="text-vault-text-secondary truncate pr-6 transition-colors duration-300 {activeCallStep === 'dtls' || activeCallStep === 'media' ? 'text-vault-accent text-glow-accent' : ''}">{srtpCipher}</span>
              </div>
              <div class="p-2.5 bg-vault-surface/40 border border-vault-border/20 rounded-xl flex flex-col gap-0.5">
                <span class="text-vault-text-dim text-[8px] font-semibold">LINK QUALITY</span>
                <div class="flex items-center gap-2">
                  <div class="flex-1 h-1.5 bg-vault-border/30 rounded-full overflow-hidden">
                    <div class="h-full bg-vault-accent transition-all duration-700 rounded-full" style="width: {activeCallStep === 'media' ? connQuality : 0}%"></div>
                  </div>
                  <span class="text-vault-text-secondary text-[9px] w-8 text-right">{activeCallStep === 'media' ? connQuality : '--'}%</span>
                </div>
              </div>
            </div>
          {/if}
        </div>

        <!-- Terminal Logs (Shared layout) -->
        <div class="flex-grow flex flex-col justify-end">
          <span class="text-[9px] text-vault-text-dim font-bold font-mono tracking-wide uppercase mb-1.5 block">Console output:</span>
          <div id="sim-terminal" class="bg-vault-black/80 border border-vault-border/20 rounded-xl p-3 h-28 overflow-y-auto font-mono text-[9px] text-vault-text-secondary leading-relaxed scroll-smooth flex flex-col gap-1 shadow-inner">
            {#if simTab === 'chat'}
              {#each ratchetLogs as log}
                <div class="flex items-start gap-1">
                  <span class="text-vault-accent/70">▶</span>
                  <span class="break-all">{log}</span>
                </div>
              {/each}
            {:else}
              {#each callLogs as log}
                <div class="flex items-start gap-1">
                  <span class="text-vault-accent/70">▶</span>
                  <span class="break-all">{log}</span>
                </div>
              {/each}
              {#if callState === 'ringing'}
                <div class="text-vault-accent/80 animate-pulse font-bold mt-0.5">● Waiting for user response...</div>
              {:else if callState === 'connected'}
                <div class="text-vault-accent/80 animate-pulse font-bold mt-0.5">● Stream active. Exchanging media packets...</div>
              {/if}
            {/if}
          </div>
        </div>

      </div>
    </div>
  </section>

  <!-- Cryptographic Details Grid (Progressive Disclosure) -->
  <section class="w-full max-w-5xl mx-auto px-6 py-12 z-10 border-t border-vault-border/20 reveal-section">
    <div class="text-center mb-8">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Protocol Suite</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Hover or tap on any capability card to inspect its cryptographic implementation details.</p>
    </div>
    
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each features as feature, idx}
        <button
          type="button"
          on:click={() => toggleFeature(idx)}
          class="group flex flex-col gap-2 p-5 bg-vault-surface/20 border border-vault-border/15 rounded-2xl hover:border-vault-accent/20 transition-all hover:bg-vault-surface/40 hover:-translate-y-0.5 duration-200 shadow-sm glass relative overflow-hidden cursor-pointer text-left w-full block glow-card"
        >
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-vault-surface border border-vault-border/50 flex items-center justify-center text-vault-text-secondary group-hover:text-vault-accent group-hover:border-vault-accent/30 transition-all shadow-inner">
              {@html feature.icon}
            </div>
            <h4 class="text-xs font-bold text-vault-text group-hover:text-vault-accent transition-colors duration-200">{feature.title}</h4>
          </div>
          
          <!-- Smooth expansion container using CSS Grid Transition -->
          <div class="grid transition-all duration-300 ease-in-out {activeFeatureIndex === idx ? 'grid-rows-[1fr]' : 'grid-rows-[0fr] md:group-hover:grid-rows-[1fr]'}">
            <p class="text-[10px] text-vault-text-secondary leading-relaxed font-normal overflow-hidden transition-opacity duration-200 pt-1.5 {activeFeatureIndex === idx ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'}">
              {feature.desc}
            </p>
          </div>
        </button>
      {/each}
    </div>
  </section>

  <!-- Honest Comparison Table -->
  <section class="w-full max-w-4xl mx-auto px-6 py-12 z-10 border-t border-vault-border/20 reveal-section">
    <div class="text-center mb-8">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">How Vault Compares</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">A plain look at where Vault stands next to the messengers you already know — including where it falls short.</p>
    </div>

    <div class="overflow-x-auto rounded-2xl border border-vault-border/20 glass">
      <table class="w-full text-left border-collapse min-w-[560px]">
        <thead>
          <tr class="border-b border-vault-border/20 text-[9px] font-mono font-bold uppercase tracking-wider text-vault-text-dim">
            <th class="py-3 pl-5 pr-3 font-bold">Capability</th>
            <th class="py-3 px-3 text-center text-vault-accent">Vault</th>
            <th class="py-3 px-3 text-center">Signal</th>
            <th class="py-3 px-3 text-center">Telegram</th>
            <th class="py-3 px-3 pr-5 text-center">WhatsApp</th>
          </tr>
        </thead>
        <tbody>
          {#each comparisonRows as row, i}
            <tr class="{i % 2 === 0 ? 'bg-vault-surface/10' : ''} border-b border-vault-border/10 last:border-0">
              <td class="py-3 pl-5 pr-3 text-[11px] text-vault-text-secondary">{row.label}</td>
              {#each [row.vault, row.signal, row.telegram, row.whatsapp] as cell, ci}
                <td class="py-3 px-3 {ci === 3 ? 'pr-5' : ''} text-center">
                  {#if cell === true}
                    <span class="text-vault-accent font-bold" title="Yes">✓</span>
                  {:else if cell === false}
                    <span class="text-vault-text-dim/50 font-bold" title="No">✕</span>
                  {:else}
                    <span class="text-[8px] font-mono font-bold uppercase text-vault-text-dim" title={cell}>{cell.replace(/-/g, ' ')}</span>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="text-[9px] text-vault-text-dim text-center mt-3 opacity-70">Self-hosting/federation is a gap we have too, not just something we're calling out in others.</p>
  </section>

  <!-- Collapsible FAQ Accordion Section -->
  <section class="w-full max-w-3xl mx-auto px-6 py-12 z-10 border-t border-vault-border/20 reveal-section">
    <div class="text-center mb-8">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Frequently Asked Questions</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Deep-dive technical details about Vault's security model.</p>
    </div>

    <div class="flex flex-col gap-3">
      {#each faqs as faq, index}
        <div class="glass-strong border border-vault-border/20 rounded-2xl overflow-hidden shadow-sm transition-all duration-200 glow-card">
          <button 
            on:click={() => toggleFaq(index)}
            class="w-full px-5 py-3.5 flex items-center justify-between text-left focus:outline-none cursor-pointer bg-vault-surface/10 hover:bg-vault-surface/30 transition-colors"
          >
            <span class="text-xs font-bold text-vault-text">{faq.q}</span>
            <span class="text-vault-accent/80 transition-transform duration-200 {activeFaqIndex === index ? 'rotate-180' : ''}">
              <svg class="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </span>
          </button>
          
          {#if activeFaqIndex === index}
            <div class="px-5 pb-4 pt-0.5 text-[10px] text-vault-text-secondary leading-relaxed font-normal border-t border-vault-border/10 bg-vault-surface/5 animate-fade-in">
              {faq.a}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <footer class="w-full border-t border-vault-border/20 bg-vault-surface/40 py-8 z-10">
    <div class="max-w-5xl mx-auto px-6 flex flex-col items-center gap-5">

      <div class="w-full flex flex-col sm:flex-row justify-between items-center gap-4 text-[9px] text-vault-text-dim uppercase tracking-wider font-semibold">
        <div class="flex items-center gap-1.5">
          <span>© {new Date().getFullYear()} Vault Cryptosystems</span>
        </div>
        <div class="flex gap-4">
          <span>X3DH + Double Ratchet</span>
          <span>In-Memory / IndexedDB</span>
        </div>
      </div>

    </div>
  </footer>
</div>

<style>
  /* Local smooth animations */
  .grid > div {
    animation: fadeIn 0.4s ease-out;
  }

  /* Puff out disappear animation for auto-destruct */
  :global(.destruct-puff) {
    animation: puffOut 0.75s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
  }

  @keyframes puffOut {
    0% {
      opacity: 1;
      transform: scale(1);
      filter: blur(0px);
    }
    100% {
      opacity: 0;
      transform: scale(1.1);
      filter: blur(8px);
    }
  }

  /* Premium glow hover buttons */
  .btn-glow {
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .btn-glow:hover:not(:disabled) {
    box-shadow: 0 0 16px rgba(250, 250, 250, 0.12);
    transform: translateY(-0.5px);
  }
  .btn-glow-accent {
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .btn-glow-accent:hover:not(:disabled) {
    box-shadow: 0 0 16px rgba(16, 185, 129, 0.25);
    transform: translateY(-0.5px);
  }

  /* Subtle draw-the-eye pulse on the inactive Call tab so visitors notice
     there's a second, equally-built demo behind the default Chat tab. */
  :global(.call-tab-attract) {
    animation: callTabAttract 2.6s ease-in-out infinite;
  }
  @keyframes callTabAttract {
    0%, 100% { box-shadow: 0 0 0 rgba(16, 185, 129, 0); }
    50% { box-shadow: 0 0 10px rgba(16, 185, 129, 0.18); }
  }

  /* Radar sweep rotating line */
  :global(.animate-radar-sweep) {
    animation: radarRotate 4s linear infinite;
  }
  @keyframes radarRotate {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  /* Laser scanner scanning effect */
  :global(.animate-scanner-scan) {
    animation: scannerScan 2s ease-in-out infinite;
  }
  @keyframes scannerScan {
    0%, 100% { top: 5%; }
    50% { top: 95%; }
  }

  /* Scroll Reveal animation using simple fade-in-up */
  :global(.reveal-section) {
    animation: fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes fadeInUp {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Card Glow Borders on hover */
  :global(.glow-card) {
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
  }
  :global(.glow-card:hover) {
    border-color: rgba(16, 185, 129, 0.3) !important;
    box-shadow: 0 0 20px rgba(16, 185, 129, 0.05) !important;
  }

  /* Respect OS-level reduced-motion preference — this page runs a lot of
     concurrent decorative animation (radar sweep, pulses, live diagrams). */
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
</style>
