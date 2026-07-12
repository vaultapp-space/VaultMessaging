<script>
  import { onMount } from 'svelte';
  import { currentUser, isLoading, setUser, activeView } from './lib/stores/session.js';
  import { getMe } from './lib/api/http.js';
  import Auth from './components/Auth.svelte';
  import Chat from './components/Chat.svelte';

  let mounted = false;

  onMount(async () => {
    mounted = true;
    // Try to restore session from HTTP-only cookie (server validates)
    try {
      const user = await getMe();
      setUser(user);
    } catch {
      setUser(null);
    }
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
  {:else if $activeView === 'auth'}
    <Auth />
  {:else}
    <Chat />
  {/if}
</main>
