<script>
  import { activeView } from '../lib/stores/session.js';
  import { onMount } from 'svelte';
  import { applyTheme } from '../lib/theme.js';

  let isLight = false;
  let techOpen = false;
  let faqMode = 'simple';

  function goToApp() {
    activeView.set('auth');
  }

  function toggleTheme() {
    isLight = !isLight;
    const theme = isLight ? 'light' : 'dark';
    applyTheme(theme);
    localStorage.setItem('vault_theme', theme);
  }

  function toggleTech() {
    techOpen = !techOpen;
  }

  onMount(() => {
    isLight = document.documentElement.classList.contains('light');
  });
</script>

<div class="vault-landing">
  <div class="bg-field"></div>

  <div class="nav-shell">
    <div class="wrap">
      <nav class="top">
        <div class="brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="logo-mark">
            <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
            <path d="M12 22V12" stroke-dasharray="3 3" />
          </svg>
          Vault
          <span class="beta-pill">BETA</span>
        </div>
        <div class="links">
          <a href="#how">How it works</a>
          <a href="#compare">Compare</a>
          <a href="#features">Features</a>
          <a href="#faq">FAQ</a>
          <button class="theme-toggle" on:click={toggleTheme} aria-label="Toggle light/dark theme" title="Toggle light/dark theme">◐</button>
          <button class="cta-small" on:click={goToApp}>Start a private chat</button>
        </div>
      </nav>
    </div>
  </div>

  <div class="wrap">
    <section class="hero" style="border-top:none;">
      <div class="hero-inner">
        <h1>A conversation only the two of you can ever read.</h1>
        <p class="sub">No phone number. No email. Nothing to hand over, because we never collect it. Messages lock on your device and disappear after 24 hours.</p>
        <div class="actions">
          <button class="btn-primary" on:click={goToApp}>Start a private chat — free</button>
          <a class="btn-ghost" href="#how">See how it works ↓</a>
        </div>
        <p class="hero-microcopy">Works right in your browser. No install, no app store.</p>
        <div class="trust-row">
          <div class="trust-item"><span class="chk">✓</span> No sign-up info to leak</div>
          <div class="trust-item"><span class="chk">✓</span> Locked before it leaves your phone</div>
          <div class="trust-item"><span class="chk">✓</span> Gone in 24 hours</div>
        </div>
        <div class="community-row">
          <span class="community-label">Join the community</span>
          <div class="community-links">
            <a href="https://discord.gg/VZyvTsJcFQ" target="_blank" rel="noopener noreferrer">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.522 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>
              Discord
            </a>
            <a href="https://x.com/VaultMessenger" target="_blank" rel="noopener noreferrer">✖️ Twitter</a>
          </div>
        </div>
      </div>
    </section>

    <section id="preview" style="border-top:none; padding-top: 8px; text-align: center;">
      <p class="preview-caption">A real conversation, encrypted end-to-end</p>
      <div class="chat-mock">
        <div class="bubble-row in">
          <div class="bubble">hey, you free to talk tonight?</div>
          <div class="bubble-meta"><span class="dot"></span>encrypted · disappears in 23:41:07</div>
        </div>
        <div class="bubble-row out">
          <div class="bubble">yeah — this app's actually kind of nice, no number or anything needed</div>
          <div class="bubble-meta"><span class="dot"></span>encrypted · disappears in 23:58:52</div>
        </div>
        <div class="bubble-row in">
          <div class="bubble">wait for real? not even Vault can see this?</div>
          <div class="bubble-meta"><span class="dot"></span>encrypted · disappears in 23:59:14</div>
        </div>
      </div>
    </section>

    <section id="how">
      <div class="section-head">
        <div class="eyebrow">How it works</div>
        <h2>Three things happen. We're only ever holding a locked box.</h2>
        <p>No math, no key exchange diagrams — just what actually happens when you hit send.</p>
      </div>
      <div class="steps">
        <div class="step">
          <div class="num">One</div>
          <h3>You write a message</h3>
          <p>It's locked on your own device, using a key that never leaves it — before it ever touches our servers.</p>
        </div>
        <div class="step">
          <div class="num">Two</div>
          <h3>It travels sealed</h3>
          <p>Our servers move the locked box from one device to the other. We can see it exists — never what's inside.</p>
        </div>
        <div class="step">
          <div class="num">Three</div>
          <h3>Only they can open it</h3>
          <p>Your friend's device holds the one key that fits. We never had a copy, so we can't hand one over — to anyone.</p>
        </div>
      </div>
      <div class="tech-footnote">
        <span>Technically: X3DH key exchange + the Double Ratchet, the same cryptography Signal uses.</span>
        <button class="tech-link" on:click={toggleTech}>{techOpen ? 'Hide technical details ↑' : 'Read the technical details →'}</button>
      </div>
      <div class="tech-details-panel" class:open={techOpen}>
        <div class="tech-details-inner">
          <h4>Key exchange — X3DH</h4>
          <p>Before you've ever messaged someone, your device publishes a bundle of public keys to the server: an <code>identity key</code>, a <code>signed prekey</code>, and a batch of one-time <code>prekeys</code>. When a friend wants to message you — even while you're offline — their device fetches that bundle and runs four Diffie-Hellman exchanges against it (X3DH: Extended Triple Diffie-Hellman) to derive a shared secret neither of you has typed or transmitted anywhere.</p>
          <h4>Per-message encryption — the Double Ratchet</h4>
          <p>Every message advances a symmetric-key ratchet, so each one is locked with its own unique key derived from the last. Each time the conversation changes direction, a fresh Diffie-Hellman exchange folds a new secret into that chain. The result: even if a single message key were somehow exposed, it wouldn't unlock any message before or after it.</p>
          <h4>What actually gets encrypted</h4>
          <p>Message bodies are sealed with <code>AES-256-GCM</code> using keys derived via <code>HKDF</code>. Your local vault (session state, drafts, cached keys) is protected with <code>Argon2id</code> against your password. All of this runs in your browser via the Web Crypto API — plaintext and raw key material never leave your device.</p>
          <h4>Calls — WebRTC over TURN</h4>
          <p>Voice and video use WebRTC, encrypted end-to-end with <code>DTLS-SRTP</code> over a key negotiated through your Double Ratchet session. Media is routed through our <code>TURN</code> relay rather than connecting peer-to-peer, which means neither side ever learns the other's IP address or general location — the relay only ever sees encrypted packets.</p>
          <button class="tech-close" on:click={toggleTech}>Hide details ↑</button>
        </div>
      </div>
    </section>

    <section id="compare">
      <div class="section-head">
        <div class="eyebrow">How Vault compares</div>
        <h2>The parts of "private" that are easy to skip.</h2>
      </div>
      <div class="table-scroll">
        <table class="compare">
          <thead>
            <tr><th>&nbsp;</th><th class="brandcol">Vault</th><th>Signal</th><th>Telegram</th><th>WhatsApp</th></tr>
          </thead>
          <tbody>
            <tr><td>Asks for your phone number</td><td class="yes">Never</td><td class="no">Required</td><td class="no">Required</td><td class="no">Required</td></tr>
            <tr><td>Private by default, no toggle</td><td class="yes">Yes</td><td class="yes">Yes</td><td class="no">Only in "Secret Chat"</td><td class="yes">Yes</td></tr>
            <tr><td>New lock generated per message</td><td class="yes">Yes</td><td class="yes">Yes</td><td class="no">Secret chats only</td><td class="yes">Yes</td></tr>
            <tr><td>Anyone can inspect the code</td><td class="yes">Yes</td><td class="yes">Yes</td><td class="no">Partial</td><td class="no">No</td></tr>
            <tr><td>Messages expire automatically</td><td class="yes">Every message, 24h</td><td class="no">Opt-in</td><td class="no">Opt-in</td><td class="no">Opt-in</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="features">
      <div class="section-head">
        <div class="eyebrow">What you get</div>
        <h2>Built so there's simply nothing of yours to lose.</h2>
      </div>
      <div class="feature-grid">
        <div class="feature">
          <div class="plate">GROUPS</div>
          <h3>Group chats stay private</h3>
          <p>Every member gets their own lock — a large group is never a weak point.</p>
        </div>
        <div class="feature">
          <div class="plate">FILES</div>
          <h3>Share files without a trace</h3>
          <p>Photos and files travel straight between devices, encrypted the whole way — never stored in the open.</p>
        </div>
        <div class="feature">
          <div class="plate">CALLS</div>
          <h3>Calls no one can listen to</h3>
          <p>Locked with a key only the two of you hold. Calls route through our relay, so the other person never sees your IP address or location.</p>
        </div>
        <div class="feature">
          <div class="plate">SIGN-IN</div>
          <h3>Unlock with your face or fingerprint</h3>
          <p>No password to steal or forget. Your device's own lock protects the key.</p>
        </div>
        <div class="feature">
          <div class="plate">DEVICES</div>
          <h3>Add a device with a scan</h3>
          <p>Point your phone at a QR code to bring a laptop or tablet in — no account transfer, no new password.</p>
        </div>
        <div class="feature">
          <div class="plate">MEMORY</div>
          <h3>Nothing lingers after you close it</h3>
          <p>Close the tab and your keys are erased, not just hidden — there's nothing left to recover.</p>
        </div>
      </div>
    </section>

    <section id="showcase">
      <div class="section-head">
        <div class="eyebrow">See it for yourself</div>
        <h2>The actual app — on your desktop and in your pocket.</h2>
      </div>
      <div class="showcase-grid">
        <figure class="showcase-desktop">
          <img src="/landing-app-preview.png" alt="Vault desktop app showing an encrypted conversation with an active end-to-end encrypted call" loading="lazy" />
          <figcaption>Desktop</figcaption>
        </figure>
        <figure class="showcase-mobile">
          <img src="/landing-mobile-preview.png" alt="Vault mobile app showing the same encrypted conversation" loading="lazy" />
          <figcaption>Mobile</figcaption>
        </figure>
      </div>
    </section>

    <section id="faq">
      <div class="section-head">
        <div class="eyebrow">Questions</div>
        <h2>Whatever level of detail you want.</h2>
        <div class="faq-toggle">
          <button class:active={faqMode === 'simple'} on:click={() => faqMode = 'simple'}>In plain terms</button>
          <button class:active={faqMode === 'tech'} on:click={() => faqMode = 'tech'}>Technical details</button>
        </div>
      </div>

      <div class="faq-panel" class:active={faqMode === 'simple'}>
        <details class="faq-item" open>
          <summary>Can anyone at Vault read my messages?</summary>
          <p>No. Your messages are locked on your device with a key we never receive. Even if someone asked us to hand over a conversation, we'd have nothing readable to give them.</p>
        </details>
        <details class="faq-item">
          <summary>What happens if I lose my password?</summary>
          <p>Your key lives on your device, protected by your password — we don't keep a backup copy on our servers, on purpose. If you lose both, that conversation history can't be recovered. You can opt into an encrypted backup ahead of time if you want a safety net.</p>
        </details>
        <details class="faq-item">
          <summary>Is this really free?</summary>
          <p>Yes. Vault is free to use, and the code is open for anyone to inspect.</p>
        </details>
        <details class="faq-item">
          <summary>What if Vault's servers go down?</summary>
          <p>New messages can't send until they're back — but nothing already delivered to your device is affected, and nothing is exposed while it's down.</p>
        </details>
      </div>

      <div class="faq-panel" class:active={faqMode === 'tech'}>
        <details class="faq-item" open>
          <summary>What key exchange protocol does Vault use?</summary>
          <p>Sessions are bootstrapped with X3DH (Extended Triple Diffie-Hellman) against pre-published identity, signed prekey, and one-time prekey bundles, allowing asynchronous session establishment with an offline recipient.</p>
        </details>
        <details class="faq-item">
          <summary>How is forward secrecy maintained?</summary>
          <p>Post-handshake messaging uses the Double Ratchet: a per-message symmetric-key ratchet combined with a Diffie-Hellman ratchet on each direction change, so compromise of one message key doesn't expose past or future messages.</p>
        </details>
        <details class="faq-item">
          <summary>Is Vault open source?</summary>
          <p>The client and server source are publicly viewable; a formal open-source license is being finalized.</p>
        </details>
        <details class="faq-item">
          <summary>Can I self-host it?</summary>
          <p>Not yet — Vault currently runs on centralized infrastructure with no peer-to-peer fallback. Self-hosting is on the roadmap.</p>
        </details>
      </div>
    </section>

    <section class="final-cta" style="border-top:none;">
      <h2>Say it once. Then let it disappear.</h2>
      <p>No number, no email, no history left behind — just a private conversation.</p>
      <div class="actions">
        <button class="btn-primary" on:click={goToApp}>Start a private chat — free</button>
      </div>
    </section>
  </div>

  <footer>
    <div class="wrap row">
      <span>© 2026 Vault</span>
      <div class="footer-links">
        <a href="https://github.com/vaultapp-space/VaultMessaging" target="_blank" rel="noopener noreferrer">Source code</a>
      </div>
    </div>
  </footer>
