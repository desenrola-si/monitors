<script lang="ts">
  import { onMount } from 'svelte';
  import { authApi, ApiError } from './lib/api';
  import Login from './routes/Login.svelte';
  import Dashboard from './routes/Dashboard.svelte';

  let state: 'checking' | 'login' | 'dashboard' = $state('checking');
  let username = $state('');

  async function checkAuth(): Promise<void> {
    try {
      const me = await authApi.me();
      username = me.user.username;
      state = 'dashboard';
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        state = 'login';
      } else {
        console.error('auth check error', err);
        state = 'login';
      }
    }
  }

  function onLoggedIn(name: string): void {
    username = name;
    state = 'dashboard';
  }

  async function onLogout(): Promise<void> {
    await authApi.logout();
    username = '';
    state = 'login';
  }

  onMount(() => {
    void checkAuth();
  });
</script>

{#if state === 'checking'}
  <div class="boot">
    <span class="boot-text mono">checking session…</span>
  </div>
{:else if state === 'login'}
  <Login onSuccess={onLoggedIn} />
{:else}
  <Dashboard {username} onLogout={onLogout} />
{/if}

<style>
  .boot {
    flex: 1;
    display: grid;
    place-items: center;
  }
  .boot-text {
    color: var(--text-tertiary);
    font-size: 13px;
  }
</style>
