<script>
  import { onMount, onDestroy } from 'svelte';
  import { currentUser, isLoading, setUser, activeView } from './lib/stores/session.js';
  import { getMe } from './lib/api/http.js';
  import Auth from './components/Auth.svelte';
  import Chat from './components/Chat.svelte';
  import Landing from './components/Landing.svelte';

  // Initialize theme from localStorage immediately (no flicker)
  const initialTheme = localStorage.getItem('vault_theme') || 'dark';
  if (initialTheme === 'light') {
    document.documentElement.classList.add('light');
  } else {
    document.documentElement.classList.remove('light');
  }

  let mounted = false;
  let wakeLock = null;

  async function requestWakeLock() {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    if (wakeLock) return; // already acquired
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        console.log('Screen Wake Lock was released');
      });
      console.log('Screen Wake Lock is active');
    } catch (err) {
      console.warn(`Failed to request Screen Wake Lock: ${err.name}, ${err.message}`);
    }
  }

  async function releaseWakeLock() {
    if (wakeLock) {
      try {
        await wakeLock.release();
        wakeLock = null;
        console.log('Screen Wake Lock released manually');
      } catch (err) {
        console.error('Failed to release wake lock:', err);
      }
    }
  }

  function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  // Reactively request or release wake lock based on login status and mobile device
  $: if (mounted && isMobileDevice()) {
    if ($currentUser) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
  }

  // Re-acquire lock if tab becomes visible again
  async function handleVisibilityChange() {
    if (document.visibilityState === 'visible' && $currentUser && isMobileDevice()) {
      await requestWakeLock();
    }
  }

  onMount(async () => {
    mounted = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    // Try to restore session from HTTP-only cookie (server validates)
    try {
      const user = await getMe();
      setUser(user);
    } catch {
      setUser(null);
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    releaseWakeLock();
  });
</script>

<main class="min-h-screen bg-vault-black relative overflow-hidden">
  <!-- Ambient background glow -->
  <div class="pointer-events-none fixed inset-0 z-0">
    <div class="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-vault-accent/[0.03] blur-[120px]"></div>
    <div class="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-vault-accent/[0.02] blur-[100px]"></div>
  </div>

  {#if $isLoading}
    <!-- Loading screen -->
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-vault-black">
      <div class="flex flex-col items-center gap-4 animate-fade-in">
        <div class="relative">
          <svg class="w-12 h-12 text-vault-accent animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z" />
            <path d="M9.5 12l2 2 3.5-3.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <div class="text-vault-text-dim text-sm tracking-wider uppercase">Establishing secure connection...</div>
      </div>
    </div>
  {:else if $activeView === 'landing'}
    <Landing />
  {:else if $activeView === 'auth'}
    <Auth />
  {:else}
    <Chat />
  {/if}
</main>
