<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { jobsApi, type JobInfo, ApiError } from '../lib/api';
  import { formatRelative } from '../lib/time';
  import {
    connectJobsStream,
    type JobStartedEvent,
    type JobFinishedEvent,
    type JobScheduledEvent,
  } from '../lib/stream';
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
  let streamConnected = $state(false);

  const REFRESH_MS = 30_000;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let closeStream: (() => void) | null = null;

  function updateJob(name: string, patch: Partial<JobInfo>): void {
    jobs = jobs.map((j) => (j.name === name ? { ...j, ...patch } : j));
  }

  function onStarted(e: JobStartedEvent): void {
    updateJob(e.name, {
      lastRun: {
        startedAt: e.startedAt,
        finishedAt: null,
        status: 'running',
        durationMs: null,
        errorMessage: null,
        triggerSource: e.source,
      },
    });
  }

  function onFinished(e: JobFinishedEvent): void {
    updateJob(e.name, {
      lastRun: {
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
        status: e.status,
        durationMs: e.durationMs,
        errorMessage: e.errorMessage,
      },
    });
    // Garante que botão "Rodar agora" volta ao normal
    if (triggering.has(e.name)) {
      const next = new Set(triggering);
      next.delete(e.name);
      triggering = next;
    }
  }

  function onScheduled(e: JobScheduledEvent): void {
    updateJob(e.name, {
      schedule: e.schedule,
      scheduleDefault: e.scheduleDefault,
      scheduleIsOverridden: e.isOverride,
    });
  }

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

    // Conecta SSE pra updates em tempo real. Polling continua como fallback
    // — se SSE cai, browser reconecta sozinho; em paralelo o polling cobre
    // o intervalo em que o stream fica fora.
    closeStream = connectJobsStream({
      onJobStarted: onStarted,
      onJobFinished: onFinished,
      onJobScheduled: onScheduled,
      onOpen: () => (streamConnected = true),
      onError: () => (streamConnected = false),
    });
  });

  onDestroy(() => {
    if (intervalId) clearInterval(intervalId);
    document.removeEventListener('visibilitychange', handleVisibility);
    closeStream?.();
  });
</script>

<div class="layout">
  <header class="topbar">
    <div class="brand">
      <span class="brand-icon">⚡</span>
      <span class="brand-name">Desenrola Monitors</span>
    </div>
    <div class="topbar-right">
      <span
        class="stream-indicator"
        class:stream-live={streamConnected}
        title={streamConnected ? 'Live — recebendo eventos em tempo real' : 'Sem conexão de stream — polling a cada 30s'}
      >
        <span class="stream-dot"></span>
        <span class="stream-label">{streamConnected ? 'ao vivo' : 'polling'}</span>
      </span>
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
  .stream-indicator {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
  }
  .stream-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-disabled);
    transition: background var(--duration-normal) var(--easing-default);
  }
  .stream-indicator.stream-live .stream-dot {
    background: var(--color-success);
    box-shadow: 0 0 6px var(--color-success);
    animation: pulse-live 1.6s var(--easing-default) infinite;
  }
  .stream-indicator.stream-live {
    color: var(--color-success);
  }
  @keyframes pulse-live {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
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
