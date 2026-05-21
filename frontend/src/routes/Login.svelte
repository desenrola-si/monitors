<script lang="ts">
  import { onMount } from 'svelte';
  import { authApi, ApiError } from '../lib/api';

  interface Props {
    onSuccess: (username: string) => void;
  }

  let { onSuccess }: Props = $props();

  let username = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);
  let usernameInput = $state<HTMLInputElement | null>(null);

  onMount(() => {
    usernameInput?.focus();
  });

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (loading) return;
    error = null;
    loading = true;
    try {
      const res = await authApi.login(username, password);
      onSuccess(res.user.username);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        error = 'Usuário ou senha incorretos';
      } else if (err instanceof ApiError && err.status === 500) {
        error = 'Auth não configurada no servidor (DASHBOARD_USER / DASHBOARD_PASS_HASH)';
      } else {
        error = 'Erro ao fazer login';
      }
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-container">
  <form class="login-card" onsubmit={handleSubmit}>
    <div class="brand">
      <span class="brand-icon">⚡</span>
      <h1 class="brand-name">Desenrola Monitors</h1>
    </div>
    <p class="brand-sub">Dashboard de jobs e crons</p>

    <div class="field">
      <label for="username">Usuário</label>
      <input
        id="username"
        type="text"
        autocomplete="username"
        bind:value={username}
        bind:this={usernameInput}
        disabled={loading}
      />
    </div>

    <div class="field">
      <label for="password">Senha</label>
      <input
        id="password"
        type="password"
        autocomplete="current-password"
        bind:value={password}
        disabled={loading}
      />
    </div>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <button type="submit" class="submit" disabled={loading || !username || !password}>
      {loading ? 'Entrando…' : 'Entrar'}
    </button>
  </form>
</div>

<style>
  .login-container {
    flex: 1;
    display: grid;
    place-items: center;
    padding: var(--space-5);
    background:
      radial-gradient(circle at top right, rgba(99, 102, 241, 0.08), transparent 50%),
      radial-gradient(circle at bottom left, rgba(167, 139, 250, 0.05), transparent 50%),
      var(--bg-base);
  }

  .login-card {
    width: 100%;
    max-width: 380px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    padding: var(--space-7) var(--space-6);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .brand-icon {
    font-size: 24px;
    line-height: 1;
  }
  .brand-name {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .brand-sub {
    margin: 0 0 var(--space-3) 0;
    color: var(--text-secondary);
    font-size: 13px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .field label {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .error {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    color: var(--color-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: 13px;
  }

  .submit {
    background: var(--accent);
    color: white;
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius-md);
    font-weight: 500;
    font-size: 14px;
    transition:
      background var(--duration-fast) var(--easing-default),
      transform var(--duration-fast) var(--easing-default);
    margin-top: var(--space-2);
  }
  .submit:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .submit:active:not(:disabled) {
    transform: translateY(1px);
  }
  .submit:disabled {
    background: var(--bg-hover);
    color: var(--text-tertiary);
    cursor: not-allowed;
  }
</style>