</div>

<style>
  .vault-landing {
    --black: #0b0c0e; --surface: #131417; --elevated: #1b1c20; --border: #2a2c30; --border-subtle: #1f2023;
    --text: #f4f2ec; --text-secondary: #a7a9ac; --text-dim: #75777a;
    --accent: #c99a44; --accent-glow: rgba(201,154,68,0.15); --accent-glow-strong: rgba(201,154,68,0.28);

    background: var(--black);
    color: var(--text);
    font-family: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    height: 100dvh;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    scroll-behavior: smooth;
  }
  :global(html.light) .vault-landing {
    --black: #f7f5f0; --surface: #ffffff; --elevated: #efece4; --border: #ddd8cd; --border-subtle: #eae6dc;
    --text: #17140f; --text-secondary: #4b463d; --text-dim: #7a7469;
    --accent: #9c7530; --accent-glow: rgba(156,117,48,0.10); --accent-glow-strong: rgba(156,117,48,0.18);
  }

  .vault-landing :global(*) { box-sizing: border-box; }
  .vault-landing :global(:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px; }
  .vault-landing :global(section[id]), .vault-landing :global(#preview) { scroll-margin-top: 76px; }
  @media (prefers-reduced-motion: reduce) { .vault-landing { scroll-behavior: auto; } }

  h1, h2, h3 { font-weight: 800; letter-spacing: -0.02em; text-wrap: balance; margin: 0; }
  a, button { color: inherit; }
  .eyebrow, .plate { font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace; }

  .bg-field {
    position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background:
      radial-gradient(600px 400px at 15% 0%, var(--accent-glow), transparent 60%),
      radial-gradient(500px 380px at 100% 30%, var(--accent-glow), transparent 55%);
    opacity: 0.6;
  }
  .bg-field::after {
    content: ""; position: absolute; inset: 0;
    background-image: linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px);
    background-size: 48px 48px; opacity: 0.35;
  }

  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 28px; }

  /* ---------- NAV ---------- */
  .nav-shell {
    position: sticky; top: 0; z-index: 40; background: color-mix(in srgb, var(--surface) 72%, transparent);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  }
  nav.top { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid var(--border-subtle); }
  .theme-toggle {
    display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
    border: 1px solid var(--border); border-radius: 0.75rem; background: none; color: var(--text-secondary);
    cursor: pointer; font-size: 0.9rem; transition: all 0.25s ease;
  }
  .theme-toggle:hover { border-color: var(--accent); color: var(--text); }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 1rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .logo-mark {
    width: 22px; height: 22px; color: var(--text);
    filter: drop-shadow(0 0 6px var(--accent-glow)); animation: lockPulse 5s ease-in-out infinite;
  }
  @keyframes lockPulse {
    0%, 100% { filter: drop-shadow(0 0 4px var(--accent-glow)); }
    50% { filter: drop-shadow(0 0 10px var(--accent-glow-strong)); }
  }
  @media (prefers-reduced-motion: reduce) { .logo-mark { animation: none; } }
  .beta-pill {
    font-size: 0.55rem; letter-spacing: 0.06em; padding: 2px 6px; border: 1px solid var(--border);
    border-radius: 9999px; color: var(--text-dim); text-transform: none; font-weight: 600;
  }
  nav.top .links { display: flex; align-items: center; gap: 26px; font-size: 0.88rem; color: var(--text-secondary); font-family: inherit; }
  nav.top .links a { text-decoration: none; }
  .cta-small {
    background: var(--text); color: var(--black); padding: 8px 16px; border-radius: 0.75rem;
    text-decoration: none; font-size: 0.85rem; font-weight: 700; border: none; cursor: pointer;
  }

  /* ---------- HERO ---------- */
  .hero { padding: 76px 0 8px; position: relative; text-align: center; }
  .hero-inner { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; }
  .hero h1 {
    font-size: clamp(2.3rem, 4.6vw, 3.4rem); line-height: 1.1;
    background: linear-gradient(180deg, var(--text), var(--text-secondary));
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  }
  .hero .sub { margin-top: 20px; font-size: 1.1rem; color: var(--text-secondary); max-width: 46ch; }
  .hero .actions { display: flex; align-items: center; justify-content: center; gap: 20px; margin-top: 30px; flex-wrap: wrap; }
  .btn-primary {
    background: var(--text); color: var(--black); border: none; padding: 13px 24px;
    font-size: 0.95rem; font-weight: 700; border-radius: 0.75rem; cursor: pointer; text-decoration: none;
    transition: all 0.3s cubic-bezier(0.16,1,0.3,1);
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 0 16px rgba(250,250,250,0.12); }
  .btn-ghost {
    color: var(--text-secondary); text-decoration: none; font-size: 0.9rem;
    border: 1px solid var(--border); padding: 12px 20px; border-radius: 0.75rem;
    transition: all 0.3s cubic-bezier(0.16,1,0.3,1);
  }
  .btn-ghost:hover { border-color: var(--accent); color: var(--text); }
  .hero-microcopy { margin-top: 14px; font-size: 0.8rem; color: var(--text-dim); }
  .trust-row { display: flex; justify-content: center; gap: 26px; margin-top: 36px; flex-wrap: wrap; }
  .trust-item { display: flex; align-items: baseline; gap: 7px; font-size: 0.85rem; color: var(--text-secondary); }
  .trust-item .chk { color: var(--accent); font-weight: 700; }
  .community-row { margin-top: 40px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .community-label {
    font-size: 0.66rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace; font-weight: 700;
  }
  .community-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
  .community-links a {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 0.6rem;
    border: 1px solid var(--border); background: var(--surface); color: var(--text-secondary);
    text-decoration: none; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.03em;
    font-family: 'JetBrains Mono', monospace; text-transform: uppercase; transition: all 0.25s ease;
  }
  .community-links a:hover { color: var(--text); border-color: var(--accent); }

  /* ---------- SECTION SHELL ---------- */
  section { padding: 68px 0; border-top: 1px solid var(--border-subtle); }
  .section-head { max-width: 640px; margin-bottom: 42px; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 8px; font-size: 0.72rem; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--accent); font-weight: 600; margin-bottom: 12px;
  }
  .eyebrow::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent-glow-strong); }
  .section-head h2 { font-size: clamp(1.5rem, 2.4vw, 2rem); }
  .section-head p { margin-top: 12px; color: var(--text-secondary); font-size: 1rem; }

  /* ---------- PREVIEW ---------- */
  .preview-caption { font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; margin: 0 0 18px; }
  .chat-mock {
    max-width: 480px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border);
    border-radius: 1rem; padding: 22px; display: flex; flex-direction: column; gap: 12px;
  }
  .bubble-row { display: flex; flex-direction: column; max-width: 78%; }
  .bubble-row.in { align-self: flex-start; align-items: flex-start; }
  .bubble-row.out { align-self: flex-end; align-items: flex-end; }
  .bubble { padding: 10px 14px; border-radius: 1rem; font-size: 0.92rem; line-height: 1.4; }
  .bubble-row.in .bubble { background: var(--elevated); color: var(--text); border-bottom-left-radius: 0.3rem; }
  .bubble-row.out .bubble { background: var(--text); color: var(--black); border-bottom-right-radius: 0.3rem; font-weight: 600; }
  .bubble-meta { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 0.68rem; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; }
  .bubble-meta .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px var(--accent-glow-strong); }

  /* ---------- HOW IT WORKS ---------- */
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
  .step { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 24px 22px; }
  .step .num { font-size: 0.72rem; color: var(--accent); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; font-family: 'JetBrains Mono', monospace; }
  .step h3 { margin-top: 10px; font-size: 1.08rem; font-weight: 700; }
  .step p { margin-top: 8px; color: var(--text-secondary); font-size: 0.92rem; }
  .tech-footnote {
    margin-top: 26px; padding: 13px 18px; border: 1px solid var(--border); border-radius: 0.75rem;
    display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
    background: var(--surface);
  }
  .tech-footnote span { font-size: 0.8rem; color: var(--text-dim); }
  .tech-link {
    font-size: 0.8rem; color: var(--accent); font-weight: 700; white-space: nowrap;
    background: none; border: none; cursor: pointer; font-family: inherit; padding: 0;
  }
  .tech-details-panel { max-height: 0; overflow: hidden; opacity: 0; transition: max-height 0.4s cubic-bezier(0.16,1,0.3,1), opacity 0.3s ease; }
  .tech-details-panel.open { max-height: 900px; opacity: 1; margin-top: 16px; }
  .tech-details-inner { border: 1px solid var(--border); border-radius: 0.75rem; padding: 24px 26px; background: var(--surface); }
  .tech-details-inner h4 {
    font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent);
    font-family: 'JetBrains Mono', monospace; margin: 22px 0 6px;
  }
  .tech-details-inner h4:first-of-type { margin-top: 4px; }
  .tech-details-inner p { margin: 0; color: var(--text-secondary); font-size: 0.92rem; max-width: 68ch; }
  .tech-details-inner :global(code) {
    background: var(--elevated); border: 1px solid var(--border-subtle); border-radius: 4px;
    padding: 1px 6px; font-size: 0.82rem; color: var(--text); font-family: 'JetBrains Mono', monospace;
  }
  .tech-close { margin-top: 18px; font-size: 0.78rem; color: var(--text-dim); background: none; border: none; cursor: pointer; font-family: 'JetBrains Mono', monospace; padding: 0; }
  .tech-close:hover { color: var(--text); }

  /* ---------- FEATURES ---------- */
  .feature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--border-subtle); border: 1px solid var(--border-subtle); border-radius: 0.75rem; overflow: hidden; }
  .feature { background: var(--surface); padding: 26px 24px; transition: background 0.25s ease; }
  .feature:hover { background: var(--elevated); }
  .feature .plate {
    display: inline-block; font-size: 0.62rem; color: var(--accent); letter-spacing: 0.06em;
    background: var(--accent-glow); padding: 3px 8px; border-radius: 9999px; font-weight: 600;
  }
  .feature h3 { margin-top: 12px; font-size: 1.02rem; font-weight: 700; }
  .feature p { margin-top: 8px; color: var(--text-secondary); font-size: 0.9rem; }

  /* ---------- SHOWCASE ---------- */
  .showcase-grid { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: end; }
  .showcase-desktop, .showcase-mobile {
    margin: 0; border: 1px solid var(--border); border-radius: 0.85rem; overflow: hidden;
    background: var(--surface); box-shadow: 0 20px 48px rgba(0,0,0,0.25);
  }
  .showcase-desktop :global(img), .showcase-mobile :global(img) { display: block; width: 100%; height: auto; }
  .showcase-mobile { width: 220px; justify-self: end; }
  .showcase-desktop figcaption, .showcase-mobile figcaption {
    padding: 10px 14px; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--text-dim); font-family: 'JetBrains Mono', monospace; border-top: 1px solid var(--border-subtle);
  }
  @media (max-width: 780px) {
    .showcase-grid { grid-template-columns: 1fr; }
    .showcase-mobile { width: 200px; justify-self: center; }
  }

  /* ---------- COMPARISON ---------- */
  table.compare { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  table.compare th, table.compare td { padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); text-align: left; }
  table.compare th { color: var(--text-dim); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; font-family: 'JetBrains Mono', monospace; }
  table.compare th:not(:first-child), table.compare td:not(:first-child) { text-align: center; }
  table.compare .brandcol { color: var(--accent); font-weight: 700; }
  .yes { color: var(--accent); font-weight: 600; }
  .yes::before { content: "✓ "; }
  .no { color: var(--text-dim); }
  .no::before { content: "✕ "; opacity: 0.6; }
  .table-scroll { overflow-x: auto; }

  /* ---------- FAQ ---------- */
  .faq-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 9999px; padding: 3px; margin-bottom: 8px; }
  .faq-toggle button {
    border: none; background: transparent; color: var(--text-secondary); font-size: 0.78rem; font-weight: 700;
    padding: 7px 16px; border-radius: 9999px; cursor: pointer; font-family: 'JetBrains Mono', monospace;
  }
  .faq-toggle button.active { background: var(--accent); color: var(--black); }
  .faq-panel { display: none; margin-top: 26px; }
  .faq-panel.active { display: block; }
  .faq-item { border-bottom: 1px solid var(--border-subtle); padding: 16px 0; }
  .faq-item summary { cursor: pointer; font-weight: 700; font-size: 0.98rem; list-style: none; display: flex; justify-content: space-between; align-items: center; }
  .faq-item summary::-webkit-details-marker { display: none; }
  .faq-item summary::after { content: "+"; color: var(--accent); font-size: 1.2rem; font-weight: 400; }
  .faq-item[open] summary::after { content: "\2212"; }
  .faq-item p { margin: 12px 0 0; color: var(--text-secondary); font-size: 0.92rem; max-width: 62ch; }

  /* ---------- FINAL CTA ---------- */
  .final-cta { text-align: center; padding: 80px 0; }
  .final-cta h2 { font-size: clamp(1.7rem, 3vw, 2.2rem); }
  .final-cta p { margin: 14px auto 0; color: var(--text-secondary); max-width: 44ch; }
  .final-cta .actions { margin-top: 28px; display: flex; justify-content: center; gap: 18px; }

  footer { border-top: 1px solid var(--border-subtle); padding: 26px 0; }
  footer .row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; font-size: 0.78rem; color: var(--text-dim); font-family: 'JetBrains Mono', monospace; }
  .footer-links { display: flex; gap: 22px; align-items: center; }
  .footer-links a { color: var(--text-dim); text-decoration: none; }
  .footer-links a:hover { color: var(--text); }

  @media (max-width: 860px) {
    .steps, .feature-grid { grid-template-columns: 1fr; }
    table.compare { min-width: 520px; }
  }
  @media (max-width: 700px) {
    nav.top .links a { display: none; }
    .bubble-row { max-width: 88%; }
  }
</style>
