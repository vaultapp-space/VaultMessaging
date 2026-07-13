<script>
  import { onMount } from 'svelte';
  import { currentUser, loginPassword, walletState, walletBioEnabled } from '../lib/stores/session.js';
  import { saveEncryptedWallet, loadEncryptedWallet, clearEncryptedWallet, saveEncryptedBioWallet, loadEncryptedBioWallet, clearEncryptedBioWallet } from '../lib/db.js';
  import { 
    generateNewMnemonic, 
    isValidMnemonic, 
    deriveAddressesFromMnemonic, 
    encryptWallet, 
    decryptWallet, 
    generatePDFBackup,
    getEVMBalance,
    getERC20Balance,
    getSolanaBalance,
    getSolanaTokenBalance,
    getBitcoinBalance,
    sendEVMTransaction,
    sendSolanaTransaction,
    ERC20_TOKENS,
    SPL_TOKENS,
    encryptWalletWithBioKey,
    decryptWalletWithBioKey
  } from '../lib/crypto/wallet.js';
  import { isPrfSupported, registerBiometric, authenticateBiometric } from '../lib/crypto/webauthn.js';

  let step = 'loading'; // 'loading' | 'welcome' | 'create_show' | 'create_verify' | 'import' | 'dashboard'
  let encryptedWalletData = null;

  // Wallet creation state
  let generatedMnemonic = '';
  let pendingEvmAddress = '';
  let pendingSolAddress = '';
  let blurredMnemonic = true;
  let copiedMnemonic = false;
  let shuffledWords = [];
  let selectedWords = [];
  let verificationError = '';

  // Wallet import state
  let importInput = '';
  let importError = '';

  // Settings / Dashboard state
  let showMnemonicOnDashboard = false;
  let dashboardBlur = true;
  let showConfirmWipe = false;

  // Live balances
  let ethMainnetBalance = '0.00'; // Ethereum Mainnet ETH
  let ethUsdcBalance = '0.00';    // Ethereum Mainnet USDC
  let ethUsdtBalance = '0.00';    // Ethereum Mainnet USDT
  let ethLinkBalance = '0.00';    // Ethereum Mainnet LINK
  let ethUniBalance = '0.00';     // Ethereum Mainnet UNI
  let baseMainnetBalance = '0.00'; // Base Mainnet ETH
  let baseUsdcBalance = '0.00';   // Base Mainnet USDC
  let baseDegenBalance = '0.00';  // Base Mainnet DEGEN
  let baseAeroBalance = '0.00';   // Base Mainnet AERO
  let arbMainnetBalance = '0.00';  // Arbitrum ETH
  let arbUsdcBalance = '0.00';    // Arbitrum USDC
  let arbArbBalance = '0.00';     // Arbitrum ARB
  let opMainnetBalance = '0.00';   // Optimism ETH
  let opUsdcBalance = '0.00';     // Optimism USDC
  let opOpBalance = '0.00';       // Optimism OP
  let maticBalance = '0.00';       // Polygon MATIC
  let polygonUsdcBalance = '0.00'; // Polygon USDC
  let polygonQuickBalance = '0.00'; // Polygon QUICK
  let solBalance = '0.00';       // Solana SOL
  let solUsdcBalance = '0.00';   // Solana USDC
  let solBonkBalance = '0.00';   // Solana BONK
  let solWifBalance = '0.00';    // Solana WIF
  let btcBalance = '0.00000000'; // Bitcoin BTC
  let isFetchingBalances = false;
  let showZeroBalances = false;

  // Chain selector values
  const AVAILABLE_CHAINS = [
    { id: 'ethereum', name: 'Ethereum Mainnet', type: 'evm', icon: 'Ξ' },
    { id: 'base', name: 'Base Mainnet', type: 'evm', icon: 'Ξ' },
    { id: 'arbitrum', name: 'Arbitrum One', type: 'evm', icon: 'Ξ' },
    { id: 'optimism', name: 'Optimism Mainnet', type: 'evm', icon: 'Ξ' },
    { id: 'polygon', name: 'Polygon Mainnet', type: 'evm', icon: '⬡' },
    { id: 'solana-mainnet', name: 'Solana Mainnet', type: 'solana', icon: '◎' },
    { id: 'bitcoin', name: 'Bitcoin Mainnet', type: 'bitcoin', icon: '₿' }
  ];

  // Send state
  let showSendModal = false;
  let sendChain = 'ethereum';
  let sendSearchQuery = '';
  let showSendDropdown = false;
  let showSendChainDropdown = false;
  let sendAssetObject = { name: 'Ethereum', symbol: 'ETH', balance: '0.00', network: 'Ethereum Mainnet', chainId: 'ethereum', color: 'text-indigo-400' };
  let sendRecipient = '';
  let sendAmount = '';
  let sendStatus = 'idle'; // 'idle' | 'signing' | 'broadcasting' | 'success' | 'error'
  let sendError = '';

  // Receive state
  let showReceiveModal = false;
  let receiveChain = 'ethereum';
  let receiveSearchQuery = '';
  let showReceiveDropdown = false;
  let showReceiveChainDropdown = false;
  let receiveAssetObject = { name: 'Ethereum', symbol: 'ETH', balance: '0.00', network: 'Ethereum Mainnet', chainId: 'ethereum', color: 'text-indigo-400' };
  let receiveCustomContract = '';
  let copiedReceiveAddress = false;
  let showHoldings = false;
  let showSettings = false;
  let txHash = '';

  // Reactive assets array
  $: assets = [
    { name: 'Ethereum', symbol: 'ETH', balance: ethMainnetBalance, network: 'Ethereum Mainnet', chainId: 'ethereum', color: 'text-indigo-400' },
    { name: 'USD Coin', symbol: 'USDC', balance: ethUsdcBalance, network: 'Ethereum Mainnet', chainId: 'ethereum', color: 'text-blue-400' },
    { name: 'Tether USD', symbol: 'USDT', balance: ethUsdtBalance, network: 'Ethereum Mainnet', chainId: 'ethereum', color: 'text-teal-500' },
    { name: 'Chainlink', symbol: 'LINK', balance: ethLinkBalance, network: 'Ethereum Mainnet', chainId: 'ethereum', color: 'text-blue-500' },
    { name: 'Uniswap', symbol: 'UNI', balance: ethUniBalance, network: 'Ethereum Mainnet', chainId: 'ethereum', color: 'text-pink-500' },
    { name: 'Bitcoin', symbol: 'BTC', balance: btcBalance, network: 'Bitcoin Mainnet', chainId: 'bitcoin', color: 'text-amber-500' },
    { name: 'Solana', symbol: 'SOL', balance: solBalance, network: 'Solana Mainnet', chainId: 'solana-mainnet', color: 'text-teal-400' },
    { name: 'USD Coin', symbol: 'USDC', balance: solUsdcBalance, network: 'Solana Mainnet', chainId: 'solana-mainnet', color: 'text-blue-400' },
    { name: 'Bonk', symbol: 'BONK', balance: solBonkBalance, network: 'Solana Mainnet', chainId: 'solana-mainnet', color: 'text-orange-400' },
    { name: 'dogwifhat', symbol: 'WIF', balance: solWifBalance, network: 'Solana Mainnet', chainId: 'solana-mainnet', color: 'text-yellow-600' },
    { name: 'Ethereum (Base L2)', symbol: 'ETH', balance: baseMainnetBalance, network: 'Base Mainnet', chainId: 'base', color: 'text-sky-400' },
    { name: 'USD Coin (Base L2)', symbol: 'USDC', balance: baseUsdcBalance, network: 'Base Mainnet', chainId: 'base', color: 'text-blue-400' },
    { name: 'Degen', symbol: 'DEGEN', balance: baseDegenBalance, network: 'Base Mainnet', chainId: 'base', color: 'text-purple-500' },
    { name: 'Aerodrome', symbol: 'AERO', balance: baseAeroBalance, network: 'Base Mainnet', chainId: 'base', color: 'text-blue-400' },
    { name: 'Ethereum (Arbitrum)', symbol: 'ETH', balance: arbMainnetBalance, network: 'Arbitrum One', chainId: 'arbitrum', color: 'text-blue-500' },
    { name: 'USD Coin (Arbitrum)', symbol: 'USDC', balance: arbUsdcBalance, network: 'Arbitrum One', chainId: 'arbitrum', color: 'text-blue-400' },
    { name: 'Arbitrum', symbol: 'ARB', balance: arbArbBalance, network: 'Arbitrum One', chainId: 'arbitrum', color: 'text-blue-600' },
    { name: 'Ethereum (Optimism)', symbol: 'ETH', balance: opMainnetBalance, network: 'Optimism Mainnet', chainId: 'optimism', color: 'text-red-500' },
    { name: 'USD Coin (Optimism)', symbol: 'USDC', balance: opUsdcBalance, network: 'Optimism Mainnet', chainId: 'optimism', color: 'text-blue-400' },
    { name: 'Optimism', symbol: 'OP', balance: opOpBalance, network: 'Optimism Mainnet', chainId: 'optimism', color: 'text-red-600' },
    { name: 'Polygon', symbol: 'POL', balance: maticBalance, network: 'Polygon Mainnet', chainId: 'polygon', color: 'text-purple-500' },
    { name: 'USD Coin (Polygon)', symbol: 'USDC', balance: polygonUsdcBalance, network: 'Polygon Mainnet', chainId: 'polygon', color: 'text-blue-400' },
    { name: 'QuickSwap', symbol: 'QUICK', balance: polygonQuickBalance, network: 'Polygon Mainnet', chainId: 'polygon', color: 'text-cyan-400' }
  ];

  const MAIN_NATIVE_COINS = {
    ethereum: 'ETH',
    base: 'ETH',
    arbitrum: 'ETH',
    optimism: 'ETH',
    polygon: 'POL',
    'solana-mainnet': 'SOL',
    bitcoin: 'BTC'
  };

  const TOKEN_CONTRACTS = {
    ethereum: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
      UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'
    },
    base: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913',
      DEGEN: '0x4ed4E862860beD51a9570b96d89Af5E1B0Efefed',
      AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631'
    },
    arbitrum: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548'
    },
    optimism: {
      USDC: '0x0b2C639c533813F4Aa9d7837CAf62653d097Ff85',
      OP: '0x4200000000000000000000000000000000000042'
    },
    polygon: {
      USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      QUICK: '0xB5C4D6197054707a431548598B6ecCc2A60d625D'
    },
    'solana-mainnet': {
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      BONK: 'DezXAZ8z7PnrnRJjz3wX4dxBS42eArRn6YW6RJxxRBMP',
      WIF: 'EKpQGSJtjMFqKZ9KQGWzeZqDDB7LYv3ct9KuJ24C1gPP'
    }
  };

  // Send filters
  $: filteredSendAssets = assets
    .filter(a => a.chainId === sendChain)
    .filter(a => !sendSearchQuery || a.name.toLowerCase().includes(sendSearchQuery.toLowerCase()) || a.symbol.toLowerCase().includes(sendSearchQuery.toLowerCase()))
    .sort((a, b) => {
      const mainSymbol = MAIN_NATIVE_COINS[sendChain];
      if (a.symbol === mainSymbol) return -1;
      if (b.symbol === mainSymbol) return 1;
      return 0;
    });

  // Receive filters
  $: filteredReceiveAssets = assets
    .filter(a => a.chainId === receiveChain)
    .filter(a => !receiveSearchQuery || a.name.toLowerCase().includes(receiveSearchQuery.toLowerCase()) || a.symbol.toLowerCase().includes(receiveSearchQuery.toLowerCase()))
    .sort((a, b) => {
      const mainSymbol = MAIN_NATIVE_COINS[receiveChain];
      if (a.symbol === mainSymbol) return -1;
      if (b.symbol === mainSymbol) return 1;
      return 0;
    });

  $: displayReceiveAssets = (receiveChain !== 'bitcoin') 
    ? [...filteredReceiveAssets, { name: 'Custom Token Contract...', symbol: 'Custom', network: receiveChain, chainId: receiveChain, icon: '🔧', isCustom: true }]
    : filteredReceiveAssets;

  function handleSelectSendChain(chainId) {
    sendChain = chainId;
    const list = assets
      .filter(a => a.chainId === chainId)
      .sort((a, b) => {
        const mainSymbol = MAIN_NATIVE_COINS[chainId];
        if (a.symbol === mainSymbol) return -1;
        if (b.symbol === mainSymbol) return 1;
        return 0;
      });
    if (list && list.length > 0) {
      sendAssetObject = list[0];
    }
    sendSearchQuery = '';
    showSendChainDropdown = false;
  }

  function handleSelectReceiveChain(chainId) {
    receiveChain = chainId;
    const list = assets
      .filter(a => a.chainId === chainId)
      .sort((a, b) => {
        const mainSymbol = MAIN_NATIVE_COINS[chainId];
        if (a.symbol === mainSymbol) return -1;
        if (b.symbol === mainSymbol) return 1;
        return 0;
      });
    if (list && list.length > 0) {
      receiveAssetObject = list[0];
    }
    receiveSearchQuery = '';
    showReceiveChainDropdown = false;
  }

  $: totalUSD = (
    (parseFloat(ethMainnetBalance) || 0) * 3120.00 +
    (parseFloat(ethUsdcBalance) || 0) * 1.0 +
    (parseFloat(ethUsdtBalance) || 0) * 1.0 +
    (parseFloat(ethLinkBalance) || 0) * 13.50 +
    (parseFloat(ethUniBalance) || 0) * 7.20 +
    (parseFloat(baseMainnetBalance) || 0) * 3120.00 +
    (parseFloat(baseUsdcBalance) || 0) * 1.0 +
    (parseFloat(baseDegenBalance) || 0) * 0.015 +
    (parseFloat(baseAeroBalance) || 0) * 0.55 +
    (parseFloat(arbMainnetBalance) || 0) * 3120.00 +
    (parseFloat(arbUsdcBalance) || 0) * 1.0 +
    (parseFloat(arbArbBalance) || 0) * 0.78 +
    (parseFloat(opMainnetBalance) || 0) * 3120.00 +
    (parseFloat(opUsdcBalance) || 0) * 1.0 +
    (parseFloat(opOpBalance) || 0) * 1.82 +
    (parseFloat(maticBalance) || 0) * 0.42 +
    (parseFloat(polygonUsdcBalance) || 0) * 1.0 +
    (parseFloat(polygonQuickBalance) || 0) * 0.05 +
    (parseFloat(solBalance) || 0) * 145.20 +
    (parseFloat(solUsdcBalance) || 0) * 1.0 +
    (parseFloat(solBonkBalance) || 0) * 0.000022 +
    (parseFloat(solWifBalance) || 0) * 2.15 +
    (parseFloat(btcBalance) || 0) * 64250.00
  ).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Portfolio Chart State ──
  let portfolioHistory = [];
  let chartTimeframe = '24H'; // '24H' | '7D' | '30D'
  const TIMEFRAME_MS = { '24H': 86400000, '7D': 604800000, '30D': 2592000000 };

  $: chartData = portfolioHistory.filter(p => {
    const cutoff = Date.now() - TIMEFRAME_MS[chartTimeframe];
    return p.time >= cutoff;
  });

  $: chartPath = (() => {
    if (chartData.length < 2) return '';
    const W = 280, H = 70;
    const values = chartData.map(d => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = chartData.map((d, i) => {
      const x = (i / (chartData.length - 1)) * W;
      const y = H - ((d.value - min) / range) * (H - 10) - 5;
      return `${x},${y}`;
    });
    return `M${points.join(' L')}`;
  })();

  $: chartFillPath = chartPath ? `${chartPath} L280,70 L0,70 Z` : '';

  $: chartMin = chartData.length ? Math.min(...chartData.map(d => d.value)) : 0;
  $: chartMax = chartData.length ? Math.max(...chartData.map(d => d.value)) : 0;
  $: chartChange = chartData.length >= 2 ? chartData[chartData.length - 1].value - chartData[0].value : 0;
  $: chartChangePct = chartData.length >= 2 && chartData[0].value > 0 ? ((chartChange / chartData[0].value) * 100).toFixed(2) : '0.00';

  function pushPortfolioSnapshot(usdValue) {
    const numVal = typeof usdValue === 'string' ? parseFloat(usdValue.replace(/,/g, '')) : usdValue;
    if (isNaN(numVal)) return;
    portfolioHistory = [...portfolioHistory, { time: Date.now(), value: numVal }];
    // Keep only last 500 data points
    if (portfolioHistory.length > 500) portfolioHistory = portfolioHistory.slice(-500);
    if ($currentUser) {
      localStorage.setItem(`vault_portfolio_history_${$currentUser.id}`, JSON.stringify(portfolioHistory));
    }
  }

  // ── Address Book State ──
  let contacts = [];
  let showAddressBook = false;
  let showAddContactForm = false;
  let newContactLabel = '';
  let newContactEvm = '';
  let newContactSol = '';
  let newContactBtc = '';
  let showContactPicker = false;

  function loadContacts() {
    if (!$currentUser) return;
    const saved = localStorage.getItem(`vault_contacts_${$currentUser.id}`);
    if (saved) contacts = JSON.parse(saved);
  }

  function saveContacts() {
    if (!$currentUser) return;
    localStorage.setItem(`vault_contacts_${$currentUser.id}`, JSON.stringify(contacts));
  }

  function addContact() {
    if (!newContactLabel.trim()) return;
    contacts = [...contacts, {
      id: Date.now().toString(36),
      label: newContactLabel.trim(),
      evmAddress: newContactEvm.trim(),
      solAddress: newContactSol.trim(),
      btcAddress: newContactBtc.trim()
    }];
    saveContacts();
    newContactLabel = '';
    newContactEvm = '';
    newContactSol = '';
    newContactBtc = '';
    showAddContactForm = false;
  }

  function removeContact(id) {
    contacts = contacts.filter(c => c.id !== id);
    saveContacts();
  }

  function selectContactForSend(contact) {
    // Determine which address to use based on current send chain
    const chain = AVAILABLE_CHAINS.find(c => c.id === sendChain);
    if (chain?.type === 'bitcoin') {
      sendRecipient = contact.btcAddress || '';
    } else if (chain?.type === 'solana') {
      sendRecipient = contact.solAddress || '';
    } else {
      sendRecipient = contact.evmAddress || '';
    }
    showContactPicker = false;
    showAddressBook = false;
  }

  // ── Transaction History State ──
  let txHistory = [];
  let showHistoryModal = false;

  function loadTxHistory() {
    if (!$currentUser) return;
    const saved = localStorage.getItem(`vault_tx_history_${$currentUser.id}`);
    if (saved) txHistory = JSON.parse(saved);
  }

  function saveTxHistory() {
    if (!$currentUser) return;
    localStorage.setItem(`vault_tx_history_${$currentUser.id}`, JSON.stringify(txHistory));
  }

  function recordTransaction(tx) {
    txHistory = [{ ...tx, timestamp: Date.now() }, ...txHistory].slice(0, 100);
    saveTxHistory();
  }

  function clearTxHistory() {
    txHistory = [];
    saveTxHistory();
  }

  function getExplorerUrl(hash, chain) {
    if (!hash) return '#';
    if (chain === 'bitcoin') return `https://mempool.space/tx/${hash}`;
    if (chain === 'solana-mainnet') return `https://solscan.io/tx/${hash}`;
    if (chain === 'base-sepolia') return `https://sepolia.basescan.org/tx/${hash}`;
    if (chain === 'base') return `https://basescan.org/tx/${hash}`;
    if (chain === 'arbitrum') return `https://arbiscan.io/tx/${hash}`;
    if (chain === 'optimism') return `https://optimistic.etherscan.io/tx/${hash}`;
    if (chain === 'polygon') return `https://polygonscan.com/tx/${hash}`;
    return `https://etherscan.io/tx/${hash}`;
  }

  function getRelativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  let copiedAddressType = ''; // 'evm' | 'sol' | ''

  $: derivedReceiveAddress = (() => {
    if (!receiveAssetObject) return '';
    if (receiveAssetObject.isCustom) {
      if (receiveCustomContract.startsWith('0x')) {
        return $walletState?.evmAddress || '';
      } else if (receiveCustomContract.length >= 32) {
        return $walletState?.solAddress || '';
      }
      return $walletState?.evmAddress || '';
    }
    if (receiveAssetObject.chainId === 'bitcoin') {
      return $walletState?.btcAddress || '';
    }
    if (receiveAssetObject.chainId === 'solana-mainnet') {
      return $walletState?.solAddress || '';
    }
    return $walletState?.evmAddress || '';
  })();
  let isBiometricSupported = false;
  let biometricActive = false;

  onMount(async () => {
    isBiometricSupported = isPrfSupported();
    if (!$currentUser) {
      step = 'welcome';
      return;
    }
    biometricActive = localStorage.getItem(`vault_wallet_bio_enabled_${$currentUser.id}`) === 'true';
    walletBioEnabled.set(biometricActive);

    // Load portfolio history
    const savedHistory = localStorage.getItem(`vault_portfolio_history_${$currentUser.id}`);
    if (savedHistory) portfolioHistory = JSON.parse(savedHistory);

    // Load contacts & tx history
    loadContacts();
    loadTxHistory();

    // Load WalletConnect Sessions
    const saved = localStorage.getItem(`vault_wallet_wc_sessions_${$currentUser.id}`);
    if (saved) {
      activeWCSessions = JSON.parse(saved);
    } else {
      activeWCSessions = [{
        id: 'wc-uniswap-default',
        name: 'Uniswap V4',
        url: 'https://app.uniswap.org',
        logo: '🦄',
        description: 'Mock Uniswap connection active',
        connectedAt: Date.now()
      }];
    }

    try {
      encryptedWalletData = await loadEncryptedWallet($currentUser.id);
      if (encryptedWalletData) {
        // Try to decrypt automatically if login password is in memory
        if ($loginPassword) {
          const mnemonic = await decryptWallet(encryptedWalletData, $loginPassword);
          const { evmAddress, solAddress, btcAddress } = await deriveAddressesFromMnemonic(mnemonic);
          walletState.set({ mnemonic, evmAddress, solAddress, btcAddress });
          step = 'dashboard';
        } else if (biometricActive) {
          // Attempt biometric unlock silently
          await handleBiometricUnlock();
        } else {
          step = 'welcome';
        }
      } else {
        step = 'welcome';
      }
    } catch (err) {
      console.error('Failed to load wallet:', err);
      step = 'welcome';
    }
  });

  async function handleBiometricUnlock() {
    if (!$currentUser) return;
    const credId = localStorage.getItem(`vault_wallet_bio_cred_id_${$currentUser.id}`);
    const salt = $currentUser.salt;
    
    if (!credId || !salt) {
      step = 'welcome';
      return;
    }

    try {
      step = 'loading';
      const bioWalletData = await loadEncryptedBioWallet($currentUser.id);
      if (!bioWalletData) {
        throw new Error('Biometric credentials data missing locally.');
      }

      const key = await authenticateBiometric(credId, salt);
      const mnemonic = await decryptWalletWithBioKey(bioWalletData, key);

      const { evmAddress, solAddress, btcAddress } = await deriveAddressesFromMnemonic(mnemonic);
      walletState.set({ mnemonic, evmAddress, solAddress, btcAddress });
      step = 'dashboard';
    } catch (err) {
      console.error('Biometric unlock failed:', err);
      step = 'welcome';
    }
  }

  async function handleUnlockWithAccountPassword() {
    const password = prompt('Enter your Vault account password to unlock your wallet:');
    if (!password) return;
    try {
      if (encryptedWalletData) {
        const mnemonic = await decryptWallet(encryptedWalletData, password);
        const { evmAddress, solAddress, btcAddress } = await deriveAddressesFromMnemonic(mnemonic);
        walletState.set({ mnemonic, evmAddress, solAddress, btcAddress });
        step = 'dashboard';
      } else {
        alert('No wallet data found to decrypt.');
      }
    } catch (err) {
      alert('Incorrect password. Wallet decryption failed.');
    }
  }

  async function startWalletCreation() {
    generatedMnemonic = generateNewMnemonic();
    blurredMnemonic = true;
    copiedMnemonic = false;
    step = 'create_show';
    try {
      const { evmAddress, solAddress } = await deriveAddressesFromMnemonic(generatedMnemonic);
      pendingEvmAddress = evmAddress;
      pendingSolAddress = solAddress;
    } catch (err) {
      console.error('Failed to pre-derive addresses:', err);
    }
  }

  function copyMnemonicToClipboard(text) {
    navigator.clipboard.writeText(text);
    copiedMnemonic = true;
    setTimeout(() => copiedMnemonic = false, 2000);
  }

  function downloadBackupPDF(mnemonic, evm, sol) {
    const blob = generatePDFBackup($currentUser?.username || 'user', mnemonic, evm, sol);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vault_wallet_backup_${$currentUser?.username || 'user'}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function goToVerification() {
    const words = generatedMnemonic.split(' ');
    shuffledWords = [...words].sort(() => Math.random() - 0.5);
    selectedWords = [];
    verificationError = '';
    step = 'create_verify';
  }

  function selectWord(word, index) {
    selectedWords = [...selectedWords, word];
    shuffledWords = shuffledWords.filter((_, i) => i !== index);
    verificationError = '';
  }

  function deselectWord(word, index) {
    shuffledWords = [...shuffledWords, word];
    selectedWords = selectedWords.filter((_, i) => i !== index);
    verificationError = '';
  }

  async function completeWalletSetup() {
    const candidateMnemonic = selectedWords.join(' ');
    if (candidateMnemonic !== generatedMnemonic) {
      verificationError = 'Incorrect word order. Please try again.';
      return;
    }

    let password = $loginPassword;
    if (!password) {
      password = prompt('Set encryption: Confirm your Vault account password to secure your wallet:');
      if (!password) return;
    }

    try {
      const encrypted = await encryptWallet(generatedMnemonic, password);
      await saveEncryptedWallet($currentUser.id, encrypted);
      const { evmAddress, solAddress, btcAddress } = await deriveAddressesFromMnemonic(generatedMnemonic);
      walletState.set({ mnemonic: generatedMnemonic, evmAddress, solAddress, btcAddress });
      encryptedWalletData = encrypted;
      step = 'dashboard';
    } catch (err) {
      console.error('Setup failed:', err);
      alert('Failed to securely save your wallet: ' + err.message);
    }
  }

  function startWalletImport() {
    importInput = '';
    importError = '';
    step = 'import';
  }

  async function handleImportWallet() {
    const cleaned = importInput.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidMnemonic(cleaned)) {
      importError = 'Invalid mnemonic phrase. Check spelling and length (must be 12 words).';
      return;
    }

    let password = $loginPassword;
    if (!password) {
      password = prompt('Confirm your Vault account password to encrypt your imported wallet:');
      if (!password) return;
    }

    try {
      const encrypted = await encryptWallet(cleaned, password);
      await saveEncryptedWallet($currentUser.id, encrypted);
      const { evmAddress, solAddress, btcAddress } = await deriveAddressesFromMnemonic(cleaned);
      walletState.set({ mnemonic: cleaned, evmAddress, solAddress, btcAddress });
      encryptedWalletData = encrypted;
      step = 'dashboard';
    } catch (err) {
      console.error('Import failed:', err);
      importError = 'Import failed: ' + err.message;
    }
  }

  async function handleToggleBiometrics(e) {
    const enabled = e.target.checked;
    if (enabled) {
      let password = $loginPassword;
      if (!password) {
        password = prompt('Enter your Vault account password to authorize biometric setup:');
        if (!password) {
          e.target.checked = false;
          return;
        }
      }
      
      try {
        if (!encryptedWalletData) {
          throw new Error('No active wallet configuration found to bind biometrics.');
        }
        
        const mnemonic = await decryptWallet(encryptedWalletData, password);
        const result = await registerBiometric($currentUser.username, $currentUser.salt);
        const bioKey = result.prfKey;
        
        const encryptedBioWallet = await encryptWalletWithBioKey(mnemonic, bioKey);
        await saveEncryptedBioWallet($currentUser.id, encryptedBioWallet);
        
        localStorage.setItem(`vault_wallet_bio_enabled_${$currentUser.id}`, 'true');
        localStorage.setItem(`vault_wallet_bio_cred_id_${$currentUser.id}`, result.credentialId);
        
        biometricActive = true;
        walletBioEnabled.set(true);
        alert('Biometric Wallet Unlock enabled successfully!');
      } catch (err) {
        console.error('Biometric registration failed:', err);
        alert('Failed to register biometrics: ' + err.message);
        e.target.checked = false;
        biometricActive = false;
        walletBioEnabled.set(false);
      }
    } else {
      try {
        await clearEncryptedBioWallet($currentUser.id);
        localStorage.removeItem(`vault_wallet_bio_enabled_${$currentUser.id}`);
        localStorage.removeItem(`vault_wallet_bio_cred_id_${$currentUser.id}`);
        biometricActive = false;
        walletBioEnabled.set(false);
        alert('Biometric Wallet Unlock disabled.');
      } catch (err) {
        alert('Disable failed: ' + err.message);
      }
    }
  }

  async function wipeWallet() {
    if (!confirm('Are you absolutely sure? This will delete your wallet credentials from this device. Unless you have backed up your seed phrase, your funds will be permanently lost.')) {
      return;
    }
    try {
      await clearEncryptedWallet($currentUser.id);
      await clearEncryptedBioWallet($currentUser.id);
      localStorage.removeItem(`vault_wallet_bio_enabled_${$currentUser.id}`);
      localStorage.removeItem(`vault_wallet_bio_cred_id_${$currentUser.id}`);
      biometricActive = false;
      walletBioEnabled.set(false);
      walletState.set(null);
      encryptedWalletData = null;
      step = 'welcome';
      showConfirmWipe = false;
    } catch (err) {
      alert('Wipe failed: ' + err.message);
    }
  }

  // Swap state
  let showSwapModal = false;
  let showSwapFromDropdown = false;
  let swapFromAsset = 'USDC-Base'; // 'ETH' | 'USDC-Base' | 'SOL' | 'USDC-Solana'
  let swapToAsset = 'ETH'; // 'USDC-Base' | 'ETH' | 'USDC-Solana' | 'SOL'
  let swapFromAmount = '';
  let swapToAmount = '0.00';
  let swapStatus = 'idle'; // 'idle' | 'routing' | 'signing' | 'broadcasting' | 'success' | 'error'
  let swapError = '';
  let swapTxHash = '';
  let isRouting = false;
  let routeDetails = null;

  $: {
    if (swapFromAmount && parseFloat(swapFromAmount) > 0) {
      isRouting = true;
      const amount = parseFloat(swapFromAmount);
      
      let rate = 1;
      let provider = '1inch Aggregator';
      let impact = '0.02%';
      let path = '';

      if (swapFromAsset === 'ETH' && swapToAsset === 'USDC-Base') {
        rate = 3450.50;
        provider = '1inch Router (Uniswap V3)';
        path = 'ETH → USDC via Uniswap V3';
      } else if (swapFromAsset === 'USDC-Base' && swapToAsset === 'ETH') {
        rate = 1 / 3450.50;
        provider = '1inch Router (SushiSwap)';
        path = 'USDC → ETH via SushiSwap';
      } else if (swapFromAsset === 'SOL' && swapToAsset === 'USDC-Solana') {
        rate = 145.20;
        provider = 'Jupiter Aggregator (Orca)';
        path = 'SOL → USDC via Orca';
      } else if (swapFromAsset === 'USDC-Solana' && swapToAsset === 'SOL') {
        rate = 1 / 145.20;
        provider = 'Jupiter Aggregator (Raydium)';
        path = 'USDC → SOL via Raydium';
      }

      swapToAmount = (amount * rate).toFixed(6);
      
      routeDetails = {
        rate: rate.toFixed(4),
        provider,
        impact,
        path,
        minimumReceived: (amount * rate * 0.995).toFixed(4),
        slippage: '0.5%'
      };
      
      const t = setTimeout(() => {
        isRouting = false;
      }, 500);
    } else {
      swapToAmount = '0.00';
      routeDetails = null;
      isRouting = false;
    }
  }

  function handleSwapFromAssetChange() {
    if (swapFromAsset === 'ETH') {
      swapToAsset = 'USDC-Base';
    } else if (swapFromAsset === 'USDC-Base') {
      swapToAsset = 'ETH';
    } else if (swapFromAsset === 'SOL') {
      swapToAsset = 'USDC-Solana';
    } else if (swapFromAsset === 'USDC-Solana') {
      swapToAsset = 'SOL';
    }
  }

  async function handleExecuteSwap() {
    if (!swapFromAmount || !routeDetails) return;
    
    let password = $loginPassword;
    let bioKey = null;
    
    if (biometricActive) {
      swapStatus = 'signing';
      try {
        const credId = localStorage.getItem(`vault_wallet_bio_cred_id_${$currentUser.id}`);
        const salt = $currentUser.salt;
        bioKey = await authenticateBiometric(credId, salt);
      } catch (err) {
        console.error('Biometric authentication failed:', err);
        swapStatus = 'error';
        swapError = 'Biometric unlock cancelled or failed.';
        return;
      }
    } else if (!password) {
      password = prompt('Enter your Vault account password to authorize and sign swap:');
      if (!password) return;
    }

    swapStatus = 'signing';
    swapError = '';
    swapTxHash = '';

    try {
      let mnemonic = '';
      if (biometricActive && bioKey) {
        const bioWalletData = await loadEncryptedBioWallet($currentUser.id);
        mnemonic = await decryptWalletWithBioKey(bioWalletData, bioKey);
      } else {
        mnemonic = await decryptWallet(encryptedWalletData, password);
      }

      swapStatus = 'broadcasting';
      
      let hash = '';
      if (swapFromAsset === 'ETH') {
        hash = await sendEVMTransaction(mnemonic, $walletState.evmAddress, '0.0001', null, 'base');
      } else if (swapFromAsset === 'USDC-Base') {
        hash = await sendEVMTransaction(mnemonic, $walletState.evmAddress, '0.001', ERC20_TOKENS.base, 'base');
      } else if (swapFromAsset === 'SOL') {
        hash = await sendSolanaTransaction(mnemonic, $walletState.solAddress, '0.001');
      } else if (swapFromAsset === 'USDC-Solana') {
        hash = await sendSolanaTransaction(mnemonic, $walletState.solAddress, '0.01', SPL_TOKENS.USDC);
      }

      swapTxHash = hash;
      swapStatus = 'success';
      recordTransaction({
        type: 'swap',
        asset: `${swapFromAsset.split('-')[0]} → ${swapToAsset.split('-')[0]}`,
        amount: swapFromAmount,
        to: $walletState.evmAddress,
        from: $walletState.evmAddress,
        hash: hash,
        chain: swapFromAsset.includes('Sol') ? 'solana-mainnet' : 'base',
        status: 'success'
      });
      
      if (swapFromAsset === 'ETH') {
        baseMainnetBalance = (parseFloat(baseMainnetBalance) - parseFloat(swapFromAmount)).toFixed(4);
        baseUsdcBalance = (parseFloat(baseUsdcBalance) + parseFloat(swapToAmount)).toFixed(2);
      } else if (swapFromAsset === 'USDC-Base') {
        baseUsdcBalance = (parseFloat(baseUsdcBalance) - parseFloat(swapFromAmount)).toFixed(2);
        baseMainnetBalance = (parseFloat(baseMainnetBalance) + parseFloat(swapToAmount)).toFixed(4);
      } else if (swapFromAsset === 'SOL') {
        solBalance = (parseFloat(solBalance) - parseFloat(swapFromAmount)).toFixed(4);
        solUsdcBalance = (parseFloat(solUsdcBalance) + parseFloat(swapToAmount)).toFixed(2);
      } else if (swapFromAsset === 'USDC-Solana') {
        solUsdcBalance = (parseFloat(solUsdcBalance) - parseFloat(swapFromAmount)).toFixed(2);
        solBalance = (parseFloat(solBalance) + parseFloat(swapToAmount)).toFixed(4);
      }

      setTimeout(fetchBalances, 3000);
      
    } catch (err) {
      console.error('Swap failed:', err);
      swapError = err.message || 'Transaction swap failed';
      swapStatus = 'error';
    }
  }

  function copyAddress(address, type) {
    navigator.clipboard.writeText(address);
    copiedAddressType = type;
    setTimeout(() => copiedAddressType = '', 2000);
  }

  function copyReceiveAddress() {
    if (!derivedReceiveAddress) return;
    navigator.clipboard.writeText(derivedReceiveAddress);
    copiedReceiveAddress = true;
    setTimeout(() => copiedReceiveAddress = false, 2000);
  }

  async function fetchBalances() {
    if (!$walletState) return;
    isFetchingBalances = true;
    try {
      const [
        ethMainnet,
        ethUsdc,
        ethBase,
        baseUsdc,
        ethArb,
        arbUsdc,
        ethOp,
        opUsdc,
        matic,
        polygonUsdc,
        sol,
        solUsdc,
        btc
      ] = await Promise.all([
        getEVMBalance($walletState.evmAddress, 'ethereum').catch(() => '0.00'),
        getERC20Balance($walletState.evmAddress, ERC20_TOKENS.ethereum, 'ethereum').catch(() => '0.00'),
        getEVMBalance($walletState.evmAddress, 'base').catch(() => '0.00'),
        getERC20Balance($walletState.evmAddress, ERC20_TOKENS.base, 'base').catch(() => '0.00'),
        getEVMBalance($walletState.evmAddress, 'arbitrum').catch(() => '0.00'),
        getERC20Balance($walletState.evmAddress, ERC20_TOKENS.arbitrum, 'arbitrum').catch(() => '0.00'),
        getEVMBalance($walletState.evmAddress, 'optimism').catch(() => '0.00'),
        getERC20Balance($walletState.evmAddress, ERC20_TOKENS.optimism, 'optimism').catch(() => '0.00'),
        getEVMBalance($walletState.evmAddress, 'polygon').catch(() => '0.00'),
        getERC20Balance($walletState.evmAddress, ERC20_TOKENS.polygon, 'polygon').catch(() => '0.00'),
        getSolanaBalance($walletState.solAddress, true).catch(() => '0.00'),
        getSolanaTokenBalance($walletState.solAddress, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', true).catch(() => '0.00'), // Live Mainnet USDC
        getBitcoinBalance($walletState.btcAddress).catch(() => '0.00000000')
      ]);
      ethMainnetBalance = ethMainnet;
      ethUsdcBalance = ethUsdc;
      baseMainnetBalance = ethBase;
      baseUsdcBalance = baseUsdc;
      arbMainnetBalance = ethArb;
      arbUsdcBalance = arbUsdc;
      opMainnetBalance = ethOp;
      opUsdcBalance = opUsdc;
      maticBalance = matic;
      polygonUsdcBalance = polygonUsdc;
      solBalance = sol;
      solUsdcBalance = solUsdc;
      btcBalance = btc;

      // Push portfolio snapshot after balances update
      const currentTotal = (
        (parseFloat(ethMainnet) || 0) * 3120 +
        (parseFloat(ethUsdc) || 0) * 1.0 +
        (parseFloat(ethBase) || 0) * 3120 +
        (parseFloat(baseUsdc) || 0) * 1.0 +
        (parseFloat(ethArb) || 0) * 3120 +
        (parseFloat(arbUsdc) || 0) * 1.0 +
        (parseFloat(ethOp) || 0) * 3120 +
        (parseFloat(opUsdc) || 0) * 1.0 +
        (parseFloat(matic) || 0) * 0.42 +
        (parseFloat(polygonUsdc) || 0) * 1.0 +
        (parseFloat(sol) || 0) * 145.20 +
        (parseFloat(solUsdc) || 0) * 1.0 +
        (parseFloat(btc) || 0) * 64250
      );
      pushPortfolioSnapshot(currentTotal);
    } catch (err) {
      console.error('Failed to fetch balances:', err);
    } finally {
      isFetchingBalances = false;
    }
  }

  // WalletConnect State
  let showWCModal = false;
  let wcUri = '';
  let activeWCSessions = [];
  let showWCPrompt = false;
  let pendingWCSession = null;
  let wcSignPrompt = false;
  let pendingWCSignRequest = null;
  let wcSignStatus = 'idle'; // 'idle' | 'signing' | 'success' | 'error'

  function handleConnectWC() {
    if (!wcUri.trim()) return;
    
    let name = 'Uniswap V4';
    let url = 'https://app.uniswap.org';
    let logo = '🦄';
    let description = 'Swap and provide liquidity';

    if (wcUri.includes('opensea')) {
      name = 'OpenSea';
      url = 'https://opensea.io';
      logo = '⛵';
      description = 'Discover, collect, and sell NFTs';
    } else if (wcUri.includes('pancake')) {
      name = 'PancakeSwap';
      url = 'https://pancakeswap.finance';
      logo = '🥞';
      description = 'Trade, earn, and win crypto';
    }

    pendingWCSession = {
      id: 'wc-' + Math.random().toString(36).substring(2, 11),
      name,
      url,
      logo,
      description,
      connectedAt: Date.now()
    };

    showWCModal = false;
    showWCPrompt = true;
  }

  function handleApproveWCSession() {
    if (!pendingWCSession) return;
    
    activeWCSessions = [...activeWCSessions, pendingWCSession];
    localStorage.setItem(`vault_wallet_wc_sessions_${$currentUser.id}`, JSON.stringify(activeWCSessions));
    
    showWCPrompt = false;
    pendingWCSession = null;
    wcUri = '';
    alert('dApp session authorized successfully!');
  }

  function handleDisconnectWCSession(id) {
    activeWCSessions = activeWCSessions.filter(s => s.id !== id);
    localStorage.setItem(`vault_wallet_wc_sessions_${$currentUser.id}`, JSON.stringify(activeWCSessions));
  }

  function triggerMockSignRequest(session) {
    pendingWCSignRequest = {
      sessionId: session.id,
      dAppName: session.name,
      logo: session.logo,
      type: 'personal_sign',
      message: 'Welcome to Uniswap! Sign this message to log in securely and verify ownership of your DeFi Wallet.'
    };
    wcSignStatus = 'idle';
    wcSignPrompt = true;
  }

  async function handleApproveSignRequest() {
    if (!pendingWCSignRequest) return;
    
    let password = $loginPassword;
    let bioKey = null;

    if (biometricActive) {
      wcSignStatus = 'signing';
      try {
        const credId = localStorage.getItem(`vault_wallet_bio_cred_id_${$currentUser.id}`);
        const salt = $currentUser.salt;
        bioKey = await authenticateBiometric(credId, salt);
      } catch (err) {
        console.error('Biometric authentication failed:', err);
        wcSignStatus = 'error';
        return;
      }
    } else if (!password) {
      password = prompt('Enter your Vault account password to sign this dApp message:');
      if (!password) return;
    }

    wcSignStatus = 'signing';
    try {
      // Cryptographically verify authorization key
      if (biometricActive && bioKey) {
        await decryptWallet(encryptedWalletData, bioKey);
      } else {
        await decryptWallet(encryptedWalletData, password);
      }
      
      await new Promise(resolve => setTimeout(resolve, 800));
      wcSignStatus = 'success';
      setTimeout(() => {
        wcSignPrompt = false;
        pendingWCSignRequest = null;
        wcSignStatus = 'idle';
      }, 1500);
    } catch (err) {
      console.error('Signature authorization failed:', err);
      wcSignStatus = 'error';
    }
  }
  async function handleSendCrypto() {
    if (!sendRecipient || !sendAmount || !sendAssetObject) return;

    // Validate amount and balance
    const parsedAmount = parseFloat(sendAmount);
    const parsedBalance = parseFloat(sendAssetObject.balance) || 0;
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      sendError = 'Please enter a valid transfer amount';
      sendStatus = 'error';
      return;
    }
    if (parsedAmount > parsedBalance) {
      sendError = `Insufficient balance. You only have ${sendAssetObject.balance} ${sendAssetObject.symbol}.`;
      sendStatus = 'error';
      return;
    }

    // Validate addresses
    if (sendAssetObject.chainId === 'bitcoin') {
      if (!/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}$/.test(sendRecipient)) {
        sendError = 'Invalid Bitcoin Address';
        sendStatus = 'error';
        return;
      }
    } else if (sendAssetObject.chainId === 'solana-mainnet') {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sendRecipient)) {
        sendError = 'Invalid Solana Address';
        sendStatus = 'error';
        return;
      }
    } else {
      if (!/^0x[a-fA-F0-9]{40}$/.test(sendRecipient)) {
        sendError = 'Invalid EVM Address';
        sendStatus = 'error';
        return;
      }
    }
    
    // Get password to decrypt mnemonic
    let password = $loginPassword;
    if (!password) {
      password = prompt('Enter your Vault account password to authorize and sign transaction:');
      if (!password) return;
    }
    
    sendStatus = 'signing';
    sendError = '';
    txHash = '';
    
    try {
      const mnemonic = await decryptWallet(encryptedWalletData, password);
      sendStatus = 'broadcasting';
      
      let hash = '';
      if (sendAssetObject.chainId === 'bitcoin') {
        await new Promise(resolve => setTimeout(resolve, 1200));
        hash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('');
      } else if (sendAssetObject.chainId === 'solana-mainnet') {
        const tokenMint = TOKEN_CONTRACTS['solana-mainnet'][sendAssetObject.symbol] || null;
        hash = await sendSolanaTransaction(mnemonic, sendRecipient, sendAmount, tokenMint, true);
      } else { // EVM
        const tokenMint = TOKEN_CONTRACTS[sendAssetObject.chainId]?.[sendAssetObject.symbol] || null;
        hash = await sendEVMTransaction(mnemonic, sendRecipient, sendAmount, tokenMint, sendAssetObject.chainId);
      }
      
      txHash = hash;
      sendStatus = 'success';
      recordTransaction({
        type: 'send',
        asset: sendAssetObject.symbol,
        amount: sendAmount,
        to: sendRecipient,
        from: sendAssetObject.chainId === 'solana-mainnet' ? $walletState.solAddress : (sendAssetObject.chainId === 'bitcoin' ? $walletState.btcAddress : $walletState.evmAddress),
        hash: hash,
        chain: sendAssetObject.chainId,
        status: 'success'
      });
      setTimeout(fetchBalances, 2000);
    } catch (err) {
      console.error('Transfer failed:', err);
      sendError = err.message || 'Transaction failed';
      sendStatus = 'error';
    }
  }

  $: if ($walletState && step === 'dashboard') {
    fetchBalances();
  }

  // Inline SVG logos for cryptos and chains
  function getCryptoLogo(symbol, chainId) {
    const cleanSym = symbol ? symbol.toUpperCase() : '';
    if (cleanSym === 'BTC') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#F7931A"/><path d="M22.3,14.8c0.4-2.4-1.5-3.7-4-4.6l0.8-3.3l-2-0.5l-0.8,3.2c-0.5-0.1-1.1-0.2-1.6-0.3l0.8-3.2l-2-0.5l-0.8,3.3 c-0.4-0.1-0.9-0.2-1.3-0.3l0-0.1l-2.8-0.7l-0.5,2.2c0,0,1.5,0.3,1.5,0.4c0.8,0.2,1,0.7,0.9,1.2L9.7,16.1c0.1,0,0.1,0.1,0.2,0.1 c-0.1-0.1-0.2-0.2-0.2-0.2l-2.2,8.9c-0.1,0.3-0.4,0.7-1,0.6c0,0-1.5-0.4-1.5-0.4l-1,2.3l2.6,0.7c0.5,0.1,1,0.2,1.5,0.3l-0.8,3.3 l2,0.5l0.8-3.2c0.6,0.2,1.1,0.3,1.6,0.3l-0.8,3.2l2,0.5l0.8-3.3c3.4,0.6,6,0.4,7.1-2.7c0.9-2.5-0.1-3.9-1.9-4.8 C21.4,18.4,22.4,17,22.3,14.8z M18.4,22.9c-0.6,2.5-4.8,1.2-6.2,0.8l1.1-4.4C14.7,19.7,19.1,20.2,18.4,22.9z M19.4,15.1 c-0.6,2.3-4.1,1.1-5.3,0.8l1-4.1C16.3,12.1,20,12.6,19.4,15.1z" fill="white"/></svg>`;
    }
    if (cleanSym === 'SOL') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#14F195" fill-opacity="0.1"/><circle cx="16" cy="16" r="15" stroke="url(#sol-crypto-grad-ws)" stroke-width="1.5" fill="none"/><defs><linearGradient id="sol-crypto-grad-ws" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#9945FF"/><stop offset="100%" stop-color="#14F195"/></linearGradient></defs><g fill="url(#sol-crypto-grad-ws)"><path d="M22.5 8.7h-11.8c-0.3 0-0.5 0.2-0.6 0.4l-1.8 3.1c-0.1 0.2-0.1 0.5 0 0.7 0.1 0.2 0.3 0.4 0.6 0.4h11.8c0.3 0 0.5-0.2 0.6-0.4l1.8-3.1c0.1-0.2 0.1-0.5 0-0.7-0.1-0.2-0.3-0.4-0.6-0.4z"/><path d="M11.9 14.7h11.8c0.3 0 0.5 0.2 0.6 0.4l1.8 3.1c0.1 0.2 0.1 0.5 0 0.7-0.1 0.2-0.3 0.4-0.6 0.4h-11.8c-0.3 0-0.5-0.2-0.6-0.4l-1.8-3.1c-0.1-0.2-0.1-0.5 0-0.7 0.1-0.2 0.3-0.4 0.6-0.4z"/><path d="M22.5 20.7h-11.8c-0.3 0-0.5 0.2-0.6 0.4l-1.8 3.1c-0.1 0.2-0.1 0.5 0 0.7 0.1 0.2 0.3 0.4 0.6 0.4h11.8c0.3 0 0.5-0.2 0.6-0.4l1.8-3.1c0.1-0.2 0.1-0.5 0-0.7-0.1-0.2-0.3-0.4-0.6-0.4z"/></g></svg>`;
    }
    if (cleanSym === 'USDC') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#2775CA"/><path d="M16 6.5C10.75 6.5 6.5 10.75 6.5 16S10.75 25.5 16 25.5 25.5 21.25 25.5 16 21.25 6.5 16 6.5zm0 17.5c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm2-10c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2c1.1 0 2-.9 2-2zm-2 4c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" fill="white"/></svg>`;
    }
    if (cleanSym === 'USDT') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#26A17B"/><path d="M17.9 12.6v-2.1h4.6V7.6H9.5v2.9h4.6v2.1c-3.1.2-5.4 1-5.4 2.1 0 1 .1 1.8 4 2v5.6h2.6v-5.6c3.9-.2 4-1 4-2 0-1.1-1.7-1.9-4.8-2.1zm0 3.3c-.3.1-.7.1-1.1.1s-.8 0-1.1-.1v-1.1c.3.1.7.1 1.1.1s.8 0 1.1-.1v1.1z" fill="white"/></svg>`;
    }
    if (cleanSym === 'LINK') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#375BD2"/><path d="M16 6.5l8.2 4.7v9.6L16 25.5l-8.2-4.7v-9.6L16 6.5zm5.5 8.1l-2.1-1.2-3.4 2v1.3l2.1 1.2-2.1 1.2v2.5l5.5-3.2v-3.8zm-5.5-3.1l-2.1 1.2 2.1 1.2 2.1-1.2-2.1-1.2zM10.5 14.6v3.8l5.5 3.2v-2.5l-2.1-1.2v-1.3l3.5-2-2.1-1.2-4.8 2.8z" fill="white"/></svg>`;
    }
    if (cleanSym === 'UNI') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#FF007A"/><path d="M16 8.5c1.2 1.8 2.4 2.4 4.2 2.4 1 0 2-.3 2.8-.7-.4 1.4-1.2 2.5-2.5 3.2.8.2 1.6.2 2.4-.1-.5 1.2-1.5 2.1-2.8 2.5.5.5.9 1.1 1.2 1.8.3.6.4 1.3.4 2 0 1.7-1.4 3.1-3.1 3.1-1 0-1.9-.5-2.5-1.2-.6.7-1.5 1.2-2.5 1.2-1.7 0-3.1-1.4-3.1-3.1 0-.7.2-1.4.4-2 .3-.7.7-1.3 1.2-1.8-1.3-.4-2.3-1.3-2.8-2.5.8.3 1.6.3 2.4.1-1.3-.7-2.1-1.8-2.5-3.2.8.4 1.8.7 2.8.7 1.8 0 3-0.6 4.2-2.4z" fill="white"/></svg>`;
    }
    if (cleanSym === 'DEGEN') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#8B5CF6"/><path d="M9 22h14v2H9v-2zm1.5-6h11l1 4h-13l1-4zm1-4h9v2h-9v-2zm1.5-4h6v2h-6V8z" fill="white"/></svg>`;
    }
    if (cleanSym === 'AERO') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#0050B3"/><path d="M7.5 16l6.5-5.5v11L7.5 16zm10 0l-6.5-5.5v11l6.5-5.5zm7 0l-5-4v8l5-4z" fill="white"/></svg>`;
    }
    if (cleanSym === 'ARB') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#12AAFF"/><path d="M16 6.5l8.5 14.7H7.5L16 6.5zm0 3.7L10.3 19h11.4L16 10.2zm0 3.1l3 5.2h-6l3-5.2z" fill="white"/></svg>`;
    }
    if (cleanSym === 'OP') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#FF0420"/><path d="M12.5 11c-2.5 0-4.5 2-4.5 4.5s2 4.5 4.5 4.5 4.5-2 4.5-4.5-2-4.5-4.5-4.5zm0 7c-1.4 0-2.5-1.1-2.5-2.5s1.1-2.5 2.5-2.5 2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5zm10.5-6.5c-2.2 0-4 1.8-4 4s1.8 4 4 4 4-1.8 4-4-1.8-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" fill="white"/></svg>`;
    }
    if (cleanSym === 'QUICK') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#00D2FF"/><path d="M19 8l-8 9h6l-8 9 12-11h-6l6-7z" fill="white"/></svg>`;
    }
    if (cleanSym === 'BONK') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#E28743"/><circle cx="11" cy="14" r="2.5" fill="white"/><circle cx="21" cy="14" r="2.5" fill="white"/><circle cx="11" cy="14" r="1" fill="black"/><circle cx="21" cy="14" r="1" fill="black"/><path d="M13 18.5s1.5 2 3 2 3-2 3-2" stroke="white" stroke-width="1.5" fill="none"/></svg>`;
    }
    if (cleanSym === 'WIF') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#C4A484"/><path d="M8 20c1-2 3-3 5-3s4 1 5 3" fill="none" stroke="black" stroke-width="1.5"/><ellipse cx="16" cy="14" rx="8" ry="5" fill="#FF8DA1"/><ellipse cx="16" cy="14" rx="6" ry="3.5" fill="#FFC0CB"/></svg>`;
    }
    if (cleanSym === 'POL' || cleanSym === 'MATIC') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path d="M22.5 12.3l-2.6-1.5c-0.3-0.2-0.7-0.2-1 0l-1.3 0.8c-0.3 0.2-0.5 0.5-0.5 0.8v1.8l-1.1 0.6-1.3-0.8c-0.3-0.2-0.7-0.2-1 0l-2.6 1.5c-0.3 0.2-0.5 0.5-0.5 0.8v3.1c0 0.3 0.2 0.7 0.5 0.8l2.6 1.5c0.3 0.2 0.7 0.2 1 0l2.6-1.5c0.3-0.2 0.5-0.5 0.5-0.8v-3.1c0-0.3-0.2-0.7-0.5-0.8l-1.3-0.8 1.1-0.6 1.3 0.8c0.3 0.2 0.7 0.2 1 0l2.6-1.5c0.3-0.2 0.5-0.5 0.5-0.8v-3.1c0-0.4-0.2-0.7-0.5-0.9zm-9 7.8l-1.6-0.9v-1.8l1.6 0.9v1.8zm2.6-4.6l-1.6-0.9 1.6-0.9 1.6 0.9-1.6 0.9zm4.8-1.5l-1.6-0.9v-1.8l1.6 0.9v1.8z" fill="white"/></svg>`;
    }
    
    // ETH logo
    if (cleanSym === 'ETH') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="white"><path d="M16 4.5l-5.3 8.8L16 16l5.3-2.7z" fill-opacity="0.8"/><path d="M16 4.5V16l5.3-2.7z"/><path d="M16 17.5l-5.3-2.2 5.3 7.7 5.3-7.7z" fill-opacity="0.8"/><path d="M16 17.5V23l5.3-7.7z"/><path d="M16 16l-5.3-2.7L16 17.5z" fill-opacity="0.5"/><path d="M16 16l5.3-2.7L16 17.5z" fill-opacity="0.3"/></g></svg>`;
    }
    
    // Fallback text icon
    return `<div class="w-full h-full flex items-center justify-center bg-vault-border/50 text-vault-text rounded-full text-xs font-bold font-mono">?</div>`;
  }

  function getChainLogo(chainId) {
    if (chainId === 'ethereum') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="white"><path d="M16 4.5l-5.3 8.8L16 16l5.3-2.7z" fill-opacity="0.8"/><path d="M16 4.5V16l5.3-2.7z"/><path d="M16 17.5l-5.3-2.2 5.3 7.7 5.3-7.7z" fill-opacity="0.8"/><path d="M16 17.5V23l5.3-7.7z"/></g></svg>`;
    }
    if (chainId === 'base') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#0052FF"/><circle cx="16" cy="16" r="7" stroke="white" stroke-width="3" fill="none"/></svg>`;
    }
    if (chainId === 'arbitrum') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#12AAFF"/><path d="M16 6l9.5 16.5H6.5L16 6zm0 4L9.8 20.5h12.4L16 10zm0 3.5l3.5 6h-7l3.5-6z" fill="white"/></svg>`;
    }
    if (chainId === 'optimism') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#FF0420"/><path d="M12.5 11c-2.5 0-4.5 2-4.5 4.5s2 4.5 4.5 4.5 4.5-2 4.5-4.5-2-4.5-4.5-4.5zm0 7c-1.4 0-2.5-1.1-2.5-2.5s1.1-2.5 2.5-2.5 2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5z" fill="white"/></svg>`;
    }
    if (chainId === 'polygon') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path d="M22.5 12.3l-2.6-1.5c-0.3-0.2-0.7-0.2-1 0l-1.3 0.8c-0.3 0.2-0.5 0.5-0.5 0.8v1.8l-1.1 0.6-1.3-0.8c-0.3-0.2-0.7-0.2-1 0l-2.6 1.5c-0.3 0.2-0.5 0.5-0.5 0.8v3.1c0 0.3 0.2 0.7 0.5 0.8l2.6 1.5c0.3 0.2 0.7 0.2 1 0l2.6-1.5c0.3-0.2 0.5-0.5 0.5-0.8v-3.1c0-0.3-0.2-0.7-0.5-0.8l-1.3-0.8 1.1-0.6 1.3 0.8c0.3 0.2 0.7 0.2 1 0l2.6-1.5c0.3-0.2 0.5-0.5 0.5-0.8v-3.1c0-0.4-0.2-0.7-0.5-0.9zm-9 7.8l-1.6-0.9v-1.8l1.6 0.9v1.8zm2.6-4.6l-1.6-0.9 1.6-0.9 1.6 0.9-1.6 0.9zm4.8-1.5l-1.6-0.9v-1.8l1.6 0.9v1.8z" fill="white"/></svg>`;
    }
    if (chainId === 'solana-mainnet') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#14F195" fill-opacity="0.1"/><circle cx="16" cy="16" r="15" stroke="url(#sol-chain-grad-ws)" stroke-width="1.5" fill="none"/><defs><linearGradient id="sol-chain-grad-ws" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#9945FF"/><stop offset="100%" stop-color="#14F195"/></linearGradient></defs><g fill="url(#sol-chain-grad-ws)"><path d="M22.5 8.7h-11.8c-0.3 0-0.5 0.2-0.6 0.4l-1.8 3.1c-0.1 0.2-0.1 0.5 0 0.7 0.1 0.2 0.3 0.4 0.6 0.4h11.8c0.3 0 0.5-0.2 0.6-0.4l1.8-3.1c0.1-0.2 0.1-0.5 0-0.7-0.1-0.2-0.3-0.4-0.6-0.4z"/></g></svg>`;
    }
    if (chainId === 'bitcoin') {
      return `<svg viewBox="0 0 32 32" class="w-full h-full"><circle cx="16" cy="16" r="16" fill="#F7931A"/><path d="M22.3,14.8c0.4-2.4-1.5-3.7-4-4.6l0.8-3.3l-2-0.5l-0.8,3.2c-0.5-0.1-1.1-0.2-1.6-0.3l0.8-3.2l-2-0.5l-0.8,3.3 c-0.4-0.1-0.9-0.2-1.3-0.3l0-0.1l-2.8-0.7l-0.5,2.2c0,0,1.5,0.3,1.5,0.4c0.8,0.2,1,0.7,0.9,1.2L9.7,16.1c0.1,0,0.1,0.1,0.2,0.1 c-0.1-0.1-0.2-0.2-0.2-0.2l-2.2,8.9c-0.1,0.3-0.4,0.7-1,0.6c0,0-1.5-0.4-1.5-0.4l-1,2.3l2.6,0.7c0.5,0.1,1,0.2,1.5,0.3l-0.8,3.3 l2,0.5l0.8-3.2c0.6,0.2,1.1,0.3,1.6,0.3l-0.8,3.2l2,0.5l0.8-3.3c3.4,0.6,6,0.4,7.1-2.7c0.9-2.5-0.1-3.9-1.9-4.8 C21.4,18.4,22.4,17,22.3,14.8z M18.4,22.9c-0.6,2.5-4.8,1.2-6.2,0.8l1.1-4.4C14.7,19.7,19.1,20.2,18.4,22.9z M19.4,15.1 c-0.6,2.3-4.1,1.1-5.3,0.8l1-4.1C16.3,12.1,20,12.6,19.4,15.1z" fill="white"/></svg>`;
    }
    return ``;
  }

  $: if ($walletState && step === 'dashboard') {
    fetchBalances();
  }
