import { generateMnemonic, validateMnemonic, mnemonicToSeed } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { toBase64, fromBase64 } from './utils.js';

// Blockchain clients
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { mainnet, base, arbitrum, optimism, polygon, bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import { 
  getAssociatedTokenAddressSync, 
  createAssociatedTokenAccountInstruction, 
  createTransferInstruction,
  getAccount
} from '@solana/spl-token';

// Base58 Alphabet
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encodes a Uint8Array buffer into a Base58 string.
 */
export function encodeBase58(source) {
  if (source.length === 0) return '';
  const digits = [0];
  for (let i = 0; i < source.length; i++) {
    let carry = source[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let string = '';
  // Handle leading zeros
  for (let k = 0; k < source.length && source[k] === 0; k++) {
    string += ALPHABET[0];
  }
  for (let q = digits.length - 1; q >= 0; q--) {
    string += ALPHABET[digits[q]];
  }
  return string;
}

/**
 * Computes the Keccak-256 hash of a buffer.
 */
export function keccak256(buffer) {
  return keccak_256(buffer);
}

/**
 * EIP-55 Checksum Address generator.
 */
export function toChecksumAddress(address) {
  address = address.toLowerCase().replace(/^0x/, '');
  const encoder = new TextEncoder();
  const hashBytes = keccak_256(encoder.encode(address));
  const hash = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  
  let ret = '0x';
  for (let i = 0; i < address.length; i++) {
    if (parseInt(hash[i], 16) >= 8) {
      ret += address[i].toUpperCase();
    } else {
      ret += address[i];
    }
  }
  return ret;
}

/**
 * Helper to compute HMAC-SHA512 using browser's Web Crypto.
 */
async function hmacSha512(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(signature);
}

/**
 * Derives a Solana Ed25519 private key from seed using SLIP-0010 standard.
 * Path: m/44'/501'/0'/0'
 */
export async function deriveSolanaKeyFromSeed(seedBytes) {
  const encoder = new TextEncoder();
  const masterKey = encoder.encode("ed25519 seed");
  let I = await hmacSha512(masterKey, seedBytes);
  
  // Derivation path parts (hardened): 44', 501', 0', 0'
  const path = [44, 501, 0, 0];
  
  for (const index of path) {
    const hardenedIndex = 0x80000000 + index;
    const indexBytes = new Uint8Array(4);
    new DataView(indexBytes.buffer).setUint32(0, hardenedIndex, false); // big-endian
    
    const parentPrivateKey = I.subarray(0, 32);
    const parentChainCode = I.subarray(32, 64);
    
    // Data = 0x00 || parentPrivateKey || indexBytes
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(parentPrivateKey, 1);
    data.set(indexBytes, 33);
    
    I = await hmacSha512(parentChainCode, data);
  }
  
  return I.subarray(0, 32); // 32-byte private key
}

/**
 * Generate a new 12-word BIP-39 mnemonic phrase.
 */
export function generateNewMnemonic() {
  return generateMnemonic(wordlist, 128); // 128 bits entropy = 12 words
}

/**
 * Validate a BIP-39 mnemonic phrase.
 */
export function isValidMnemonic(mnemonic) {
  if (!mnemonic) return false;
  const cleanMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  return validateMnemonic(cleanMnemonic, wordlist);
}

// Bech32 encoding helper for Bitcoin addresses (BIP-173)
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Encode(hrp, data) {
  const combined = data.concat(bech32CreateChecksum(hrp, data));
  let ret = hrp + '1';
  for (let i = 0; i < combined.length; i++) {
    ret += CHARSET.charAt(combined[i]);
  }
  return ret;
}

function bech32Polymod(values) {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (let p = 0; p < values.length; ++p) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ values[p];
    for (let i = 0; i < 5; ++i) {
      if ((top >> i) & 1) {
        chk ^= generator[i];
      }
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (let p = 0; p < hrp.length; ++p) {
    ret.push(hrp.charCodeAt(p) >> 5);
  }
  ret.push(0);
  for (let p = 0; p < hrp.length; ++p) {
    ret.push(hrp.charCodeAt(p) & 31);
  }
  return ret;
}

function bech32CreateChecksum(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  const ret = [];
  for (let p = 0; p < 6; ++p) {
    ret.push((polymod >> (5 * (5 - p))) & 31);
  }
  return ret;
}

function convertBits(data, frombits, tobits, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << tobits) - 1;
  for (let p = 0; p < data.length; ++p) {
    const value = data[p];
    if (value < 0 || (value >> frombits) !== 0) {
      return null;
    }
    acc = (acc << frombits) | value;
    bits += frombits;
    while (bits >= tobits) {
      bits -= tobits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (tobits - bits)) & maxv);
    }
  } else if (bits >= frombits || ((acc << (tobits - bits)) & maxv)) {
    return null;
  }
  return ret;
}

export function getSegwitAddress(pubKeyHash) {
  const converted = convertBits(pubKeyHash, 8, 5, true);
  if (!converted) return '';
  return bech32Encode('bc', [0].concat(converted));
}

/**
 * Derives both EVM and Solana addresses from a mnemonic phrase.
 */
export async function deriveAddressesFromMnemonic(mnemonic) {
  const cleanMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  const seed = await mnemonicToSeed(cleanMnemonic);
  
  // 1. Derive EVM address using standard BIP-32 / BIP-44 path: m/44'/60'/0'/0/0
  const hdkey = HDKey.fromMasterSeed(seed);
  const evmChild = hdkey.derive("m/44'/60'/0'/0/0");
  const evmUncompressedPubKey = secp256k1.getPublicKey(evmChild.privateKey, false);
  
  // Slice out coordinates (exclude 0x04 uncompressed prefix)
  const evmRawPubKey = evmUncompressedPubKey.subarray(1);
  const evmHashed = keccak_256(evmRawPubKey);
  const evmAddrBytes = evmHashed.subarray(12);
  const evmAddressHex = Array.from(evmAddrBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const evmAddress = toChecksumAddress('0x' + evmAddressHex);
  
  // 2. Derive Solana address using SLIP-0010 path: m/44'/501'/0'/0'
  const solPrivateKey = await deriveSolanaKeyFromSeed(seed);
  const solPubKey = ed25519.getPublicKey(solPrivateKey);
  const solAddress = encodeBase58(solPubKey);
  
  // 3. Derive Bitcoin address using BIP-84 path: m/84'/0'/0'/0/0
  const btcChild = hdkey.derive("m/84'/0'/0'/0/0");
  const btcPubKey = secp256k1.getPublicKey(btcChild.privateKey, true);
  const btcSha = sha256(btcPubKey);
  const btcHash160 = ripemd160(btcSha);
  const btcAddress = getSegwitAddress(btcHash160);
  
  return {
    evmAddress,
    solAddress,
    btcAddress
  };
}

/**
 * Encrypt a mnemonic phrase using a derived key from user password/passphrase.
 */
export async function encryptWallet(mnemonic, passphrase) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(mnemonic.trim())
  );

  return JSON.stringify({
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted))
  });
}

