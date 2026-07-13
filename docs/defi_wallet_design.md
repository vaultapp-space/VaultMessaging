# Architecture & Implementation Plan: DeFi Crypto Wallet Integration for Vault

This document outlines the technical design, security model, and step-by-step implementation phases for integrating a zero-knowledge, multi-chain decentralized finance (DeFi) wallet directly into the Vault messaging application.

---

## 1. Architectural Philosophy
In alignment with Vault's core value of **privacy without compromise**, the crypto wallet operates under a **zero-knowledge, non-custodial** model:
* **Zero Server Footprint**: Private keys, seed phrases, and transaction signing keys exist *only* in client-side memory. The Vault server never receives, stores, or processes transaction secrets or wallet credentials.
* **Direct Blockchain RPC**: The client queries blockchain states and broadcasts signed transactions directly to third-party node providers (JSON-RPC), bypassing the application server.
* **Stable coin Focus**: Prioritizes fast, low-cost L2 stablecoins (e.g., USDC on Arbitrum, Base, or Solana) to serve as a private peer-to-peer payment utility.

---

## 2. Core Security & Key Management
```
+-----------------------------------------------------------------+
|                         User Device                             |
|                                                                 |
|  [User Password] -> PBKDF2 -> Derived Key                       |
|                                     |                           |
|  [Encrypted Vault]                  v                           |
|  IndexedDB (Ciphertext) ----> AES-GCM Decrypt -> Seed Phrase    |
|                                                     |           |
|                                                     v           |
|  [Blockchain Node] <--- Broadcast Tx <--- Sign (Private Key)    |
+-----------------------------------------------------------------+
```

### Key Generation (BIP-39 & BIP-44)
1. **Seed Generation**: Generate a secure 12-word mnemonic phrase client-side using cryptographically secure random number generation (`crypto.getRandomValues`).
2. **Key Derivation**: Derive keys for multiple chains using standard HD (Hierarchical Deterministic) paths:
   * **Ethereum/EVM**: `m/44'/60'/0'/0/0`
   * **Solana**: `m/44'/501'/0'/0'`
3. **Storage**:
   * Encrypt the seed phrase using `AES-256-GCM` with a key derived from the user's master passcode/password using `PBKDF2` (100k+ iterations, salted).
   * Persist the encrypted payload in the browser's `IndexedDB`.
   * Optionally integrate `WebAuthn` (biometrics) to store authentication credentials to unlock the key without prompting for the master password every time.

---

## 3. Tech Stack & Client Integration

To support wallet functionality, the following lightweight dependencies will be integrated into the Svelte codebase:
* **Elliptic Curve Math**: `@noble/curves` (zero-dependency, audited implementations of `secp256k1` for EVM and `ed25519` for Solana).
* **Mnemonic Support**: `@scure/bip39` for standards-compliant seed phrases.
* **Blockchain Clients**:
  * **EVM**: `viem` (modern, lightweight alternative to ethers.js for interacting with Arbitrum, Base, Optimism, etc.).
  * **Solana**: `@solana/web3.js` (for transaction packaging on Solana).

---

## 4. Feature Specifications

### A. Balance Fetching & Token Autodiscovery
* **JSON-RPC Calls**: Fetch native asset balances using simple `eth_getBalance` queries.
* **ERC-20/SPL Token Balances**: Call `balanceOf(userAddress)` on token contract addresses.
* **Indexers**: Query third-party indexers (e.g., Alchemy Token API or Moralis) to retrieve all token assets held by the user’s address in a single API call without querying tokens one-by-one.

### B. In-Chat P2P Transactions
* **Address Exchange**: Users can request public keys or addresses over the end-to-end encrypted chat channel.
* **In-Chat Pay**: Clicking the Payment icon in the input bar opens a balance panel, configures a transaction payload, prompts for biometric confirmation, signs the transaction locally, and broadcasts it to the RPC.
* **Message Bubbles**: Post an interactive message template to the chat:
  ```json
  {
    "type": "crypto-payment",
    "network": "base",
    "txHash": "0xabc123...",
    "amount": "10.00",
    "tokenSymbol": "USDC",
    "status": "pending"
  }
  ```
  The receiving client dynamically monitors the transaction status on-chain using the hash and displays a "Confirmed" checkmark when mined.

### C. Gasless Transactions (Account Abstraction)
To eliminate the requirement for users to hold native blockchain gas tokens (like ETH) to pay transaction fees:
* **ERC-4337 (Paymasters)**: Direct user transactions through a bundler network.
* **Fee Payment in Stablecoins**: Allow the user to pay gas fees directly using their USDC balance, keeping transactions seamless.

### D. In-App Swaps
* **Aggregator API**: Fetch swap routes directly from DEX aggregators (like Uniswap/1inch on EVM, or Jupiter on Solana).
* **Execution**: Sign the swap transaction locally and broadcast it, allowing instant exchange between assets (e.g., ETH to USDC) without leaving Vault.

---

## 5. Security & Risk Considerations
1. **Phishing & Address Poisoning**: Implement strict UI warnings to prevent copying malicious contract addresses.
2. **Private Key Loss**: Since Vault is zero-knowledge, key recovery is impossible if the user loses their password/mnemonic. Implement a mandatory "Backup Verification" onboarding flow requiring users to re-verify their seed phrase.
3. **Sandbox Security**: Ensure third-party scripts or dependencies are not allowed execution in the main context to mitigate supply-chain attacks targeting private key theft.

---

## 6. Phase-by-Phase Roadmap

### Phase 1: Key Management & Basic UI
* Setup `@noble/curves` and `@scure/bip39` on the client.
* Build wallet creation / restore flows inside the Settings panel.
* Securely persist encrypted seed phrases in IndexedDB.

### Phase 2: On-chain Balances & Transfers
* Integrate public JSON-RPC providers (e.g., Base/Solana RPCs).
* Build token balance dashboards showing native and ERC-20 balances.
* Implement basic outbound transaction signing and broadcasting.

### Phase 3: Chat Integration & AA
* Wire the Payment payload templates in the chat message bubble.
* Set up a Paymaster client to allow gasless transfers funded or paid in USDC.

### Phase 4: Swaps & Optimization
* Integrate Jupiter / 1inch APIs to support in-app exchanges.
* Secure the storage layer further using WebAuthn biometrics prompts.
