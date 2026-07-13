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
2. **First-Time Backup & Verification Flow**:
   * **Mandatory Disclosure**: When the wallet is initialized for the first time, the 12-word seed phrase is presented on a blurred card with high-importance layout warnings advising users that losing the key means permanent loss of funds.
   * **Clipboard Copy**: Add an action button allowing the user to copy the seed phrase to their clipboard.
   * **Mandatory Verification Screen**: To ensure the user has saved the phrase offline, the app requires the user to input or tap the generated words in the correct sequential order. The creation flow will be blocked until verification succeeds.
   * **Printable Backup Option**: Offer a "Save Backup Card" option that compiles the seed phrase and public address into an offline-printable PDF file.
3. **Key Derivation**: Derive keys for multiple chains using standard HD (Hierarchical Deterministic) paths:
   * **Ethereum/EVM**: `m/44'/60'/0'/0/0`
   * **Solana**: `m/44'/501'/0'/0'`
4. **Storage**:
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

### E. Hardware Wallet Support (Ledger / Trezor)
For users who manage high-value portfolios and require maximum physical security:
* **How it works**: Integrate Ledger’s WebUSB transport or Trezor's Connect API.
* **Flow**: The private keys remain isolated inside the hardware device. The Vault client reads the public address to display balances, but whenever a payment or token transfer is initiated, the transaction payload is sent to the physical device. The user signs it physically, and the signed transaction is broadcasted back from the browser.

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

---

## 7. Advanced DeFi & Privacy Extensions

To build a truly next-generation communication and payment hub, the following advanced ideas can be incorporated into the design:

### A. Decentralized Escrow Smart Contracts (Trustless OTC)
To enable users to trade digital goods or assets safely inside anonymous chats:
* **How it works**: A lightweight, audited smart contract functions as an Escrow.
* **Flow**: The seller locks their tokens/assets in the escrow contract from the chat. The contract automatically listens for the matching payment from the buyer. Once the payment is verified, the escrow releases the assets to the buyer, preventing fraud without relying on a centralized intermediary.

### B. Token-Gated Group Chats
To support DAOs, Web3 alpha channels, and premium subscription-like chat rooms:
* **How it works**: When a user requests to join or view a group chat, their public address is cryptographically verified to ensure they own a specific NFT or hold a minimum amount of a target token (e.g., ERC-20/SPL). If their balance falls below the threshold, they are automatically pruned from the active group membership.

### C. On-chain Privacy Rails (zk-SNARK integrations)
Public blockchains (like Ethereum or Solana) expose transaction histories publicly. To align with Vault's absolute privacy focus:
* **How it works**: Integrate client-side zk-SNARK protocols (like Railgun, Tornado, or Solana's token-2022 confidential transfer extensions).
* **Benefit**: Allows users to send and receive crypto assets inside Vault chats without revealing the linkage between their messaging profile, sending address, and receiving address on the public ledger.

### D. Crypto "Red Packets" (Airdrop Envelopes)
An interactive community feature for group chats:
* **How it works**: A user places a set amount of crypto (e.g., 50 USDC) inside an "envelope" contract and sends it to a group chat. They specify how many users can claim it (e.g., 5 users). Other members of the group can click the envelope in the chat bubble to claim their random or equal share of the funds instantly to their local wallet.

### E. Web3 Domain Resolvers (ENS / SNS)
* **How it works**: Standard public keys are long and difficult to read. The client can integrate ENS (Ethereum Name Service) or SNS (Solana Name Service) resolution. 
* **Benefit**: Users can type standard domain handles like `alice.eth` or `bob.sol` instead of a 42-character hex address, resolving public keys securely via smart contracts.

---

## 8. Universal Chain Architecture & Gateway Upgrades

To build a wallet capable of sending, receiving, and interacting with **every crypto token across all blockchains** seamlessly:

### A. Unified Cross-Chain Routing (Li.Fi / Socket)
* **Problem**: Alice holds USDC on Arbitrum, but Bob only wants SOL on Solana. Standard crypto transactions fail if users are on different chains.
* **Solution**: Integrate cross-chain routing engines (e.g., Li.Fi SDK or Socket).
* **Flow**: The client automatically routes, swaps, and bridges the token in a single user transaction. Alice clicks "Send 10 USDC" from her Arbitrum balance; Bob automatically receives the equivalent amount of SOL in his Solana address. The complex bridging is abstracted away in the background.

### B. WalletConnect Integration (Gateway to the dApp Ecosystem)
* **What it adds**: Allows Vault to connect to *any* external Web3 website (OpenSea, Uniswap, Aave).
* **How it works**: Integrate the standard `WalletConnect` protocol client-side.
* **UX**: When a user visits a Web3 website on their desktop, they choose "Connect Wallet Connect" and scan the QR code using Vault's camera. The site sends signing requests to Vault over a secure websocket, which the user can approve or reject locally.

### C. Unified Multi-Chain QR Codes
* **What it adds**: A single QR code that stands for the user's entire Web3 presence.
* **How it works**: The client derives public keys for multiple chains (EVM, Solana, Bitcoin, Cosmos) from the same master seed.
* **UX**: When displaying the receive modal, Vault shows a single, unified QR code. When the sending app scans it, it detects the specific token selected and uses the corresponding blockchain address automatically.

### D. Fiat On/Off-Ramps (MoonPay / Transak / Stripe)
* **What it adds**: Simple purchase rails for non-crypto users.
* **How it works**: Integrate iframe or widget SDKs for fiat-to-crypto gateways (like MoonPay, Transak, or Stripe Crypto).
* **UX**: Users can buy stablecoins or native crypto using credit cards, Apple Pay, or standard bank transfers directly within Vault's settings.

### E. Social & Multisig Recovery (Social Trust Backup)
* **Problem**: In zero-knowledge apps, losing the seed phrase or password means funds are lost forever.
* **Solution**: Implement Multisig (using Safe/Gnosis contracts) and Social Recovery keys.
* **Flow**: Users can designate "Guardians" (trusted Vault contacts). If they lose their key, they can request their Guardians to sign a recovery transaction that resets their wallet signing key, restoring access without server intervention.