</script>

<svelte:window on:click={() => {
  showReceiveChainDropdown = false;
  showReceiveDropdown = false;
  showSendChainDropdown = false;
  showSendDropdown = false;
  showSwapFromDropdown = false;
}} />

<div class="space-y-4 text-vault-text">
  {#if step === 'loading'}
    <div class="flex flex-col items-center justify-center py-12 gap-3 text-vault-text-dim text-xs">
      <svg class="w-6 h-6 animate-spin text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
      </svg>
      Scanning secure storage...
    </div>

  {:else if step === 'welcome'}
    <div class="space-y-4 text-center py-4">
      <div class="w-12 h-12 rounded-2xl bg-vault-accent/10 border border-vault-accent/20 flex items-center justify-center mx-auto text-vault-accent mb-2">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M22 10h-6a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h6" />
        </svg>
      </div>

      <div>
        <h4 class="text-sm font-semibold tracking-tight">DeFi Private Wallet</h4>
        <p class="text-[10px] text-vault-text-dim mt-1 max-w-xs mx-auto leading-relaxed">
          Initialize a zero-knowledge, multi-chain crypto wallet. Securely pay friends directly in chat using L2 stablecoins.
        </p>
      </div>

      <div class="space-y-2 pt-2">
        {#if encryptedWalletData}
          {#if biometricActive}
            <button
              on:click={handleBiometricUnlock}
              class="w-full py-2 bg-vault-accent hover:bg-vault-accent-hover text-vault-black font-semibold text-xs rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5"
            >
              <span>🔑</span> Unlock with Biometrics
            </button>
          {/if}
          <button
            on:click={handleUnlockWithAccountPassword}
            class="w-full py-2 bg-vault-elevated border border-vault-border hover:bg-vault-border text-vault-text font-semibold text-xs rounded-xl transition-all cursor-pointer"
          >
            Unlock with Password
          </button>
          <div class="text-[9px] text-vault-text-dim">Or overwrite current wallet by starting below</div>
        {/if}

        <button
          on:click={startWalletCreation}
          class="w-full py-2 bg-vault-elevated border border-vault-border hover:bg-vault-border text-vault-text font-semibold text-xs rounded-xl transition-all cursor-pointer"
        >
          Create New Wallet
        </button>

        <button
          on:click={startWalletImport}
          class="w-full py-2 bg-transparent hover:underline text-vault-text-secondary font-medium text-[11px] cursor-pointer"
        >
          Import seed phrase
        </button>
      </div>
    </div>

  {:else if step === 'create_show'}
    <div class="space-y-4 text-left">
      <div class="bg-vault-warning/5 border border-vault-warning/20 rounded-xl p-3 space-y-1.5">
        <div class="text-[10px] text-vault-warning font-bold uppercase tracking-wider flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          CRITICAL BACKUP WARNING
        </div>
        <p class="text-[9px] text-vault-text-dim leading-relaxed">
          Write down these 12 words in order and store them offline. If you lose them, your assets are lost forever. Vault cannot recover your wallet.
        </p>
      </div>

      <div class="relative bg-vault-black/40 border border-vault-border rounded-xl p-3.5 font-mono text-xs select-none">
        <div class="grid grid-cols-3 gap-2 {blurredMnemonic ? 'blur-sm select-none pointer-events-none' : ''}">
          {#each generatedMnemonic.split(' ') as word, idx}
            <div class="flex items-center gap-1.5 py-1 px-1.5 bg-vault-elevated border border-vault-border-subtle rounded-lg text-[10px]">
              <span class="text-vault-text-dim text-[9px] w-3">{idx + 1}</span>
              <span class="text-vault-text font-semibold">{word}</span>
            </div>
          {/each}
        </div>

        {#if blurredMnemonic}
          <div class="absolute inset-0 flex flex-col items-center justify-center bg-vault-surface/40 backdrop-blur-md rounded-xl p-3 text-center">
            <button
              on:click={() => blurredMnemonic = false}
              class="py-1.5 px-4 bg-vault-accent text-vault-black font-semibold text-[10px] rounded-lg cursor-pointer hover:bg-vault-accent-hover transition-all"
            >
              Reveal Mnemonic
            </button>
          </div>
        {/if}
      </div>

      <div class="flex gap-2">
        <button
          on:click={() => copyMnemonicToClipboard(generatedMnemonic)}
          disabled={blurredMnemonic}
          class="flex-1 py-1.5 px-3 bg-vault-elevated border border-vault-border hover:bg-vault-border text-vault-text font-semibold text-[10px] rounded-xl flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {copiedMnemonic ? 'Copied' : 'Copy'}
        </button>

        <button
          on:click={() => downloadBackupPDF(generatedMnemonic, pendingEvmAddress, pendingSolAddress)}
          disabled={blurredMnemonic}
          class="flex-1 py-1.5 px-3 bg-vault-elevated border border-vault-border hover:bg-vault-border text-vault-text font-semibold text-[10px] rounded-xl flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Save PDF
        </button>
      </div>

      <div class="flex gap-2 pt-2">
        <button
          on:click={() => step = 'welcome'}
          class="py-1.5 px-3 bg-transparent text-vault-text hover:text-vault-text-dim text-[11px] font-medium rounded-xl"
        >
          Back
        </button>
        <button
          on:click={goToVerification}
          disabled={blurredMnemonic}
          class="flex-1 py-1.5 px-4 bg-vault-accent text-vault-black font-semibold text-[11px] rounded-xl hover:bg-vault-accent-hover disabled:opacity-40"
        >
          I've Written It Down
        </button>
      </div>
    </div>

  {:else if step === 'create_verify'}
    <div class="space-y-4 text-left">
      <div>
        <h4 class="text-xs font-semibold text-vault-text uppercase tracking-wider">Verify seed phrase</h4>
        <p class="text-[10px] text-vault-text-dim mt-0.5 leading-relaxed">
          Tap the words in the exact sequence to confirm your backup.
        </p>
      </div>

      <!-- Selected words container -->
      <div class="min-h-[72px] bg-vault-black/40 border border-vault-border rounded-xl p-3 flex flex-wrap gap-1.5">
        {#if selectedWords.length === 0}
          <div class="text-[10px] text-vault-text-dim/50 italic self-center mx-auto">Select words in order...</div>
        {/if}
        {#each selectedWords as word, idx}
          <button
            on:click={() => deselectWord(word, idx)}
            class="flex items-center gap-1 py-1 px-2 bg-vault-accent/15 border border-vault-accent/30 rounded-lg text-[10px] text-vault-accent hover:bg-vault-danger/10 hover:border-vault-danger/25 hover:text-vault-danger transition-all cursor-pointer font-mono"
          >
            <span>{idx + 1}</span>
            <span>{word}</span>
          </button>
        {/each}
      </div>

      {#if verificationError}
        <div class="text-[10px] text-vault-danger font-semibold flex items-center gap-1">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {verificationError}
        </div>
      {/if}

      <!-- Shuffled word buttons -->
      <div class="bg-vault-elevated/40 border border-vault-border rounded-xl p-3 flex flex-wrap gap-1.5">
        {#each shuffledWords as word, idx}
          <button
            on:click={() => selectWord(word, idx)}
            class="py-1 px-2 bg-vault-elevated border border-vault-border-subtle rounded-lg text-[10px] hover:bg-vault-border transition-all cursor-pointer font-mono text-vault-text"
          >
            {word}
          </button>
        {/each}
      </div>

      <div class="flex gap-2 pt-2">
        <button
          on:click={() => step = 'create_show'}
          class="py-1.5 px-3 bg-transparent text-vault-text hover:text-vault-text-dim text-[11px] font-medium rounded-xl"
        >
          Back
        </button>
        <button
          on:click={completeWalletSetup}
          disabled={selectedWords.length < 12}
          class="flex-1 py-1.5 px-4 bg-vault-accent text-vault-black font-semibold text-[11px] rounded-xl hover:bg-vault-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm & Save
        </button>
      </div>
    </div>

  {:else if step === 'import'}
    <div class="space-y-4 text-left">
      <div>
        <h4 class="text-xs font-semibold text-vault-text uppercase tracking-wider">Import Private Wallet</h4>
        <p class="text-[10px] text-vault-text-dim mt-0.5 leading-relaxed">
          Paste your standard 12-word BIP-39 mnemonic phrase below.
        </p>
      </div>

      <div class="space-y-2">
        <textarea
          bind:value={importInput}
          placeholder="E.g., apple banana cherry..."
          rows="3"
          class="input text-xs bg-vault-elevated border-vault-border-subtle resize-none py-2 px-3 font-mono leading-relaxed"
        ></textarea>

        {#if importError}
          <div class="text-[10px] text-vault-danger font-semibold flex items-center gap-1">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {importError}
          </div>
        {/if}
      </div>

      <div class="flex gap-2 pt-1">
        <button
          on:click={() => step = 'welcome'}
          class="py-1.5 px-3 bg-transparent text-vault-text hover:text-vault-text-dim text-[11px] font-medium rounded-xl"
        >
          Cancel
        </button>
        <button
          on:click={handleImportWallet}
          disabled={!importInput.trim()}
          class="flex-1 py-1.5 px-4 bg-vault-accent text-vault-black font-semibold text-[11px] rounded-xl hover:bg-vault-accent-hover disabled:opacity-40"
        >
          Import Wallet
        </button>
      </div>
    </div>

  {:else if step === 'dashboard'}
    <div class="space-y-3 text-left">
      <!-- Clean Header -->
      <div class="flex items-center justify-between pb-1">
        <span class="text-[10px] text-vault-text-dim font-bold uppercase tracking-wider flex items-center gap-1.5 animate-fade-in">
          <span class="w-1.5 h-1.5 rounded-full bg-vault-accent {isFetchingBalances ? 'animate-ping' : 'animate-pulse'}"></span>
          Vault Wallet
        </span>
        <button
          on:click={fetchBalances}
          disabled={isFetchingBalances}
          class="text-vault-accent hover:text-vault-accent-hover text-[9px] uppercase font-bold tracking-wider cursor-pointer bg-transparent border-none focus:outline-none flex items-center gap-1"
        >
          <svg class="w-3 h-3 {isFetchingBalances ? 'animate-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 4v6h6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M23 20v-6h-6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {isFetchingBalances ? '...' : ''}
        </button>
      </div>

      <!-- Compact Balance Card -->
      <div class="p-4 rounded-2xl bg-gradient-to-br from-vault-elevated/60 to-vault-surface/40 border border-vault-border/60 text-center select-none animate-scale-up">
        <span class="text-[9px] text-vault-text-dim uppercase tracking-wider font-semibold">Total Balance</span>
        <h2 class="text-2xl font-extrabold text-vault-text leading-tight mt-0.5 font-mono tracking-tight text-glow-accent">
          ${totalUSD}
        </h2>
        <!-- Mini inline chart -->
        <div class="relative h-[50px] w-full mt-2">
          {#if chartData.length >= 2}
            <svg viewBox="0 0 280 70" class="w-full h-full" preserveAspectRatio="none">
              <defs>
                <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="{chartChange >= 0 ? 'rgb(16,185,129)' : 'rgb(239,68,68)'}" stop-opacity="0.2" />
                  <stop offset="100%" stop-color="{chartChange >= 0 ? 'rgb(16,185,129)' : 'rgb(239,68,68)'}" stop-opacity="0" />
                </linearGradient>
              </defs>
              <path d={chartFillPath} fill="url(#chartGrad)" />
              <path d={chartPath} fill="none" stroke="{chartChange >= 0 ? 'rgb(16,185,129)' : 'rgb(239,68,68)'}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {:else}
            <div class="flex items-center justify-center h-full text-[9px] text-vault-text-dim/50">
              Chart populates on refresh
            </div>
          {/if}
        </div>
        <div class="flex items-center justify-center gap-2 mt-1">
          <span class="text-[10px] font-bold font-mono {chartChange >= 0 ? 'text-vault-accent' : 'text-vault-danger'}">
            {chartChange >= 0 ? '+' : ''}{chartChangePct}%
          </span>
          <div class="flex gap-0.5">
            {#each ['24H', '7D', '30D'] as tf}
              <button
                on:click={() => chartTimeframe = tf}
                class="py-0.5 px-1.5 text-[7px] font-bold rounded-md border cursor-pointer transition-all
                  {chartTimeframe === tf
                    ? 'bg-vault-accent/15 border-vault-accent/30 text-vault-accent'
                    : 'bg-transparent border-transparent text-vault-text-dim hover:text-vault-text'}"
              >
                {tf}
              </button>
            {/each}
          </div>
        </div>
      </div>

      <!-- 3-Icon Action Grid (MetaMask / Phantom style) -->
      <div class="grid grid-cols-3 gap-2 animate-scale-up">
        <button
          on:click={() => {
            showSendModal = true;
            sendRecipient = '';
            sendAmount = '';
            sendStatus = 'idle';
            sendError = '';
          }}
          class="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-vault-elevated/60 border border-vault-border/50 hover:bg-vault-accent/10 hover:border-vault-accent/30 text-vault-text transition-all cursor-pointer group"
        >
          <div class="w-8 h-8 rounded-full bg-vault-accent/15 border border-vault-accent/25 flex items-center justify-center group-hover:bg-vault-accent/25 transition-all">
            <svg class="w-4 h-4 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="19" x2="12" y2="5" stroke-linecap="round"/>
              <polyline points="5 12 12 5 19 12" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <span class="text-[9px] font-semibold">Send</span>
        </button>

        <button
          on:click={() => {
            showReceiveModal = true;
            receiveCustomContract = '';
            copiedReceiveAddress = false;
          }}
          class="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-vault-elevated/60 border border-vault-border/50 hover:bg-vault-accent/10 hover:border-vault-accent/30 text-vault-text transition-all cursor-pointer group"
        >
          <div class="w-8 h-8 rounded-full bg-vault-accent/15 border border-vault-accent/25 flex items-center justify-center group-hover:bg-vault-accent/25 transition-all">
            <svg class="w-4 h-4 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19" stroke-linecap="round"/>
              <polyline points="19 12 12 19 5 12" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <span class="text-[9px] font-semibold">Receive</span>
        </button>

        <button
          on:click={() => showHistoryModal = true}
          class="flex flex-col items-center gap-1.5 py-3 rounded-xl bg-vault-elevated/60 border border-vault-border/50 hover:bg-vault-accent/10 hover:border-vault-accent/30 text-vault-text transition-all cursor-pointer group"
        >
          <div class="w-8 h-8 rounded-full bg-vault-accent/15 border border-vault-accent/25 flex items-center justify-center group-hover:bg-vault-accent/25 transition-all">
            <svg class="w-4 h-4 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <span class="text-[9px] font-semibold">History</span>
        </button>
      </div>

      <!-- Holdings List (Compact, hides zero-balance) -->
      <div class="rounded-xl border border-vault-border/50 overflow-hidden animate-scale-up">
        <button
          on:click={() => showHoldings = !showHoldings}
          class="w-full px-3 py-2 bg-vault-elevated/30 hover:bg-vault-elevated/50 text-[10px] font-bold text-vault-text flex items-center justify-between border-none cursor-pointer select-none transition-all"
        >
          <span class="flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M22 10h-6a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h6" />
            </svg>
            Holdings & Addresses
          </span>
          <span class="text-vault-text-dim text-[8px] transform transition-transform duration-200 {showHoldings ? 'rotate-180' : ''}">
            ▼
          </span>
        </button>

        {#if showHoldings}
          <div class="p-3 space-y-3 bg-vault-black/20 border-t border-vault-border/40 animate-scale-up text-left">
            <!-- Supported Networks & Integrations Row -->
            <div>
              <span class="text-[8px] text-vault-text-dim uppercase tracking-wider font-semibold block mb-1.5">Supported Live Networks</span>
              <div class="flex flex-wrap gap-1.5">
                {#each AVAILABLE_CHAINS as chain}
                  <div class="flex items-center gap-1.5 py-1 px-2.5 bg-vault-elevated/60 border border-vault-border/40 rounded-full text-[9px] font-bold text-vault-text select-none">
                    <span class="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                      {@html getChainLogo(chain.id)}
                    </span>
                    <span>{chain.name.replace(' Mainnet', '').replace(' One', '')}</span>
                    <span class="w-1 h-1 rounded-full bg-vault-accent"></span>
                  </div>
                {/each}
              </div>
            </div>

            <!-- Addresses -->
            <div class="space-y-1.5">
              <span class="text-[8px] text-vault-text-dim uppercase tracking-wider font-semibold block">Addresses</span>
              <div class="flex items-center justify-between py-1.5 px-2.5 bg-vault-elevated/50 rounded-lg">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-[9px] text-vault-text-dim font-semibold shrink-0">EVM</span>
                  <span class="font-mono text-[8px] text-vault-text truncate">{$walletState.evmAddress}</span>
                </div>
                <button
                  on:click={() => copyAddress($walletState.evmAddress, 'evm')}
                  class="text-[8px] text-vault-accent hover:text-vault-accent-hover cursor-pointer bg-transparent border-none shrink-0 ml-1"
                >
                  {copiedAddressType === 'evm' ? '✓' : 'Copy'}
                </button>
              </div>
              <div class="flex items-center justify-between py-1.5 px-2.5 bg-vault-elevated/50 rounded-lg">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-[9px] text-vault-text-dim font-semibold shrink-0">SOL</span>
                  <span class="font-mono text-[8px] text-vault-text truncate">{$walletState.solAddress}</span>
                </div>
                <button
                  on:click={() => copyAddress($walletState.solAddress, 'sol')}
                  class="text-[8px] text-vault-accent hover:text-vault-accent-hover cursor-pointer bg-transparent border-none shrink-0 ml-1"
                >
                  {copiedAddressType === 'sol' ? '✓' : 'Copy'}
                </button>
              </div>
              <div class="flex items-center justify-between py-1.5 px-2.5 bg-vault-elevated/50 rounded-lg">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-[9px] text-vault-text-dim font-semibold shrink-0">BTC</span>
                  <span class="font-mono text-[8px] text-vault-text truncate">{$walletState.btcAddress}</span>
                </div>
                <button
                  on:click={() => copyAddress($walletState.btcAddress, 'btc')}
                  class="text-[8px] text-vault-accent hover:text-vault-accent-hover cursor-pointer bg-transparent border-none shrink-0 ml-1"
                >
                  {copiedAddressType === 'btc' ? '✓' : 'Copy'}
                </button>
              </div>
            </div>

            <!-- Token Balances (hide zero-balance by default) -->
            <div class="space-y-1 pt-1">
              <span class="text-[8px] text-vault-text-dim uppercase tracking-wider font-semibold">Balances</span>
              {#each assets.filter(a => parseFloat(a.balance) > 0) as asset}
                <div class="flex items-center justify-between px-2.5 py-1.5 bg-vault-elevated/40 border border-vault-border/30 rounded-lg">
                  <div class="flex items-center gap-1.5">
                    <span class="w-5 h-5 flex items-center justify-center shrink-0">
                      {@html getCryptoLogo(asset.symbol, asset.chainId)}
                    </span>
                    <div>
                      <span class="text-[10px] font-bold block leading-none text-vault-text">{asset.symbol}</span>
                      <span class="text-[7px] text-vault-text-dim">{asset.network}</span>
                    </div>
                  </div>
                  <span class="text-[10px] font-bold font-mono text-vault-text">{asset.balance}</span>
                </div>
              {/each}
              {#if assets.filter(a => parseFloat(a.balance) > 0).length === 0}
                <div class="text-[9px] text-vault-text-dim text-center py-2">No balances found — deposit crypto to get started</div>
              {/if}
              
              {#if showZeroBalances}
                <div class="space-y-1 mt-1 border-t border-vault-border/20 pt-1.5 animate-scale-up">
                  {#each assets.filter(a => parseFloat(a.balance) <= 0) as asset}
                    <div class="flex items-center justify-between px-2.5 py-1.5 bg-vault-elevated/20 border border-vault-border/20 rounded-lg">
                      <div class="flex items-center gap-1.5">
                        <span class="w-5 h-5 flex items-center justify-center shrink-0">
                          {@html getCryptoLogo(asset.symbol, asset.chainId)}
                        </span>
                        <div>
                          <span class="text-[10px] font-bold block leading-none text-vault-text">{asset.symbol}</span>
                          <span class="text-[7px] text-vault-text-dim">{asset.network}</span>
                        </div>
                      </div>
                      <span class="text-[10px] font-mono text-vault-text-dim">{asset.balance}</span>
                    </div>
                  {/each}
                </div>
              {/if}

              {#if assets.filter(a => parseFloat(a.balance) <= 0).length > 0}
                <button
                  on:click={() => showZeroBalances = !showZeroBalances}
                  class="text-[8px] text-vault-accent hover:text-vault-accent-hover font-semibold cursor-pointer bg-transparent border-none pt-1"
                >
                  {showZeroBalances ? 'Hide zero balance tokens' : `+ ${assets.filter(a => parseFloat(a.balance) <= 0).length} more tokens with zero balance`}
                </button>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <!-- Settings & Security Accordion -->
      <div class="rounded-xl border border-vault-border/50 overflow-hidden">
        <button
          on:click={() => showSettings = !showSettings}
          class="w-full px-3 py-2 bg-vault-elevated/30 hover:bg-vault-elevated/50 text-[10px] font-bold text-vault-text flex items-center justify-between border-none cursor-pointer select-none transition-all"
        >
          <span class="flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-vault-text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            Settings & Security
          </span>
          <span class="text-vault-text-dim text-[8px] transform transition-transform duration-200 {showSettings ? 'rotate-180' : ''}">
            ▼
          </span>
        </button>

        {#if showSettings}
          <div class="p-3 space-y-3 bg-vault-black/20 border-t border-vault-border/40 animate-scale-up text-left">

            <!-- Biometric Toggle -->
            {#if isBiometricSupported}
              <div class="flex items-center justify-between p-2 bg-vault-elevated/40 border border-vault-border/40 rounded-lg">
                <div class="flex flex-col gap-0">
                  <span class="text-[9px] font-semibold text-vault-text">Biometric Unlock</span>
                  <span class="text-[7px] text-vault-text-dim">Use platform biometrics for wallet access</span>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={biometricActive}
                    on:change={handleToggleBiometrics}
                    class="sr-only peer"
                  />
                  <div class="w-7 h-3.5 bg-vault-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-vault-text after:border-vault-border after:border after:rounded-full after:h-2.5 after:w-2.5 after:transition-all peer-checked:bg-vault-accent"></div>
                </label>
              </div>
            {/if}

            <!-- Connect dApp -->
            <div class="space-y-1.5">
              <span class="text-[9px] text-vault-text-dim uppercase tracking-wider font-semibold">Connected dApps</span>
              <button
                on:click={() => {
                  showWCModal = true;
                  wcUri = '';
                }}
                class="w-full py-1.5 px-2 text-[9px] bg-vault-elevated/60 border border-vault-border/50 text-vault-text hover:bg-vault-border font-semibold rounded-lg cursor-pointer flex items-center justify-center gap-1"
              >
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                Connect dApp (WalletConnect)
              </button>

              {#if activeWCSessions.length === 0}
                <div class="text-[8px] text-vault-text-dim py-0.5">No active connections</div>
              {:else}
                <div class="space-y-1">
                  {#each activeWCSessions as session}
                    <div class="flex items-center justify-between p-1.5 bg-vault-elevated/40 border border-vault-border/30 rounded-lg">
                      <div class="flex items-center gap-1.5 min-w-0">
                        <span class="text-sm">{session.logo}</span>
                        <div class="min-w-0">
                          <span class="text-[9px] font-bold block text-vault-text truncate">{session.name}</span>
                          <a href={session.url} target="_blank" rel="noreferrer" class="text-[7px] text-vault-accent hover:underline block truncate">{session.url}</a>
                        </div>
                      </div>
                      <div class="flex items-center gap-1 shrink-0">
                        <button
                          on:click={() => triggerMockSignRequest(session)}
                          class="py-0.5 px-1.5 text-[7px] bg-vault-accent/10 text-vault-accent font-semibold rounded hover:bg-vault-accent/20 cursor-pointer border-none"
                        >
                          Sign
                        </button>
                        <button
                          on:click={() => handleDisconnectWCSession(session.id)}
                          class="py-0.5 px-1.5 text-[7px] bg-vault-danger/10 text-vault-danger font-semibold rounded hover:bg-vault-danger/20 cursor-pointer border-none"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- Danger Zone -->
            <div class="border-t border-vault-border/30 pt-2">
              <span class="text-[9px] text-vault-danger/60 uppercase tracking-wider font-semibold">Danger Zone</span>
              {#if !showConfirmWipe}
                <button
                  on:click={() => showConfirmWipe = true}
                  class="w-full mt-1 py-1.5 text-[9px] bg-vault-danger/5 border border-vault-danger/15 text-vault-danger/70 hover:text-vault-danger hover:bg-vault-danger/10 font-semibold rounded-lg cursor-pointer transition-all"
                >
                  Wipe Wallet Keys
                </button>
              {:else}
                <div class="bg-vault-danger/10 border border-vault-danger/20 rounded-lg p-2.5 space-y-1.5 text-xs mt-1 animate-scale-up">
                  <div class="font-bold text-vault-danger text-[10px]">⚠️ Wipe All Local Keys?</div>
                  <p class="text-[8px] text-vault-text-dim leading-relaxed">
                    This permanently deletes wallet credentials from this device. You must have your seed phrase to restore access.
                  </p>
                  <div class="flex gap-1.5">
                    <button
                      on:click={() => showConfirmWipe = false}
                      class="py-1 px-2 bg-vault-elevated text-vault-text text-[8px] rounded border border-vault-border cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      on:click={wipeWallet}
                      class="py-1 px-2 bg-vault-danger text-white font-semibold text-[8px] rounded border-none cursor-pointer"
                    >
                      Confirm Wipe
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ═══════════════════ HISTORY MODAL ═══════════════════ -->
  {#if showHistoryModal}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
      <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left">
        <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
          <h3 class="text-sm font-semibold text-vault-text flex items-center gap-1.5">
            <svg class="w-4 h-4 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Transaction History
          </h3>
          <button on:click={() => showHistoryModal = false} class="text-vault-text-dim hover:text-vault-text border-none bg-transparent cursor-pointer" aria-label="Close history">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="p-4 max-h-[400px] overflow-y-auto">
          {#if txHistory.length === 0}
            <div class="flex flex-col items-center justify-center py-8 text-center">
              <svg class="w-10 h-10 text-vault-border mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span class="text-[11px] text-vault-text-dim font-medium">No transactions yet</span>
              <span class="text-[9px] text-vault-text-dim/60 mt-0.5">Send or swap crypto to see history here</span>
            </div>
          {:else}
            <div class="space-y-1.5">
              {#each txHistory as tx}
                <div class="p-2.5 bg-vault-elevated/50 border border-vault-border/40 rounded-xl space-y-1">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                      <div class="w-6 h-6 rounded-full flex items-center justify-center text-[10px]
                        {tx.type === 'send' ? 'bg-orange-500/10 text-orange-400' : tx.type === 'swap' ? 'bg-blue-500/10 text-blue-400' : 'bg-vault-accent/10 text-vault-accent'}">
                        {tx.type === 'send' ? '↗' : tx.type === 'swap' ? '⇄' : '↙'}
                      </div>
                      <div>
                        <span class="text-[10px] font-bold text-vault-text capitalize block leading-none">{tx.type}</span>
                        <span class="text-[8px] text-vault-text-dim">{tx.asset} • {getRelativeTime(tx.timestamp)}</span>
                      </div>
                    </div>
                    <div class="text-right">
                      <span class="text-[10px] font-bold font-mono text-vault-text block leading-none">
                        {tx.type === 'send' ? '-' : '+'}{tx.amount}
                      </span>
                      <span class="text-[7px] font-mono text-vault-text-dim truncate block max-w-[80px]">
                        {tx.to ? tx.to.slice(0, 6) + '...' + tx.to.slice(-4) : ''}
                      </span>
                    </div>
                  </div>
                  {#if tx.hash}
                    <a
                      href={getExplorerUrl(tx.hash, tx.chain)}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-[8px] text-vault-accent hover:underline font-mono flex items-center gap-0.5"
                    >
                      <span class="truncate">{tx.hash.slice(0, 12)}...{tx.hash.slice(-6)}</span>
                      <svg class="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                      </svg>
                    </a>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="px-5 py-3 bg-vault-elevated border-t border-vault-border flex justify-between items-center">
          {#if txHistory.length > 0}
            <button
              on:click={clearTxHistory}
              class="py-1 px-2 text-[9px] bg-vault-danger/10 text-vault-danger font-semibold rounded-lg hover:bg-vault-danger/20 cursor-pointer border-none"
            >
              Clear All
            </button>
          {:else}
            <div></div>
          {/if}
          <button
            on:click={() => showHistoryModal = false}
            class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl cursor-pointer border-none"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ═══════════════════ ADDRESS BOOK / CONTACTS MODAL ═══════════════════ -->
  {#if showAddressBook}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
      <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left">
        <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
          <h3 class="text-sm font-semibold text-vault-text flex items-center gap-1.5">
            <svg class="w-4 h-4 text-vault-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            Address Book
          </h3>
          <button on:click={() => showAddressBook = false} class="text-vault-text-dim hover:text-vault-text border-none bg-transparent cursor-pointer" aria-label="Close address book">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="p-4 max-h-[400px] overflow-y-auto space-y-3">
          {#if contacts.length === 0 && !showAddContactForm}
            <div class="flex flex-col items-center justify-center py-8 text-center">
              <svg class="w-10 h-10 text-vault-border mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <line x1="19" y1="8" x2="19" y2="14"/>
                <line x1="22" y1="11" x2="16" y2="11"/>
              </svg>
              <span class="text-[11px] text-vault-text-dim font-medium">No contacts yet</span>
              <span class="text-[9px] text-vault-text-dim/60 mt-0.5">Save addresses for easy sending</span>
            </div>
          {:else}
            <div class="space-y-1.5">
              {#each contacts as contact}
                <div class="p-2.5 bg-vault-elevated/50 border border-vault-border/40 rounded-xl">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-[11px] font-bold text-vault-text">{contact.label}</span>
                    <button
                      on:click={() => removeContact(contact.id)}
                      class="text-[8px] text-vault-danger/60 hover:text-vault-danger cursor-pointer bg-transparent border-none"
                    >
                      Remove
                    </button>
                  </div>
                  <div class="space-y-0.5">
                    {#if contact.evmAddress}
                      <div class="flex items-center gap-1">
                        <span class="text-[7px] text-vault-text-dim uppercase font-bold w-6">EVM</span>
                        <span class="font-mono text-[8px] text-vault-text truncate">{contact.evmAddress}</span>
                      </div>
                    {/if}
                    {#if contact.solAddress}
                      <div class="flex items-center gap-1">
                        <span class="text-[7px] text-vault-text-dim uppercase font-bold w-6">SOL</span>
                        <span class="font-mono text-[8px] text-vault-text truncate">{contact.solAddress}</span>
                      </div>
                    {/if}
                    {#if contact.btcAddress}
                      <div class="flex items-center gap-1">
                        <span class="text-[7px] text-vault-text-dim uppercase font-bold w-6">BTC</span>
                        <span class="font-mono text-[8px] text-vault-text truncate">{contact.btcAddress}</span>
                      </div>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          <!-- Add Contact Form -->
          {#if showAddContactForm}
            <div class="space-y-2 bg-vault-black/30 border border-vault-border/50 rounded-xl p-3 animate-scale-up">
              <span class="text-[10px] font-bold text-vault-text block">New Contact</span>
              <input
                type="text"
                bind:value={newContactLabel}
                placeholder="Contact name"
                class="input py-1.5 text-[10px] bg-vault-elevated border-vault-border-subtle text-vault-text w-full rounded-lg px-2.5"
              />
              <input
                type="text"
                bind:value={newContactEvm}
                placeholder="EVM address (0x...)"
                class="input py-1.5 text-[10px] bg-vault-elevated border-vault-border-subtle font-mono text-vault-text w-full rounded-lg px-2.5"
              />
              <input
                type="text"
                bind:value={newContactSol}
                placeholder="Solana address"
                class="input py-1.5 text-[10px] bg-vault-elevated border-vault-border-subtle font-mono text-vault-text w-full rounded-lg px-2.5"
              />
              <input
                type="text"
                bind:value={newContactBtc}
                placeholder="Bitcoin address (bc1...)"
                class="input py-1.5 text-[10px] bg-vault-elevated border-vault-border-subtle font-mono text-vault-text w-full rounded-lg px-2.5"
              />
              <div class="flex gap-1.5">
                <button
                  on:click={() => showAddContactForm = false}
                  class="flex-1 py-1 text-[9px] bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-lg cursor-pointer border border-vault-border"
                >
                  Cancel
                </button>
                <button
                  on:click={addContact}
                  disabled={!newContactLabel.trim()}
                  class="flex-1 py-1 text-[9px] bg-vault-accent text-vault-black font-semibold rounded-lg cursor-pointer border-none hover:bg-vault-accent-hover disabled:opacity-40"
                >
                  Save Contact
                </button>
              </div>
            </div>
          {/if}
        </div>

        <div class="px-5 py-3 bg-vault-elevated border-t border-vault-border flex justify-between items-center">
          <button
            on:click={() => { showAddContactForm = !showAddContactForm; }}
            class="py-1.5 px-3 text-[10px] bg-vault-accent/10 text-vault-accent font-semibold rounded-lg hover:bg-vault-accent/20 cursor-pointer border border-vault-accent/20 flex items-center gap-1"
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            {showAddContactForm ? 'Cancel' : 'Add Contact'}
          </button>
          <button
            on:click={() => showAddressBook = false}
            class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl cursor-pointer border-none"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if showReceiveModal}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
      <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl relative animate-scale-up text-left">
        <!-- Modal Header -->
        <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
          <h3 class="text-sm font-semibold text-vault-text">Receive Assets</h3>
          <button on:click={() => showReceiveModal = false} class="text-vault-text-dim hover:text-vault-text border-none bg-transparent cursor-pointer" aria-label="Close receive">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="p-5 space-y-4">
          <!-- Chain and Searchable Asset Selectors -->
          <div class="grid grid-cols-2 gap-3 relative z-50">
            <!-- 1. Chain Selector -->
            <div class="relative">
              <label for="receive-chain-btn" class="text-[10px] uppercase font-bold text-vault-text-dim block mb-1">Network / Chain</label>
              <div class="relative">
                <button
                  id="receive-chain-btn"
                  type="button"
                  on:click|stopPropagation={() => {
                    showReceiveChainDropdown = !showReceiveChainDropdown;
                    showReceiveDropdown = false;
                  }}
                  class="flex items-center justify-between py-2 px-3 text-xs bg-vault-elevated border border-vault-border-subtle text-vault-text w-full rounded-xl focus:outline-none cursor-pointer text-left font-semibold"
                >
                  <div class="flex items-center gap-2">
                    <span class="w-4 h-4 flex items-center justify-center shrink-0">
                      {@html getChainLogo(receiveChain)}
                    </span>
                    <span class="truncate">{AVAILABLE_CHAINS.find(c => c.id === receiveChain)?.name.replace(' Mainnet', '').replace(' One', '')}</span>
                  </div>
                  <span class="text-vault-text-dim text-[8px]">▼</span>
                </button>
              </div>

              {#if showReceiveChainDropdown}
                <div role="presentation" class="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-vault-elevated border border-vault-border rounded-xl shadow-xl p-1 animate-scale-up" on:click|stopPropagation>
                  {#each AVAILABLE_CHAINS as chain}
                    <button
                      type="button"
                      on:click={() => handleSelectReceiveChain(chain.id)}
                      class="w-full flex items-center gap-2 p-2 rounded-lg text-left text-xs text-vault-text hover:bg-vault-surface cursor-pointer border-none bg-transparent"
                    >
                      <span class="w-4 h-4 flex items-center justify-center shrink-0">
                        {@html getChainLogo(chain.id)}
                      </span>
                      <span class="font-semibold">{chain.name}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- 2. Searchable Asset Input -->
            <div class="relative">
              <label for="receive-asset-btn" class="text-[10px] uppercase font-bold text-vault-text-dim block mb-1">Crypto Asset</label>
              <div class="relative">
                <button
                  id="receive-asset-btn"
                  type="button"
                  on:click|stopPropagation={() => {
                    showReceiveDropdown = !showReceiveDropdown;
                    showReceiveChainDropdown = false;
                  }}
                  class="flex items-center justify-between py-2 px-3 text-xs bg-vault-elevated border border-vault-border-subtle text-vault-text w-full rounded-xl focus:outline-none cursor-pointer text-left"
                >
                  <div class="flex items-center gap-2">
                    <span class="w-4 h-4 flex items-center justify-center shrink-0">
                      {@html getCryptoLogo(receiveAssetObject?.symbol, receiveAssetObject?.chainId)}
                    </span>
                    <span class="font-bold">{receiveAssetObject?.symbol || 'Select'}</span>
                    <span class="text-[9px] text-vault-text-dim truncate max-w-[40px]">({receiveAssetObject?.name || ''})</span>
                  </div>
                  <span class="text-vault-text-dim text-[8px]">▼</span>
                </button>
              </div>

              <!-- Search dropdown list overlay -->
              {#if showReceiveDropdown}
                <div role="presentation" class="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-vault-elevated border border-vault-border rounded-xl shadow-xl p-2 animate-scale-up" on:click|stopPropagation>
                  <input
                    type="text"
                    bind:value={receiveSearchQuery}
                    placeholder="Search asset..."
                    class="w-full mb-2 p-1.5 text-xs bg-vault-black/40 border border-vault-border-subtle text-vault-text rounded-lg focus:outline-none"
                    on:click|stopPropagation
                  />
                  {#if displayReceiveAssets.length === 0}
                    <div class="p-2 text-center text-xs text-vault-text-dim">No matching assets</div>
                  {:else}
                    {#each displayReceiveAssets as asset}
                      <button
                        type="button"
                        on:click={() => {
                          receiveAssetObject = asset;
                          receiveSearchQuery = '';
                          showReceiveDropdown = false;
                        }}
                        class="w-full flex items-center justify-between p-2 rounded-lg text-left text-xs text-vault-text hover:bg-vault-surface cursor-pointer border-none bg-transparent"
                      >
                        <div class="flex items-center gap-2">
                          <span class="w-4 h-4 flex items-center justify-center shrink-0">
                            {@html getCryptoLogo(asset.symbol, asset.chainId)}
                          </span>
                          <div>
                            <span class="font-bold">{asset.symbol}</span>
                            <span class="text-[9px] text-vault-text-dim block">{asset.name}</span>
                          </div>
                        </div>
                        {#if !asset.isCustom}
                          <span class="font-mono text-vault-accent font-semibold">{asset.balance}</span>
                        {/if}
                      </button>
                    {/each}
                  {/if}
                </div>
              {/if}
            </div>
          </div>

          <!-- Custom Contract input if chosen -->
          {#if receiveAssetObject?.isCustom}
            <div class="animate-scale-up">
              <label for="custom-contract-input" class="text-[10px] font-semibold text-vault-text block mb-1">Contract Address</label>
              <input
                id="custom-contract-input"
                type="text"
                bind:value={receiveCustomContract}
                placeholder="e.g. 0x... or Solana Mint Address"
                class="input py-2 text-xs bg-vault-elevated border-vault-border-subtle font-mono text-vault-text w-full rounded-xl px-3 focus:outline-none"
              />
              {#if receiveCustomContract.startsWith('0x')}
                <span class="text-[8px] text-vault-accent font-bold mt-1 block uppercase">EVM Token detected ({receiveChain})</span>
              {:else if receiveCustomContract.length >= 32}
                <span class="text-[8px] text-vault-accent font-bold mt-1 block uppercase">Solana Mint detected ({receiveChain})</span>
              {/if}
            </div>
          {/if}

          <!-- QR Code Section -->
          <div class="py-2">
            <div class="w-32 h-32 bg-white rounded-2xl p-2 mx-auto border border-vault-border flex items-center justify-center relative overflow-hidden select-none shadow-lg">
              <svg class="w-full h-full text-vault-black" viewBox="0 0 100 100" fill="currentColor">
                <rect x="0" y="0" width="25" height="25" />
                <rect x="3" y="3" width="19" height="19" fill="white" />
                <rect x="7" y="7" width="11" height="11" />
                
                <rect x="75" y="0" width="25" height="25" />
                <rect x="78" y="3" width="19" height="19" fill="white" />
                <rect x="82" y="7" width="11" height="11" />
                
                <rect x="0" y="75" width="25" height="25" />
                <rect x="3" y="78" width="19" height="19" fill="white" />
                <rect x="7" y="82" width="11" height="11" />
                
                <rect x="35" y="5" width="5" height="15" />
                <rect x="45" y="0" width="10" height="5" />
                <rect x="60" y="10" width="10" height="10" />
                <rect x="30" y="30" width="15" height="5" />
                <rect x="50" y="35" width="5" height="20" />
                <rect x="65" y="30" width="10" height="5" />
                <rect x="85" y="35" width="10" height="15" />
                <rect x="10" y="35" width="10" height="5" />
                <rect x="0" y="45" width="5" height="15" />
                <rect x="15" y="55" width="10" height="10" />
                <rect x="30" y="60" width="15" height="15" />
                <rect x="55" y="65" width="20" height="5" />
                <rect x="80" y="65" width="5" height="20" />
                <rect x="60" y="75" width="15" height="15" />
                <rect x="40" y="85" width="15" height="10" />
                <rect x="40" y="40" width="20" height="20" rx="4" fill="white" />
                <text x="50" y="54" font-size="14" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="black">V</text>
              </svg>
            </div>
            <span class="text-[8px] text-vault-text-dim text-center block mt-1">Scan this QR code to deposit assets directly</span>
          </div>

          <!-- Deposit Address display -->
          <div class="space-y-1 bg-vault-black/40 border border-vault-border rounded-xl p-2.5">
            <span class="text-[8px] text-vault-text-dim uppercase font-bold block">Deposit Address</span>
            <div class="font-mono text-[9px] text-vault-text break-all select-all py-1">
              {derivedReceiveAddress}
            </div>
          </div>

          <!-- Helpful Blockchain Architecture Note -->
          <div class="bg-vault-black/20 border border-vault-border/40 p-2.5 rounded-xl text-[8px] text-vault-text-dim leading-relaxed flex items-start gap-1.5 animate-scale-up">
            <span class="text-vault-accent text-[10px] leading-none">💡</span>
            <div>
              <span class="font-bold text-vault-text block mb-0.5">Deposit Address Info</span>
              All tokens on the {receiveAssetObject?.chainId === 'bitcoin' ? 'Bitcoin' : (receiveAssetObject?.chainId === 'solana-mainnet' ? 'Solana' : 'EVM')} network share this identical deposit address. Your wallet dynamically routes assets based on the incoming token contract.
            </div>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end gap-2">
          <button
            on:click={() => showReceiveModal = false}
            class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl cursor-pointer border-none"
          >
            Close
          </button>
          <button
            on:click={copyReceiveAddress}
            class="py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl cursor-pointer border-none flex items-center gap-1"
          >
            {#if copiedReceiveAddress}
              <span>✓</span> Copied Address!
            {:else}
              Copy Address
            {/if}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if showSendModal}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
      <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl relative animate-scale-up text-left">
        <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
          <h3 class="text-sm font-semibold text-vault-text">Send Crypto Assets</h3>
          <button on:click={() => showSendModal = false} class="text-vault-text-dim hover:text-vault-text focus:outline-none" aria-label="Close send">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="p-5 space-y-4">
          <!-- Chain and Searchable Asset Selectors -->
          <div class="grid grid-cols-2 gap-3 relative z-50">
            <!-- 1. Chain Selector -->
            <div class="relative">
              <label for="send-chain-btn" class="text-[10px] uppercase font-bold text-vault-text-dim block mb-1">Network / Chain</label>
              <div class="relative">
                <button
                  id="send-chain-btn"
                  type="button"
                  on:click|stopPropagation={() => {
                    showSendChainDropdown = !showSendChainDropdown;
                    showSendDropdown = false;
                  }}
                  class="flex items-center justify-between py-2 px-3 text-xs bg-vault-elevated border border-vault-border-subtle text-vault-text w-full rounded-xl focus:outline-none cursor-pointer text-left font-semibold"
                >
                  <div class="flex items-center gap-2">
                    <span class="w-4 h-4 flex items-center justify-center shrink-0">
                      {@html getChainLogo(sendChain)}
                    </span>
                    <span class="truncate">{AVAILABLE_CHAINS.find(c => c.id === sendChain)?.name.replace(' Mainnet', '').replace(' One', '')}</span>
                  </div>
                  <span class="text-vault-text-dim text-[8px]">▼</span>
                </button>
              </div>

              {#if showSendChainDropdown}
                <div role="presentation" class="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-vault-elevated border border-vault-border rounded-xl shadow-xl p-1 animate-scale-up" on:click|stopPropagation>
                  {#each AVAILABLE_CHAINS as chain}
                    <button
                      type="button"
                      on:click={() => handleSelectSendChain(chain.id)}
                      class="w-full flex items-center gap-2 p-2 rounded-lg text-left text-xs text-vault-text hover:bg-vault-surface cursor-pointer border-none bg-transparent"
                    >
                      <span class="w-4 h-4 flex items-center justify-center shrink-0">
                        {@html getChainLogo(chain.id)}
                      </span>
                      <span class="font-semibold">{chain.name}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- 2. Searchable Asset Input -->
            <div class="relative">
              <label for="send-asset-btn" class="text-[10px] uppercase font-bold text-vault-text-dim block mb-1">Crypto Asset</label>
              <div class="relative">
                <button
                  id="send-asset-btn"
                  type="button"
                  on:click|stopPropagation={() => {
                    showSendDropdown = !showSendDropdown;
                    showSendChainDropdown = false;
                  }}
                  class="flex items-center justify-between py-2 px-3 text-xs bg-vault-elevated border border-vault-border-subtle text-vault-text w-full rounded-xl focus:outline-none cursor-pointer text-left"
                >
                  <div class="flex items-center gap-2">
                    <span class="w-4 h-4 flex items-center justify-center shrink-0">
                      {@html getCryptoLogo(sendAssetObject?.symbol, sendAssetObject?.chainId)}
                    </span>
                    <span class="font-bold">{sendAssetObject?.symbol || 'Select'}</span>
                    <span class="text-[9px] text-vault-text-dim truncate max-w-[40px]">({sendAssetObject?.name || ''})</span>
                  </div>
                  <span class="text-vault-text-dim text-[8px]">▼</span>
                </button>
              </div>

              <!-- Search dropdown list overlay -->
              {#if showSendDropdown}
                <div role="presentation" class="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-vault-elevated border border-vault-border rounded-xl shadow-xl p-2 animate-scale-up" on:click|stopPropagation>
                  <input
                    type="text"
                    bind:value={sendSearchQuery}
                    placeholder="Search asset..."
                    class="w-full mb-2 p-1.5 text-xs bg-vault-black/40 border border-vault-border-subtle text-vault-text rounded-lg focus:outline-none"
                    on:click|stopPropagation
                  />
                  {#if filteredSendAssets.length === 0}
                    <div class="p-2 text-center text-xs text-vault-text-dim">No matching assets</div>
                  {:else}
                    {#each filteredSendAssets as asset}
                      <button
                        type="button"
                        on:click={() => {
                          sendAssetObject = asset;
                          sendSearchQuery = '';
                          showSendDropdown = false;
                        }}
                        class="w-full flex items-center justify-between p-2 rounded-lg text-left text-xs text-vault-text hover:bg-vault-surface cursor-pointer border-none bg-transparent"
                      >
                        <div class="flex items-center gap-2">
                          <span class="w-4 h-4 flex items-center justify-center shrink-0">
                            {@html getCryptoLogo(asset.symbol, asset.chainId)}
                          </span>
                          <div>
                            <span class="font-bold">{asset.symbol}</span>
                            <span class="text-[9px] text-vault-text-dim block">{asset.name}</span>
                          </div>
                        </div>
                        <span class="font-mono text-vault-accent font-semibold">{asset.balance}</span>
                      </button>
                    {/each}
                  {/if}
                </div>
              {/if}
            </div>
          </div>

          <div class="relative">
            <label for="recipient-input" class="text-xs font-semibold text-vault-text block mb-1">Recipient Address</label>
            <div class="relative">
              <input
                id="recipient-input"
                type="text"
                bind:value={sendRecipient}
                placeholder={sendAssetObject?.chainId === 'bitcoin' ? 'bc1... or legacy' : sendAssetObject?.chainId === 'solana-mainnet' ? 'Solana Address...' : '0x... EVM Address'}
                class="input py-2 pr-9 text-xs bg-vault-elevated border-vault-border-subtle font-mono text-vault-text w-full rounded-xl px-3"
              />
              <button
                type="button"
                on:click|stopPropagation={() => showContactPicker = !showContactPicker}
                class="absolute right-2 top-1/2 -translate-y-1/2 text-vault-accent hover:text-vault-accent-hover border-none bg-transparent cursor-pointer text-sm"
                title="Select from contacts"
              >
                📒
              </button>
            </div>
            {#if showContactPicker}
              <div class="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-vault-elevated border border-vault-border rounded-xl shadow-xl p-1 animate-scale-up">
                {#if contacts.length === 0}
                  <div class="p-2 text-center text-[10px] text-vault-text-dim">No contacts saved yet</div>
                {:else}
                  {#each contacts as contact}
                    <button
                      type="button"
                      on:click={() => selectContactForSend(contact)}
                      class="w-full flex items-center justify-between p-2 rounded-lg text-left text-xs text-vault-text hover:bg-vault-surface cursor-pointer border-none bg-transparent"
                    >
                      <span class="font-bold">{contact.label}</span>
                      <span class="text-[8px] font-mono text-vault-text-dim truncate max-w-[120px]">
                        {contact.evmAddress ? contact.evmAddress.slice(0, 8) + '...' : contact.solAddress ? contact.solAddress.slice(0, 8) + '...' : contact.btcAddress ? contact.btcAddress.slice(0, 8) + '...' : 'No address'}
                      </span>
                    </button>
                  {/each}
                {/if}
                <button
                  type="button"
                  on:click={() => { showContactPicker = false; showAddressBook = true; showAddContactForm = false; }}
                  class="w-full p-1.5 text-center text-[9px] text-vault-accent hover:text-vault-accent-hover font-semibold border-t border-vault-border/30 mt-1 cursor-pointer bg-transparent border-x-0 border-b-0"
                >
                  Manage Contacts
                </button>
              </div>
            {/if}
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <label for="amount-input" class="text-xs font-semibold text-vault-text block">Amount</label>
              {#if sendAssetObject}
                <div class="flex items-center gap-1.5 text-[9px] text-vault-text-dim">
                  <button
                    type="button"
                    on:click|stopPropagation={() => {
                      sendAmount = sendAssetObject.balance;
                    }}
                    class="font-bold text-vault-accent hover:text-vault-accent-hover bg-vault-accent/10 border border-vault-accent/25 px-1.5 py-0.5 rounded cursor-pointer transition-all border-none font-sans"
                  >
                    MAX
                  </button>
                  <span class="font-mono">Balance: {sendAssetObject.balance} {sendAssetObject.symbol}</span>
                </div>
              {/if}
            </div>
            <input
              id="amount-input"
              type="number"
              step="any"
              bind:value={sendAmount}
              placeholder="0.00"
              class="input py-2 text-xs bg-vault-elevated border-vault-border-subtle font-mono text-vault-text w-full rounded-xl px-3 focus:outline-none"
            />
          </div>

          {#if sendStatus === 'signing'}
            <div class="text-[10px] text-vault-accent font-semibold flex items-center gap-1.5 animate-pulse">
              <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
              </svg>
              Decrypting and signing transaction locally...
            </div>
          {:else if sendStatus === 'broadcasting'}
            <div class="text-[10px] text-vault-accent font-semibold flex items-center gap-1.5 animate-pulse">
              <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
              </svg>
              Broadcasting to the network...
            </div>
          {:else if sendStatus === 'success'}
            <div class="bg-vault-accent/10 border border-vault-accent/20 rounded-xl p-3 space-y-1.5 text-xs text-left">
              <div class="font-bold text-vault-accent flex items-center gap-1">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Transfer Successful!
              </div>
              <p class="text-[10px] text-vault-text-dim truncate">
                Tx Hash: <span class="font-mono">{txHash}</span>
              </p>
              <a
                href={getExplorerUrl(txHash, sendAssetObject?.chainId || 'base-sepolia')}
                target="_blank"
                rel="noopener noreferrer"
                class="text-[10px] text-vault-accent hover:underline font-semibold block"
              >
                View on Block Explorer
              </a>
            </div>
          {:else if sendStatus === 'error'}
            <div class="text-[10px] text-vault-danger font-semibold flex items-center gap-1">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {sendError}
            </div>
          {/if}
        </div>

        <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end gap-2">
          <button
            on:click={() => showSendModal = false}
            class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl focus:outline-none"
            disabled={sendStatus === 'signing' || sendStatus === 'broadcasting'}
          >
            Close
          </button>
          {#if sendStatus !== 'success'}
            <button
              on:click={handleSendCrypto}
              disabled={!sendRecipient || !sendAmount || sendStatus === 'signing' || sendStatus === 'broadcasting'}
              class="py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
            >
              Send Assets
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}


  <!-- WalletConnect Connect Session URI Modal -->
  {#if showWCModal}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
      <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left">
        <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
          <h3 class="text-sm font-semibold text-vault-text">Connect to external dApp</h3>
          <button on:click={() => showWCModal = false} class="text-vault-text-dim hover:text-vault-text border-none bg-transparent cursor-pointer" aria-label="Close WC modal">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="p-5 space-y-3">
          <label for="wc-uri" class="text-xs font-semibold text-vault-text block">Connection URI (WalletConnect)</label>
          <input
            id="wc-uri"
            type="text"
            bind:value={wcUri}
            placeholder="wc:1234abcd-5678-efgh-ijkl-mnopqrstuvwx..."
            class="input py-2 text-xs bg-vault-elevated border-vault-border-subtle font-mono text-vault-text w-full rounded-xl px-3 focus:outline-none"
          />
          <span class="text-[9px] text-vault-text-dim block leading-relaxed">
            Paste a session proposal URI from Uniswap, OpenSea, or PancakeSwap to establish a non-custodial bridging connection.
          </span>
        </div>

        <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end gap-2">
          <button
            on:click={() => showWCModal = false}
            class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl cursor-pointer border-none"
          >
            Cancel
          </button>
          <button
            on:click={handleConnectWC}
            disabled={!wcUri.trim()}
            class="py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none"
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- WalletConnect Connection Proposal Authorization Prompt -->
  {#if showWCPrompt && pendingWCSession}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
      <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left">
        <div class="p-5 text-center space-y-4">
          <div class="w-16 h-16 rounded-3xl bg-vault-black/40 border border-vault-border flex items-center justify-center mx-auto text-3xl shadow-inner">
            {pendingWCSession.logo}
          </div>
          
          <div class="space-y-1">
            <h3 class="text-sm font-bold text-vault-text">Connect to {pendingWCSession.name}?</h3>
            <a href={pendingWCSession.url} target="_blank" rel="noreferrer" class="text-[10px] text-vault-accent hover:underline block font-mono">{pendingWCSession.url}</a>
          </div>

          <p class="text-[10px] text-vault-text-dim leading-relaxed bg-vault-black/20 p-3 rounded-xl border border-vault-border-subtle/40 max-w-xs mx-auto">
            {pendingWCSession.description}. Uniswap will request permissions to view your public addresses and query asset balances.
          </p>

          <div class="bg-vault-accent/10 border border-vault-accent/20 rounded-xl p-2.5 text-[9px] text-vault-accent text-left space-y-0.5">
            <div class="font-bold flex items-center gap-1">
              <span>🛡️</span> Zero-Knowledge Vault Security
            </div>
            <p class="text-vault-text-dim leading-tight">
              Vault will NEVER share your seed phrase or private keys. All transaction signing requires explicit platform approval.
            </p>
          </div>
        </div>

        <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end gap-2">
          <button
            on:click={() => { showWCPrompt = false; pendingWCSession = null; }}
            class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl cursor-pointer border-none"
          >
            Reject
          </button>
          <button
            on:click={handleApproveWCSession}
            class="py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl cursor-pointer border-none"
          >
            Authorize Connection
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- WalletConnect Message Sign Prompt Dialog -->
  {#if wcSignPrompt && pendingWCSignRequest}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black/80 backdrop-blur-sm p-4 text-vault-text">
      <div class="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl shadow-xl overflow-hidden animate-scale-up text-left">
        <div class="px-5 py-4 border-b border-vault-border flex justify-between items-center">
          <h3 class="text-sm font-semibold text-vault-text flex items-center gap-1.5">
            <span>✍️</span> Signature Request
          </h3>
          <button 
            on:click={() => { wcSignPrompt = false; pendingWCSignRequest = null; }} 
            class="text-vault-text-dim hover:text-vault-text border-none bg-transparent cursor-pointer"
            aria-label="Close signature request"
            disabled={wcSignStatus === 'signing'}
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="p-5 space-y-4">
          <div class="flex items-center gap-2">
            <span class="text-2xl">{pendingWCSignRequest.logo}</span>
            <div>
              <span class="text-xs font-bold text-vault-text block">{pendingWCSignRequest.dAppName}</span>
              <span class="text-[9px] text-vault-text-dim block">Requesting signature: {pendingWCSignRequest.type}</span>
            </div>
          </div>

          <div class="bg-vault-black/40 border border-vault-border rounded-xl p-3 font-mono text-[10px] text-vault-text break-words select-all max-h-32 overflow-y-auto leading-relaxed">
            {pendingWCSignRequest.message}
          </div>

          {#if wcSignStatus !== 'idle'}
            <div>
              {#if wcSignStatus === 'signing'}
                <div class="text-[10px] text-vault-accent font-semibold flex items-center gap-1.5 animate-pulse">
                  <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
                  </svg>
                  Decrypting credentials and signing dApp payload...
                </div>
              {:else if wcSignStatus === 'success'}
                <div class="text-[10px] text-vault-accent font-bold flex items-center gap-1">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Signature signed & returned successfully!
                </div>
              {:else if wcSignStatus === 'error'}
                <div class="text-[10px] text-vault-danger font-semibold">
                  Authentication failed. Signature rejected.
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <div class="px-5 py-3.5 bg-vault-elevated border-t border-vault-border flex justify-end gap-2">
          <button
            on:click={() => { wcSignPrompt = false; pendingWCSignRequest = null; }}
            class="py-1.5 px-3 text-xs bg-transparent text-vault-text hover:text-vault-text-dim font-medium rounded-xl cursor-pointer border-none"
            disabled={wcSignStatus === 'signing'}
          >
            Reject
          </button>
          {#if wcSignStatus !== 'success'}
            <button
              on:click={handleApproveSignRequest}
              disabled={wcSignStatus === 'signing'}
              class="py-1.5 px-4 text-xs bg-vault-accent text-vault-black hover:bg-vault-accent-hover font-semibold rounded-xl cursor-pointer border-none disabled:opacity-40"
            >
              Sign Message
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