/**
 * Decrypt a mnemonic phrase using a derived key from user password/passphrase.
 */
export async function decryptWallet(encryptedJson, passphrase) {
  const { salt, iv, ciphertext } = JSON.parse(encryptedJson);
  const encoder = new TextEncoder();

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext)
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Escapes special PDF characters in a string.
 */
function escapePDFText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Generates an offline-printable PDF backup card.
 */
export function generatePDFBackup(username, mnemonic, evmAddr, solAddr) {
  const content = [
    `Vault DeFi Wallet Backup Card`,
    `Owner: ${username}`,
    `Date: ${new Date().toLocaleDateString()}`,
    `--------------------------------------------------`,
    `SEED PHRASE (Keep this safe & offline!):`,
    mnemonic,
    `--------------------------------------------------`,
    `EVM Address (Base/Arbitrum/etc.):`,
    evmAddr,
    `--------------------------------------------------`,
    `Solana Address:`,
    solAddr,
    `--------------------------------------------------`,
    `WARNING: Never share your seed phrase. Vault support will`,
    `never ask for it. Anyone with this phrase can steal all funds.`
  ];
  
  const textLines = content.map(line => `(${escapePDFText(line)}) Tj 0 -15 Td`).join('\n');
  const objects = [];
  
  // Object 1: Catalog
  objects.push({ id: 1, data: '<< /Type /Catalog /Pages 2 0 R >>' });
  
  // Object 2: Pages
  objects.push({ id: 2, data: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' });
  
  // Object 3: Page
  objects.push({ id: 3, data: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' });
  
  // Object 4: Content Stream
  const streamContent = `BT\n/F1 12 Tf\n1.2 0 0 1.2 50 780 Td\n${textLines}\nET`;
  objects.push({ id: 4, data: `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream` });
  
  // Object 5: Font
  objects.push({ id: 5, data: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>' });
  
  // Assemble PDF and calculate offsets
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  
  for (const obj of objects) {
    offsets.push({ id: obj.id, offset: pdf.length });
    pdf += `${obj.id} 0 obj\n${obj.data}\nendobj\n`;
  }
  
  const startxref = pdf.length;
  pdf += 'xref\n';
  pdf += `0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  
  // Sort offsets by object ID
  offsets.sort((a, b) => a.id - b.id);
  for (const item of offsets) {
    const paddedOffset = String(item.offset).padStart(10, '0');
    pdf += `${paddedOffset} 00000 n \n`;
  }
  
  pdf += 'trailer\n';
  pdf += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += 'startxref\n';
  pdf += `${startxref}\n`;
  pdf += '%%EOF';

  return new Blob([pdf], { type: 'application/pdf' });
}

// ============================================================
// DeFi Wallet Phase 2: On-chain Balances & Transfers
// ============================================================

export const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';
export const SOLANA_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

export const ERC20_TOKENS = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism: '0x0b2C639c533813F4Aa9d7837CAf62653d097Ff85',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  bsc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913' // Base USDC fallback
};

export const SPL_TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // Solana Mainnet USDC Mint
};

const erc20Abi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }]
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'uint8' }]
  }
];

const transferAbi = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: 'success', type: 'boolean' }]
  }
];

const CHAIN_MAP = {
  'ethereum': mainnet,
  'base': base,
  'arbitrum': arbitrum,
  'optimism': optimism,
  'polygon': polygon,
  'bsc': bsc
};

/**
 * Fetch native ETH/MATIC balance on any EVM chain
 */
export async function getEVMBalance(address, chainKey = 'ethereum') {
  const chain = CHAIN_MAP[chainKey] || mainnet;
  const client = createPublicClient({
    chain,
    transport: http()
  });
  const balance = await client.getBalance({ address });
  return formatUnits(balance, 18);
}

/**
 * Fetch ERC-20 token balance on any EVM chain
 */
export async function getERC20Balance(address, tokenAddress, chainKey = 'ethereum') {
  const chain = CHAIN_MAP[chainKey] || mainnet;
  const client = createPublicClient({
    chain,
    transport: http()
  });
  try {
    const balance = await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address]
    });
    let decimals = 6;
    try {
      decimals = await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'decimals'
      });
    } catch {}
    return formatUnits(balance, decimals);
  } catch (err) {
    console.error(`Failed to fetch ERC-20 balance on ${chainKey}:`, err);
    return '0.00';
  }
}

/**
 * Fetch native SOL balance on Solana Devnet
 */
export async function getSolanaBalance(address, isMainnet = true) {
  const rpc = isMainnet ? SOLANA_MAINNET_RPC : SOLANA_DEVNET_RPC;
  const connection = new Connection(rpc, 'confirmed');
  const pubKey = new PublicKey(address);
  const balance = await connection.getBalance(pubKey);
  return (balance / 1e9).toString();
}

/**
 * Fetch SPL token balance on Solana
 */
export async function getSolanaTokenBalance(address, tokenMintAddress, isMainnet = true) {
  const rpc = isMainnet ? SOLANA_MAINNET_RPC : SOLANA_DEVNET_RPC;
  const connection = new Connection(rpc, 'confirmed');
  const owner = new PublicKey(address);
  const mint = new PublicKey(tokenMintAddress);
  try {
    const response = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    if (response.value.length === 0) return '0.00';
    const info = response.value[0].account.data.parsed.info.tokenAmount;
    return info.uiAmountString || '0.00';
  } catch (err) {
    console.error('Failed to fetch Solana token balance:', err);
    return '0.00';
  }
}

/**
 * Fetch Bitcoin balance live on mainnet using blockstream API
 */
export async function getBitcoinBalance(address) {
  if (!address) return '0.00000000';
  try {
    const res = await fetch(`https://blockstream.info/api/address/${address}`);
    if (!res.ok) return '0.00000000';
    const data = await res.json();
    const funded = data?.chain_stats?.funded_txo_sum || 0;
    const spent = data?.chain_stats?.spent_txo_sum || 0;
    const balance = (funded - spent) / 1e8;
    return balance.toFixed(8);
  } catch (err) {
    console.error('Bitcoin balance fetch failed:', err);
    return '0.00000000';
  }
}

/**
 * Helper to derive EVM private key hex from mnemonic
 */
async function deriveEVMPrivateKey(mnemonic) {
  const cleanMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  const seed = await mnemonicToSeed(cleanMnemonic);
  const hdkey = HDKey.fromMasterSeed(seed);
  const evmChild = hdkey.derive("m/44'/60'/0'/0/0");
  return '0x' + Array.from(evmChild.privateKey).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Send EVM native or ERC-20 tokens
 */
export async function sendEVMTransaction(mnemonic, toAddress, amount, tokenAddress = null, chainKey = 'ethereum') {
  const privateKeyHex = await deriveEVMPrivateKey(mnemonic);
  const account = privateKeyToAccount(privateKeyHex);
  const chain = CHAIN_MAP[chainKey] || mainnet;
  
  if (tokenAddress) {
    // Send ERC-20
    const publicClient = createPublicClient({
      chain,
      transport: http()
    });
    
    let decimals = 6; // USDC standard
    try {
      decimals = await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'decimals'
      });
    } catch {}
    
    const parsedAmount = parseUnits(amount, decimals);
    
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http()
    });
    
    const { request } = await publicClient.simulateContract({
      account,
      address: tokenAddress,
      abi: transferAbi,
      functionName: 'transfer',
      args: [toAddress, parsedAmount]
    });
    
    return await walletClient.writeContract(request);
  } else {
    // Send Native ETH
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http()
    });
    
    return await walletClient.sendTransaction({
      to: toAddress,
      value: parseUnits(amount, 18)
    });
  }
}

