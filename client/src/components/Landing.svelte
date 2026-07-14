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

  onMount(() => {
    // Force dark mode
    document.documentElement.classList.remove('light');

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
    };
  });

  // Unified Simulator Tab Switcher
  let simTab = 'chat'; // 'chat' | 'wallet'
  let chatInspectorView = 'ratchet'; // 'ratchet' | 'x3dh'

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

  // DeFi Wallet Simulator state
  let selectedChain = 'solana';
  let isShieldedRails = false;
  let walletStatus = 'idle'; // 'idle' | 'routing' | 'signing' | 'broadcasting' | 'success'
  let walletLogs = [
    '[Init] Non-custodial keychain loaded. Seed phrase encrypted under local WebAuthn key.'
  ];
  let walletTab = 'send'; // 'send' | 'swap'
  let fromToken = 'USDC';
  let toToken = 'SOL';
  let swapAmount = '50';
  let sendRecipient = 'alice.vault';
  let sendAmount = '20';
  let txHash = '';

  // WebAuthn Lock/Unlock state
  let walletLocked = false;
  let isBiometricScanning = false;

  let solBalance = '12.45';
  let solSecondary = '150.00 USDC';
  let ethBalance = '0.84';
  let ethSecondary = '1,200.00 USDT';
  let baseBalance = '2.31';
  let baseSecondary = '480.00 USDC';
  let bscBalance = '4.25';
  let bscSecondary = '1,250.00 USDT';
  let btcBalance = '0.045';

  function simulateWalletAction() {
    if (walletStatus !== 'idle' || walletLocked) return;
    walletLogs = [];
    txHash = '';

    if (walletTab === 'swap') {
      walletStatus = 'routing';
      walletLogs = [...walletLogs, `[Routing] Querying cross-chain liquidity paths for ${swapAmount} ${fromToken}...`];
      
      setTimeout(() => {
        walletLogs = [...walletLogs, `[Routing] Best route found: Swap ${fromToken} ➔ Bridge (Li.Fi) ➔ ${toToken} (Est. fee: $0.12)`];
        walletStatus = 'signing';
        walletLogs = [...walletLogs, `[Signing] Local transaction request prompted. Waiting for signature...`];

        setTimeout(() => {
          walletStatus = 'broadcasting';
          walletLogs = [...walletLogs, `[Broadcasting] Transaction signed using local private keys. Broadcasting payload...`];

          setTimeout(() => {
            walletStatus = 'success';
            const randomHash = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
            txHash = '0x' + randomHash.substring(0, 16) + '...';
            walletLogs = [...walletLogs, `[Success] Cross-chain exchange complete. Tx: ${txHash}`];
            
            if (selectedChain === 'solana') {
              solBalance = '15.22';
              solSecondary = '100.00 USDC';
            } else if (selectedChain === 'ethereum') {
              ethBalance = '1.02';
              ethSecondary = '1,150.00 USDT';
            } else if (selectedChain === 'bsc') {
              bscBalance = '5.12';
              bscSecondary = '1,100.00 USDT';
            }
          }, 1000);
        }, 1000);
      }, 1000);
    } else if (walletTab === 'send') {
      walletStatus = 'signing';
      if (isShieldedRails) {
        walletLogs = [...walletLogs, `[zk-SNARK] Initiating parameters for client-side confidential UTXO spend...`];
        
        setTimeout(() => {
          walletLogs = [...walletLogs, `[zk-SNARK] Generating zero-knowledge input parameters...`];
          
          setTimeout(() => {
            walletLogs = [...walletLogs, `[zk-SNARK] Computing zk proof values (proving key)...`];
            
            setTimeout(() => {
              walletLogs = [...walletLogs, `[zk-SNARK] Secret inputs generated. Hiding sender and recipient addresses.`];
              walletStatus = 'broadcasting';
              walletLogs = [...walletLogs, `[Broadcasting] Dispatching shielded proof payload to RPC provider...`];

              setTimeout(() => {
                walletStatus = 'success';
                txHash = '0xzk' + Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
                walletLogs = [...walletLogs, `[Success] Zero-knowledge confidential transfer broadcasted. Tx: ${txHash}`];
              }, 1000);
            }, 800);
          }, 800);
        }, 800);
      } else {
        walletLogs = [...walletLogs, `[Signing] Requesting biometric confirmation for public address send...`];
        setTimeout(() => {
          walletStatus = 'broadcasting';
          walletLogs = [...walletLogs, `[Broadcasting] Sending signed payload to JSON-RPC node provider...`];
          setTimeout(() => {
            walletStatus = 'success';
            txHash = '0x' + Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
            walletLogs = [...walletLogs, `[Success] Public transfer confirmed. Tx: ${txHash}`];
          }, 1000);
        }, 1000);
      }
    }
  }

  function simulateBiometricUnlock() {
    if (!walletLocked || isBiometricScanning) return;
    isBiometricScanning = true;
    walletLogs = [...walletLogs, `[WebAuthn] Initializing credentials request via FaceID/TouchID...`];

    setTimeout(() => {
      walletLogs = [...walletLogs, `[WebAuthn] User successfully verified. PRF extension returned secret bits.`];
      
      setTimeout(() => {
        walletLogs = [...walletLogs, `[WebAuthn] Decrypted local database key. Session restored.`];
        isBiometricScanning = false;
        walletLocked = false;
      }, 800);
    }, 1200);
  }

  function resetWalletDemo() {
    walletStatus = 'idle';
    walletLocked = false;
    isBiometricScanning = false;
    walletLogs = ['[Reset] Simulator reset. Non-custodial balances restored.'];
    txHash = '';
    solBalance = '12.45';
    solSecondary = '150.00 USDC';
    ethBalance = '0.84';
    ethSecondary = '1,200.00 USDT';
    baseBalance = '2.31';
    baseSecondary = '480.00 USDC';
    bscBalance = '4.25';
    bscSecondary = '1,250.00 USDT';
  }

  // FAQ Accordion State
  let activeFaqIndex = null;
  const faqs = [
    {
      q: 'Is Vault truly non-custodial? How is my wallet secured?',
      a: 'Yes. All mnemonic seed phrases and private keys are generated entirely client-side in browser memory and are never sent to our servers. They are stored locally in IndexedDB encrypted using AES-GCM-256 with a key derived from your master password or a secure WebAuthn PRF credential (biometrics). The server is completely zero-knowledge regarding your assets.'
    },
    {
      q: 'What is the Double Ratchet protocol, and why does it matter?',
      a: 'Double Ratchet is a protocol used to negotiate keys for every single message. It combines a DH ratchet (generating fresh secrets dynamically) and a KDF symmetric ratchet (generating single-use message keys). This ensures perfect forward secrecy: if an attacker compromises a single message key, they cannot read past messages or future messages.'
    },
    {
      q: 'How does the zk-SNARK private payment system work?',
      a: 'Standard blockchain transactions expose sender, recipient, and amount publicly. When you toggle private rails in Vault, the app generates a zero-knowledge proof client-side to shield the transaction details on-chain. The zero-knowledge proof verifies the validity of the transaction (inputs match outputs) without revealing the addresses or value on the public ledger.'
    },
    {
      q: 'What happens to my keys when I close the browser tab?',
      a: 'Your active decrypted keys live exclusively in volatile JS memory. Closing the tab immediately destroys these keys. When you return, you must re-authenticate (via master password or WebAuthn biometrics) to decrypt your local IndexDB database and resume messaging.'
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

  // Security & DeFi features list (Updated with 3 new features)
  const features = [
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
      </svg>`,
      title: 'Multi-Chain DeFi Wallet',
      desc: 'Native support for Bitcoin, Solana, Ethereum, Base, Arbitrum, Optimism, and Polygon mainnet balances fetched live from RPCs.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>`,
      title: 'zk-SNARK Private Payments',
      desc: 'Broadcast confidential transactions inside chat streams where addresses are completely hidden under zero-knowledge proofs.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21.75c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94-3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
      </svg>`,
      title: 'E2EE Group Messaging',
      desc: 'Leverages the Signal Sender Keys Protocol to scale secure, encrypted group chat. Optimizes communication complexity from O(N) to O(1) client overhead.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
      </svg>`,
      title: 'WalletConnect dApp Gateway',
      desc: 'Link securely with decentralized applications (e.g. Uniswap) and sign contract calls using local biometrics.'
    },
    {
      icon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>`,
      title: 'Optimized Cross-Chain Routing',
      desc: 'Look up paths and swap tokens instantly between EVM and Solana chains via unified bridging protocols.'
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
      <span class="text-[8px] bg-vault-border/50 text-vault-text-secondary border border-vault-border px-1.5 py-0.5 rounded font-mono">BETA</span>
    </div>

    <div>
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
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">Proofs: zk-SNARK UTXO</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">WebRTC: DTLS-SRTP</span>
      <span class="px-2 py-0.5 rounded border border-vault-border/30 bg-vault-surface/40 text-vault-text-secondary">Keys: WebAuthn PRF</span>
    </div>

    <h1 class="text-4xl sm:text-5xl font-black tracking-tight leading-[1.08] max-w-2xl bg-gradient-to-b from-vault-text to-vault-text-secondary bg-clip-text text-transparent">
      Confidential Chat.<br/>Shielded Web3.
    </h1>
    
    <p class="text-xs sm:text-sm text-vault-text-secondary max-w-md leading-relaxed opacity-80">
      A zero-knowledge communications hub pairing end-to-end double-ratcheted messaging, private WebRTC streams, and local biometric-encrypted DeFi payment rails.
    </p>
    
    <div class="mt-2 flex flex-col sm:flex-row gap-3">
      <button 
        on:click={() => activeView.set('auth')} 
        class="py-3 px-6 text-xs bg-vault-text text-vault-black hover:bg-vault-text-secondary font-bold rounded-xl focus:outline-none transition-all cursor-pointer shadow-md btn-glow"
      >
        Start secure session
      </button>
    </div>
  </section>

  <!-- Unified tabbed playground simulator widget -->
  <section class="w-full max-w-5xl mx-auto px-6 py-10 z-10 border-t border-vault-border/20">
    <!-- Header of Sandbox -->
    <div class="flex flex-col sm:flex-row items-center justify-between gap-4 mb-6">
      <div class="text-left flex items-center gap-4">
        <div>
          <h2 class="text-lg font-bold tracking-tight text-vault-text">Protocol Sandbox</h2>
          <p class="text-[10px] text-vault-text-dim mt-0.5">Toggle between Alice's messaging tunnel and her local multi-chain wallet.</p>
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
          💬 Chat Protocol
        </button>
        <button 
          on:click={() => simTab = 'wallet'}
          class="px-3 py-1.5 text-[10px] font-bold rounded-lg transition-all focus:outline-none cursor-pointer {simTab === 'wallet' ? 'bg-vault-elevated text-vault-text border border-vault-border/30 shadow' : 'text-vault-text-dim hover:text-vault-text'}"
        >
          💳 DeFi Wallet
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

        {:else}
          <!-- 💳 DEFI WALLET SIMULATOR INTERFACE -->
          {#if isShieldedRails}
            <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(16,185,129,0.03)_0%,transparent_75%)] pointer-events-none z-0"></div>
          {/if}

          <div class="px-4 py-2.5 border-b border-vault-border/20 bg-vault-surface/40 flex items-center justify-between z-10">
            <div class="flex items-center gap-1.5">
              <span class="text-[10px] font-bold font-mono uppercase tracking-wider text-vault-text">Keychain Balance</span>
            </div>
            <!-- Chain Select Dropdown -->
            <select 
              bind:value={selectedChain}
              disabled={walletLocked}
              class="bg-vault-black border border-vault-border/30 rounded px-1.5 py-0.5 text-[9px] font-mono text-vault-text focus:outline-none focus:border-vault-accent cursor-pointer disabled:opacity-50"
            >
              <option value="solana">Solana (SPL)</option>
              <option value="ethereum">Ethereum (ERC20)</option>
              <option value="base">Base L2</option>
              <option value="bsc">BSC (BEP20)</option>
              <option value="bitcoin">Bitcoin Native</option>
            </select>
          </div>

          <div class="flex-1 p-4 flex flex-col justify-between overflow-y-auto z-10 relative">
            
            <!-- Sleek WebAuthn Lock/Unlock Overlay inside Card -->
            {#if walletLocked}
              <div class="absolute inset-0 bg-vault-black/85 backdrop-blur-md flex flex-col items-center justify-center p-4 z-20 animate-fade-in text-center">
                {#if isBiometricScanning}
                  <!-- Biometric Scan radar animation -->
                  <div class="relative w-16 h-16 mb-4 flex items-center justify-center">
                    <div class="absolute inset-0 rounded-full border border-vault-accent/35 animate-ping opacity-75"></div>
                    <div class="absolute inset-1 rounded-full border-2 border-vault-accent border-t-transparent animate-spin"></div>
                    <svg class="w-8 h-8 text-vault-accent animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M7.864 4.243A4 4 0 0111 3h2a4 4 0 013.136 1.243l2.764 2.764A4 4 0 0120 10v2a4 4 0 01-1.243 2.864l-2.764 2.764A4 4 0 0113 19h-2a4 4 0 01-3.136-1.243L5.092 15A4 4 0 014 12v-2a4 4 0 011.243-2.864l2.764-2.764z" />
                    </svg>
                  </div>
                  <div class="text-[10px] font-mono text-vault-accent animate-pulse">Scanning biometric credentials (FaceID/TouchID)...</div>
                {:else}
                  <svg class="w-10 h-10 text-vault-text-dim mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  <p class="text-[10px] text-vault-text-secondary leading-relaxed mb-3">Keychain encrypted locally in browser IndexedDB.</p>
                  <button 
                    on:click={simulateBiometricUnlock}
                    class="py-2 px-4 text-[10px] bg-vault-text text-vault-black hover:bg-vault-text-secondary font-bold rounded-xl transition-all cursor-pointer shadow-md focus:outline-none"
                  >
                    Unlock via Biometrics
                  </button>
                {/if}
              </div>
            {/if}

            <!-- Balance display Card -->
            <div class="p-3 bg-vault-elevated/70 border transition-all duration-300 rounded-xl flex flex-col gap-0.5 relative overflow-hidden {isShieldedRails ? 'border-vault-accent/40 shadow-[0_0_10px_rgba(16,185,129,0.05)]' : 'border-vault-border/20'} text-left">
              <div class="flex items-center justify-between text-[9px] font-mono text-vault-text-dim">
                <span>LOCAL KEYPAIR</span>
                <span class="text-vault-accent/80 font-bold">{selectedChain === 'solana' ? '9xQd...3zPq' : selectedChain === 'ethereum' ? '0x71C...a1B2' : selectedChain === 'base' ? '0x94f...c123' : selectedChain === 'bsc' ? '0x3bB...e5C6' : 'bc1q...5xyz'}</span>
              </div>
              
              <div class="flex items-baseline gap-1.5 mt-0.5">
                {#if selectedChain === 'solana'}
                  <span class="text-xl font-black text-vault-text">{solBalance}</span>
                  <span class="text-[10px] font-bold text-vault-text-secondary">SOL</span>
                {:else if selectedChain === 'ethereum'}
                  <span class="text-xl font-black text-vault-text">{ethBalance}</span>
                  <span class="text-[10px] font-bold text-vault-text-secondary">ETH</span>
                {:else if selectedChain === 'base'}
                  <span class="text-xl font-black text-vault-text">{baseBalance}</span>
                  <span class="text-[10px] font-bold text-vault-text-secondary">ETH</span>
                {:else if selectedChain === 'bsc'}
                  <span class="text-xl font-black text-vault-text">{bscBalance}</span>
                  <span class="text-[10px] font-bold text-vault-text-secondary">BNB</span>
                {:else if selectedChain === 'bitcoin'}
                  <span class="text-xl font-black text-vault-text">{btcBalance}</span>
                  <span class="text-[10px] font-bold text-vault-text-secondary">BTC</span>
                {/if}
              </div>

              <!-- Secondary token balances -->
              {#if selectedChain === 'solana'}
                <div class="text-[9px] text-vault-text-secondary font-mono">Secondary: {solSecondary}</div>
              {:else if selectedChain === 'ethereum'}
                <div class="text-[9px] text-vault-text-secondary font-mono">Secondary: {ethSecondary}</div>
              {:else if selectedChain === 'base'}
                <div class="text-[9px] text-vault-text-secondary font-mono">Secondary: {baseSecondary}</div>
              {:else if selectedChain === 'bsc'}
                <div class="text-[9px] text-vault-text-secondary font-mono">Secondary: {bscSecondary}</div>
              {/if}

              <!-- zk-SNARK rails toggle button -->
              <div class="mt-3 pt-2.5 border-t border-vault-border/20 flex items-center justify-between">
                <span class="text-[9px] font-mono font-bold text-vault-text-secondary flex items-center gap-1">
                  🛡️ Shielded UTXO Proofs
                </span>
                <button 
                  on:click={() => isShieldedRails = !isShieldedRails}
                  class="w-9 h-4.5 rounded-full p-0.5 transition-colors cursor-pointer {isShieldedRails ? 'bg-vault-accent' : 'bg-vault-border/50'}"
                  aria-label="Toggle Shielded Rails"
                >
                  <div class="w-3.5 h-3.5 bg-vault-black rounded-full shadow transition-transform {isShieldedRails ? 'translate-x-4.5' : ''}"></div>
                </button>
              </div>
            </div>

            <!-- Forms tabs -->
            <div class="mt-3 flex-1 flex flex-col justify-end">
              
              <!-- Tab operations and Lock selector -->
              <div class="flex items-center justify-between border-b border-vault-border/20 mb-2.5">
                <div class="flex text-[10px] font-bold font-mono">
                  <button 
                    on:click={() => walletTab = 'send'}
                    class="pb-1.5 px-2 border-b-2 {walletTab === 'send' ? 'border-vault-text text-vault-text' : 'border-transparent text-vault-text-dim'} cursor-pointer focus:outline-none"
                  >
                    Send Assets
                  </button>
                  <button 
                    on:click={() => walletTab = 'swap'}
                    class="pb-1.5 px-2 border-b-2 {walletTab === 'swap' ? 'border-vault-text text-vault-text' : 'border-transparent text-vault-text-dim'} cursor-pointer focus:outline-none"
                  >
                    DEX Swap
                  </button>
                </div>
                <button 
                  on:click={() => { walletLocked = true; walletLogs = [...walletLogs, '[Lock] Vault credentials locked. Decryption keys cleared from memory.']; }}
                  class="pb-1 text-[8px] font-mono text-vault-text-dim hover:text-vault-text cursor-pointer focus:outline-none flex items-center gap-1 bg-transparent border-none"
                >
                  🔒 Lock Card
                </button>
              </div>

              <!-- Tab content: Send -->
              {#if walletTab === 'send'}
                <div class="flex flex-col gap-2 text-left">
                  <div class="flex gap-2">
                    <div class="flex-grow">
                      <label for="send-recipient" class="text-[8px] font-bold text-vault-text-dim uppercase tracking-wider block mb-0.5">To Address</label>
                      <input 
                        id="send-recipient"
                        type="text" 
                        bind:value={sendRecipient} 
                        placeholder="e.g. alice.vault"
                        class="input bg-vault-black text-[10px] h-8 rounded-xl border border-vault-border/20 focus:border-vault-accent"
                      />
                    </div>
                    <div class="w-20">
                      <label for="send-amount" class="text-[8px] font-bold text-vault-text-dim uppercase tracking-wider block mb-0.5">Amount</label>
                      <input 
                        id="send-amount"
                        type="number" 
                        bind:value={sendAmount} 
                        class="input bg-vault-black text-[10px] h-8 rounded-xl border border-vault-border/20 focus:border-vault-accent"
                      />
                    </div>
                  </div>
                  <button 
                    on:click={simulateWalletAction}
                    disabled={walletStatus !== 'idle'}
                    class="w-full py-2 text-[10px] font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1 focus:outline-none {isShieldedRails ? 'bg-vault-accent text-vault-black hover:bg-vault-accent-hover btn-glow-accent' : 'bg-vault-text text-vault-black hover:bg-vault-text-secondary btn-glow'}"
                  >
                    {#if isShieldedRails}
                      🛡️ Send Shielded UTXO
                    {:else}
                      Send Broadcast
                    {/if}
                  </button>
                </div>
              {:else}
                <!-- Tab content: Swap -->
                <div class="flex flex-col gap-2 text-left">
                  <div class="grid grid-cols-3 gap-2">
                    <div>
                      <label for="from-token" class="text-[8px] font-bold text-vault-text-dim uppercase tracking-wider block mb-0.5">From</label>
                      <select id="from-token" bind:value={fromToken} class="input bg-vault-black text-[10px] h-8 rounded-xl border border-vault-border/20 focus:border-vault-accent cursor-pointer">
                        <option>USDC</option>
                        <option>SOL</option>
                        <option>ETH</option>
                      </select>
                    </div>
                    <div>
                      <label for="to-token" class="text-[8px] font-bold text-vault-text-dim uppercase tracking-wider block mb-0.5">To</label>
                      <select id="to-token" bind:value={toToken} class="input bg-vault-black text-[10px] h-8 rounded-xl border border-vault-border/20 focus:border-vault-accent cursor-pointer">
                        <option>SOL</option>
                        <option>USDC</option>
                        <option>ETH</option>
                      </select>
                    </div>
                    <div>
                      <label for="swap-amount" class="text-[8px] font-bold text-vault-text-dim uppercase tracking-wider block mb-0.5">Amount</label>
                      <input id="swap-amount" type="number" bind:value={swapAmount} class="input bg-vault-black text-[10px] h-8 rounded-xl border border-vault-border/20 focus:border-vault-accent"/>
                    </div>
                  </div>
                  <button 
                    on:click={simulateWalletAction}
                    disabled={walletStatus !== 'idle'}
                    class="w-full py-2 text-[10px] font-bold bg-vault-text text-vault-black hover:bg-vault-text-secondary rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1 focus:outline-none btn-glow"
                  >
                    🔄 Execute Bridge Swap
                  </button>
                </div>
              {/if}
            </div>
          </div>
        {/if}

      </div>

      <!-- Right Column: Unified Protocol Inspector (7 cols) -->
      <div class="lg:col-span-7 glass border border-vault-border/20 rounded-2xl p-5 flex flex-col justify-between shadow-lg min-h-[420px] text-left">
        <div>
          <!-- Title & Controls -->
          <div class="flex items-center justify-between border-b border-vault-border/20 pb-3 mb-4 text-left">
            <h3 class="text-xs font-bold text-vault-text tracking-wider uppercase flex items-center gap-1.5 font-mono">
              <span>⚡</span> {simTab === 'chat' ? 'Double Ratchet state' : 'Node RPC & zk-SNARK Prover'}
            </h3>
            {#if simTab === 'wallet'}
              <button 
                on:click={resetWalletDemo}
                class="text-[8px] font-mono text-vault-text-secondary border border-vault-border/50 bg-vault-surface/40 px-2 py-0.5 rounded cursor-pointer hover:bg-vault-elevated focus:outline-none"
              >
                Reset balances
              </button>
            {:else}
              <span class="text-[9px] font-mono text-vault-text-dim">Epoch: {dhStepCount}</span>
            {/if}
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
                  </defs>

                  <!-- Node 1: DH Secret -->
                  <g transform="translate(60, 60)">
                    <circle cx="0" cy="0" r="22" class="transition-all duration-300 {activeRatchetStep === 'dh' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2 animate-pulse' : 'fill-vault-surface stroke-vault-border/50'}" />
                    <text x="0" y="3" class="text-[9px] font-mono font-bold {activeRatchetStep === 'dh' ? 'fill-vault-accent' : 'fill-vault-text'}" text-anchor="middle">DH Sec</text>
                  </g>

                  <!-- Connection DH -> KDF -->
                  <line x1="82" y1="60" x2="155" y2="60" class="transition-all duration-300 stroke-[1.25px]" stroke={activeRatchetStep === 'dh' || activeRatchetStep === 'kdf' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} marker-end={activeRatchetStep === 'kdf' || activeRatchetStep === 'encrypt' ? 'url(#arrow-active)' : 'url(#arrow)'} />

                  <!-- Node 2: KDF Node -->
                  <g transform="translate(190, 60)">
                    <circle cx="0" cy="0" r="24" class="transition-all duration-300 {activeRatchetStep === 'kdf' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2 animate-pulse' : 'fill-vault-surface stroke-vault-border/50'}" />
                    <text x="0" y="3" class="text-[10px] font-mono font-bold {activeRatchetStep === 'kdf' ? 'fill-vault-accent' : 'fill-vault-text'}" text-anchor="middle">KDF</text>
                  </g>

                  <!-- Connection KDF -> Chain Key (UP) -->
                  <line x1="190" y1="36" x2="190" y2="20" class="transition-all duration-300 stroke-[1.25px]" stroke={activeRatchetStep === 'kdf' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} />
                  <g transform="translate(190, 16)">
                    <circle cx="0" cy="0" r="5" class="transition-all duration-300 {activeRatchetStep === 'kdf' ? 'fill-vault-accent' : 'fill-vault-text-dim'}" />
                    <text x="10" y="3" class="text-[8px] font-mono {activeRatchetStep === 'kdf' ? 'fill-vault-accent font-bold' : 'fill-vault-text-dim'}">Chain Key</text>
                  </g>

                  <!-- Connection KDF -> Message Key -->
                  <line x1="214" y1="60" x2="280" y2="60" class="transition-all duration-300 stroke-[1.25px]" stroke={activeRatchetStep === 'kdf' || activeRatchetStep === 'encrypt' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} marker-end={activeRatchetStep === 'encrypt' ? 'url(#arrow-active)' : 'url(#arrow)'} />

                  <!-- Node 4: Message Key -->
                  <g transform="translate(315, 60)">
                    <circle cx="0" cy="0" r="22" class="transition-all duration-300 {activeRatchetStep === 'encrypt' ? 'fill-vault-accent/15 stroke-vault-accent stroke-2 animate-pulse' : 'fill-vault-surface stroke-vault-border/50'}" />
                    <text x="0" y="3" class="text-[9px] font-mono font-bold {activeRatchetStep === 'encrypt' ? 'fill-vault-accent' : 'fill-vault-text'}" text-anchor="middle">Msg Key</text>
                  </g>

                  <!-- Connection Message Key -> Cipher -->
                  <line x1="337" y1="60" x2="375" y2="60" class="transition-all duration-300 stroke-[1.25px]" stroke-dasharray="3 3" stroke={activeRatchetStep === 'encrypt' || activeRatchetStep === 'decrypt' ? 'var(--color-vault-accent)' : 'var(--color-vault-border)'} />
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
            <!-- 💳 WALLET PROTOCOL METRICS & zk-SNARK PROVER STACK -->
            <div class="text-[11px] text-vault-text-secondary leading-relaxed mb-4 flex flex-col gap-3">
              <p class="leading-relaxed text-[10px]">
                Vault computes zero-knowledge proofs client-side when **Shielded UTXO** transfers are enabled. This verifies ledger state transitions without exposing public keys or token amounts.
              </p>

              <!-- zk-SNARK Prover Execution Stack -->
              <div class="p-3 bg-vault-surface/20 border border-vault-border/10 rounded-xl flex flex-col gap-2.5 font-mono select-none">
                <div class="text-[9px] font-bold text-vault-text border-b border-vault-border/10 pb-1.5 flex items-center justify-between">
                  <span>zk-SNARK Prover Stack (groth16)</span>
                  <span class="text-[8px] px-1.5 py-0.5 rounded font-normal {isShieldedRails ? 'bg-vault-accent/15 text-vault-accent' : 'bg-vault-surface border border-vault-border text-vault-text-dim'}">
                    {isShieldedRails ? '🛡️ Shielded ZK Mode' : 'Transparent Broadcast Mode'}
                  </span>
                </div>

                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-[8.5px] font-bold">
                  <!-- Step 1: Inputs -->
                  <div class="p-2 rounded-lg border flex flex-col gap-1 transition-all duration-300
                    {walletStatus === 'signing' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 
                     walletStatus !== 'idle' ? 'bg-vault-accent/5 border-vault-accent/20 text-vault-accent/70' : 
                     'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}"
                  >
                    <div>1. SECRETS</div>
                    <div class="text-[7.5px] font-normal leading-tight opacity-75">
                      {walletStatus === 'signing' ? '🔍 Scanning UTXOs...' : 'UTXO Witnesses'}
                    </div>
                  </div>

                  <!-- Step 2: Constraints -->
                  <div class="p-2 rounded-lg border flex flex-col gap-1 transition-all duration-300
                    {walletStatus === 'proving' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 
                     (walletStatus === 'broadcasting' || walletStatus === 'success') ? 'bg-vault-accent/5 border-vault-accent/20 text-vault-accent/70' : 
                     'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}"
                  >
                    <div>2. CIRCUIT</div>
                    <div class="text-[7.5px] font-normal leading-tight opacity-75">
                      {walletStatus === 'proving' ? '⚙️ Proving constraints...' : 'R1CS Constraints'}
                    </div>
                  </div>

                  <!-- Step 3: Proof Generation -->
                  <div class="p-2 rounded-lg border flex flex-col gap-1 transition-all duration-300
                    {walletStatus === 'broadcasting' ? 'bg-vault-accent/10 border-vault-accent/30 text-vault-accent animate-pulse' : 
                     walletStatus === 'success' ? 'bg-vault-accent/5 border-vault-accent/20 text-vault-accent/70' : 
                     'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}"
                  >
                    <div>3. PROOF</div>
                    <div class="text-[7.5px] font-normal leading-tight opacity-75">
                      {walletStatus === 'broadcasting' ? '⚡ Broadcast proof...' : 'pi_A, pi_B, pi_C'}
                    </div>
                  </div>

                  <!-- Step 4: Verification -->
                  <div class="p-2 rounded-lg border flex flex-col gap-1 transition-all duration-300
                    {walletStatus === 'success' ? 'bg-vault-accent/15 border-vault-accent text-vault-accent' : 
                     'bg-vault-surface/30 border-vault-border/20 text-vault-text-dim'}"
                  >
                    <div>4. VERIFY</div>
                    <div class="text-[7.5px] font-normal leading-tight opacity-75">
                      {walletStatus === 'success' ? '✅ zk-Proof VALID' : 'Verifier Contract'}
                    </div>
                  </div>
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
              {#each walletLogs as log}
                <div class="flex items-start gap-1">
                  <span class="text-vault-accent/70">▶</span>
                  <span class="break-all">{log}</span>
                </div>
              {/each}
              {#if walletStatus === 'routing'}
                <div class="text-vault-accent/80 animate-pulse font-bold mt-0.5">● Querying liquidity routing...</div>
              {:else if walletStatus === 'signing'}
                <div class="text-vault-accent/80 animate-pulse font-bold mt-0.5">● Awaiting credential verification...</div>
              {:else if walletStatus === 'broadcasting'}
                <div class="text-vault-accent/80 animate-pulse font-bold mt-0.5">● Transferring payload to nodes...</div>
              {/if}
            {/if}
          </div>
        </div>

        <!-- Tx hash status (Only shown on Wallet tab) -->
        {#if simTab === 'wallet' && txHash}
          <div class="mt-3.5 p-2.5 bg-vault-accent/5 border border-vault-accent/20 text-vault-accent rounded-xl flex items-center justify-between text-[10px] font-mono animate-fade-in">
            <span class="truncate">Mined: {txHash}</span>
            <span class="text-[8px] bg-vault-accent/20 text-vault-accent px-1 py-0.5 rounded font-bold uppercase tracking-wider">Mined</span>
          </div>
        {/if}

      </div>
    </div>
  </section>

  <!-- Cryptographic Details Grid (Progressive Disclosure) -->
  <section class="w-full max-w-5xl mx-auto px-6 py-12 z-10 border-t border-vault-border/20">
    <div class="text-center mb-8">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Protocol Suite</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Hover or tap on any capability card to inspect its cryptographic implementation details.</p>
    </div>
    
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each features as feature, idx}
        <button
          type="button"
          on:click={() => toggleFeature(idx)}
          class="group flex flex-col gap-2 p-5 bg-vault-surface/20 border border-vault-border/15 rounded-2xl hover:border-vault-accent/20 transition-all hover:bg-vault-surface/40 hover:-translate-y-0.5 duration-200 shadow-sm glass relative overflow-hidden cursor-pointer text-left w-full block"
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

  <!-- Collapsible FAQ Accordion Section -->
  <section class="w-full max-w-3xl mx-auto px-6 py-12 z-10 border-t border-vault-border/20">
    <div class="text-center mb-8">
      <h2 class="text-lg font-bold tracking-tight text-vault-text">Frequently Asked Questions</h2>
      <p class="text-[10px] text-vault-text-dim mt-0.5">Deep-dive technical details about Vault's security model.</p>
    </div>

    <div class="flex flex-col gap-3">
      {#each faqs as faq, index}
        <div class="glass-strong border border-vault-border/20 rounded-2xl overflow-hidden shadow-sm transition-all duration-200">
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
      
      <!-- Support Us Section -->
      <div class="flex flex-col items-center gap-2 p-4 bg-vault-elevated/80 border border-vault-border/10 rounded-2xl max-w-sm w-full text-center animate-fade-in glass">
        <div class="flex items-center gap-1.5 text-[10px] font-bold text-vault-text-secondary font-mono">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          DONATION RAILS
        </div>
        <p class="text-[9px] text-vault-text-dim leading-relaxed font-medium">Help support our seed node hosting. Copied address is BNB chain compatible:</p>
        <div class="flex items-center gap-2 w-full p-1.5 bg-vault-surface/60 border border-vault-border/20 rounded-xl mt-0.5">
          <span class="text-[9px] font-mono text-vault-text truncate flex-1 select-all">0x4ba2d083adab41b1f78e8118a85b12cde5adfa0b</span>
          <button
            on:click={() => {
              navigator.clipboard.writeText('0x4ba2d083adab41b1f78e8118a85b12cde5adfa0b');
              alert('BNB Address copied to clipboard!');
            }}
            class="text-[9px] text-vault-text hover:text-vault-accent transition-colors font-bold whitespace-nowrap focus:outline-none cursor-pointer bg-transparent border-none"
          >
            Copy
          </button>
        </div>
      </div>

      <div class="w-full flex flex-col sm:flex-row justify-between items-center gap-4 text-[9px] text-vault-text-dim uppercase tracking-wider font-semibold border-t border-vault-border/10 pt-4">
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

  /* Radar sweep rotating line */
  :global(.animate-radar-sweep) {
    animation: radarRotate 4s linear infinite;
  }
  @keyframes radarRotate {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
</style>
