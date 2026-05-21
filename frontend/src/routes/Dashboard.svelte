<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { jobsApi, type JobInfo, ApiError } from '../lib/api';
  import { formatRelative } from '../lib/time';
  import JobCard from '../components/JobCard.svelte';
  import HistoryDrawer from '../components/HistoryDrawer.svelte';

  interface Props {
    username: string;
    onLogout: () => void;
  }

  let { username, onLogout }: Props = $props();

  let jobs = $state<JobInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let lastFetchedAt = $state<Date | null>(null);
  let triggering = $state<Set<string>>(new Set());
  let drawerJobName = $state<string | null>(null);

  const REFRESH_MS = 30_000;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function load(): Promise<void> {
    try {
      const res = await jobsApi.list();
      jobs = res.jobs;
      lastFetchedAt = new Date();
      error = null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onLogout();
        return;
      }
      error = err instanceof Error ? err.message : 'erro ao carregar';
    } finally {
      loading = false;
    }
  }

  async function trigger(name: string): Promise<void> {
    const next = new Set(triggering);
    next.add(name);
    triggering = next;
    try {
      await jobsApi.trigger(name);
      // Refresh logo em seguida pra pegar status 'running'
      setTimeout(() => void load(), 500);
    } catch (err) {
      console.error('trigger failed', err);
    } finally {
      // Solta o estado triggering depois de 2s pra UI ter resposta visual
      setTimeout(() => {
        const next2 = new Set(triggering);
        next2.delete(name);
        triggering = next2;
      }, 2000);
    }
  }

  function handleVisibility(): void {
    if (document.visibilityState === 'visible' && !intervalId) {
      void load();
      intervalId = setInterval(() => void load(), REFRESH_MS);
    } else if (document.visibilityState === 'hidden' && intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  onMount(() => {
    void load();
    intervalId = setInterval(() => void load(), REFRESH_MS);
    document.addEventListener('visibilitychange', handleVisibility);
  });

  onDestroy(() => {
    if (intervalId) clearInterval(intervalId);
    document.removeEventListener('visibilitychange', handleVisibility);
  });
</script>

<div class="layout">
  <header class="topbar">
    <div class="brand">
      <span class="brand-icon">⚡</span>
      <span class="brand-name">Desenrola Monitors</span>
    </div>
    <div class="topbar-right">
      {#if lastFetchedAt}
        <span class="last-update mono">
          atualizado {formatRelative(lastFetchedAt.toISOString())}
        </span>
      {/if}
      <span class="user">{username}</span>
      <button class="logout-btn" onclick={onLogout}>Sair</button>
    </div>
  </header>

  <main class="content">
    {#if loading}
      <p class="state">carregando jobs…</p>
    {:else if error}
      <p class="state state-error">{error}</p>
    {:else if jobs.length === 0}
      <p class="state">Nenhum job registrado.</p>
    {:else}
      <div class="grid">
        {#each jobs as job (job.name)}
          <JobCard
            {job}
            triggering={triggering.has(job.name)}
            onTrigger={() => trigger(job.name)}
            onViewHistory={() => (drawerJobName = job.name)}
            onScheduleChanged={() => void load()}
          />
        {/each}
      </div>
    {/if}
  </main>

  {#if drawerJobName}
    <HistoryDrawer jobName={drawerJobName} onClose={() => (drawerJobName = null)} />
  {/if}
</div>

<style>
  .layout {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
  }

  .topbar {
    padding: var(--space-3) var(--space-6);
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .brand-icon {
    font-size: 18px;
  }
  .brand-name {
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .last-update {
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .user {
    color: var(--text-secondary);
    font-size: 13px;
  }
  .logout-btn {
    color: var(--text-secondary);
    font-size: 12px;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    transition: all var(--duration-fast) var(--easing-default);
  }
  .logout-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .content {
    flex: 1;
    max-width: 1280px;
    margin: 0 auto;
    width: 100%;
    padding: var(--space-6);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: var(--space-4);
  }

  .state {
    color: var(--text-tertiary);
    text-align: center;
    margin: var(--space-7) 0;
  }
  .state-error {
    color: var(--color-danger);
  }
</style>