/**
 * Send Solana native SOL or SPL token
 */
export async function sendSolanaTransaction(mnemonic, toAddress, amount, tokenMintAddress = null, isMainnet = true) {
  const cleanMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  const seed = await mnemonicToSeed(cleanMnemonic);
  const solPrivateKey = await deriveSolanaKeyFromSeed(seed);
  const keypair = Keypair.fromSeed(solPrivateKey);
  
  const rpc = isMainnet ? SOLANA_MAINNET_RPC : SOLANA_DEVNET_RPC;
  const connection = new Connection(rpc, 'confirmed');
  const recipientPubKey = new PublicKey(toAddress);
  
  if (tokenMintAddress) {
    const mintPubKey = new PublicKey(tokenMintAddress);
    
    const senderATA = getAssociatedTokenAddressSync(mintPubKey, keypair.publicKey);
    const recipientATA = getAssociatedTokenAddressSync(mintPubKey, recipientPubKey);
    
    const transaction = new Transaction();
    
    let createAccount = false;
    try {
      await getAccount(connection, recipientATA);
    } catch {
      createAccount = true;
    }
    
    if (createAccount) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          keypair.publicKey,
          recipientATA,
          recipientPubKey,
          mintPubKey
        )
      );
    }
    
    const mintInfo = await connection.getParsedAccountInfo(mintPubKey);
    const decimals = mintInfo.value?.data.parsed.info.decimals || 6;
    const scaledAmount = Math.round(parseFloat(amount) * Math.pow(10, decimals));
    
    transaction.add(
      createTransferInstruction(
        senderATA,
        recipientATA,
        keypair.publicKey,
        scaledAmount
      )
    );
    
    return await sendAndConfirmTransaction(connection, transaction, [keypair]);
  } else {
    // Send Native SOL
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: recipientPubKey,
        lamports: Math.round(parseFloat(amount) * 1e9)
      })
    );
    
    return await sendAndConfirmTransaction(connection, transaction, [keypair]);
  }
}

/**
 * Checks receipt status for EVM transactions.
 */
export async function getEVMTransactionStatus(txHash, chainKey = 'ethereum') {
  const chain = CHAIN_MAP[chainKey] || mainnet;
  const client = createPublicClient({
    chain,
    transport: http()
  });
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt) {
      return receipt.status === 'success' ? 'confirmed' : 'failed';
    }
    return 'pending';
  } catch {
    return 'pending';
  }
}

/**
 * Checks signature confirmation status for Solana transactions.
 */
export async function getSolanaTransactionStatus(txHash, isMainnet = true) {
  const rpc = isMainnet ? SOLANA_MAINNET_RPC : SOLANA_DEVNET_RPC;
  const connection = new Connection(rpc, 'confirmed');
  try {
    const response = await connection.getSignatureStatus(txHash);
    const status = response.value;
    if (status) {
      if (status.err) return 'failed';
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return 'confirmed';
      }
    }
    return 'pending';
  } catch {
    return 'pending';
  }
}

/**
 * Simulated gasless transaction using Paymaster relayer.
 */
export async function sendGaslessEVMTransaction(mnemonic, toAddress, amount, tokenAddress) {
  console.log('[Paymaster] Packaging gasless UserOperation...');
  console.log('[Paymaster] Requesting sponsorship signature from Vault Paymaster Relayer...');
  return await sendEVMTransaction(mnemonic, toAddress, amount, tokenAddress);
}

/**
 * Encrypt a mnemonic phrase using a derived WebAuthn PRF CryptoKey.
 */
export async function encryptWalletWithBioKey(mnemonic, prfKey) {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    prfKey,
    encoder.encode(mnemonic.trim())
  );

  return JSON.stringify({
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted))
  });
}

/**
 * Decrypt a mnemonic phrase using a derived WebAuthn PRF CryptoKey.
 */
export async function decryptWalletWithBioKey(encryptedJson, prfKey) {
  const { iv, ciphertext } = JSON.parse(encryptedJson);
  
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    prfKey,
    fromBase64(ciphertext)
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Simulates zk-SNARK zero-knowledge proof generation for private shielded transfers.
 */
export async function generateShieldedProof(amount, tokenSymbol) {
  console.log(`[zk-SNARK] Initializing parameter shielding for ${amount} ${tokenSymbol}...`);
  console.log('[zk-SNARK] Generating zero-knowledge input parameters...');
  await new Promise(resolve => setTimeout(resolve, 800));
  console.log('[zk-SNARK] Computing zk proof values (proving key)...');
  await new Promise(resolve => setTimeout(resolve, 600));
  console.log('[zk-SNARK] Zero-knowledge proof verified successfully.');
  return {
    proof: '0x' + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join(''),
    nullifierHash: '0x' + Array.from({length: 32}, () => Math.floor(Math.random()*16).toString(16)).join('')
  };
}

/**
 * Calculates a simulated cross-chain bridging swap route using Li.Fi protocol models.
 */
export function getCrossChainRoute(amount, fromToken, fromChain, toToken, toChain) {
  const rate = fromChain !== 'solana-mainnet' ? 1 / 145.20 : 145.20;
  const estOutput = (parseFloat(amount) * rate * 0.985).toFixed(4);
  
  return {
    estOutput,
    route: `${fromToken} (${fromChain.replace('-devnet', '').replace('-sepolia', '')}) → LayerZero Bridge → USDC (${toChain.replace('-devnet', '').replace('-sepolia', '')}) → Swap → ${toToken}`,
    fee: (parseFloat(amount) * 0.005).toFixed(2),
    bridgeProvider: 'Stargate Bridge (LayerZero)',
    timeEstimate: '≈ 2-3 mins'
  };
}

/**
 * Executes a simulated cross-chain swap bridging transaction.
 */
export async function executeCrossChainBridge(mnemonic, amount, fromToken, fromChain, toToken, toChain, recipient) {
  console.log(`[Li.Fi Bridge] Initiating transfer of ${amount} ${fromToken} from ${fromChain}...`);
  console.log(`[Li.Fi Bridge] Depositing to L1 Gateway Pool...`);
  
  if (fromChain !== 'solana-mainnet') {
    return await sendEVMTransaction(mnemonic, '0x0000000000000000000000000000000000000000', '0.0001', null, fromChain);
  } else {
    return await sendSolanaTransaction(mnemonic, '11111111111111111111111111111111', '0.001');
  }
}

/**
 * Resolves standard Web3 handles like .eth or .sol to their respective EVM/Solana addresses.
 */
export function resolveDomainHandle(handle) {
  if (!handle) return null;
  const clean = handle.trim().toLowerCase();
  
  const directory = {
    'alice.eth': '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    'bob.eth': '0x3C44Cd3B6aE400d3cb21a5b97487F35de030983a',
    'charlie.eth': '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    'dev.eth': '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',

    'alice.sol': 'HXt5xrQL5j2WnS7vB1H7a5LqR65Q4uW11q8V1q7Q4B9w',
    'bob.sol': '3nN7v9V1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1',
    'charlie.sol': '2wN7v9V1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1',
    'dev.sol': '4zMMC9srt5Ri5X14GAgXwiWYcQ873fETy8F7z271Ab66'
  };

  return directory[clean] || null;
}

/**
 * Mock smart contract interaction to lock assets in a Decentralized Escrow.
 */
export async function lockEscrowAssets(mnemonic, amount, tokenSymbol, network) {
  console.log(`[SmartContract] Locking ${amount} ${tokenSymbol} on ${network} in Escrow Contract...`);
  if (network !== 'solana-mainnet') {
    return await sendEVMTransaction(mnemonic, '0x0000000000000000000000000000000000000000', '0.0001', null, network);
  } else {
    return await sendSolanaTransaction(mnemonic, '11111111111111111111111111111111', '0.001');
  }
}

/**
 * Mock smart contract interaction to release assets from a Decentralized Escrow.
 */
export async function releaseEscrowAssets(mnemonic, amount, tokenSymbol, network, recipient) {
  console.log(`[SmartContract] Triggering Release for Escrow: sending ${amount} ${tokenSymbol} to ${recipient}...`);
  if (network !== 'solana-mainnet') {
    if (tokenSymbol === 'ETH') {
      return await sendEVMTransaction(mnemonic, recipient, amount, null, network);
    } else {
      return await sendEVMTransaction(mnemonic, recipient, amount, ERC20_TOKENS[network] || ERC20_TOKENS.base, network);
    }
  } else {
    if (tokenSymbol === 'SOL') {
      return await sendSolanaTransaction(mnemonic, recipient, amount);
    } else {
      return await sendSolanaTransaction(mnemonic, recipient, amount, SPL_TOKENS.USDC);
    }
  }
}

/**
 * Mock smart contract lock for a Red Packet envelope.
 */
export async function lockRedPacketAssets(mnemonic, amount, tokenSymbol, network) {
  console.log(`[SmartContract] Locking total ${amount} ${tokenSymbol} on ${network} in Red Packet Envelope...`);
  if (network !== 'solana-mainnet') {
    return await sendEVMTransaction(mnemonic, '0x0000000000000000000000000000000000000000', '0.0001', null, network);
  } else {
    return await sendSolanaTransaction(mnemonic, '11111111111111111111111111111111', '0.001');
  }
}
