<script lang="ts">
  import { jobsApi, type JobRunSummary } from '../lib/api';
  import { formatDateTime, formatDuration } from '../lib/time';

  interface Props {
    jobName: string;
    onClose: () => void;
  }

  let { jobName, onClose }: Props = $props();

  let runs = $state<JobRunSummary[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await jobsApi.runs(jobName);
      runs = res.runs;
    } catch (err) {
      error = err instanceof Error ? err.message : 'erro ao carregar histórico';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (jobName) void load();
  });

  function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }

  function statusLabel(s: 'running' | 'success' | 'failed'): string {
    if (s === 'running') return 'rodando';
    if (s === 'success') return 'sucesso';
    return 'falhou';
  }
</script>

<svelte:window onkeydown={handleKey} />

<div class="backdrop" onclick={onClose} role="presentation"></div>
<div class="drawer" role="dialog" aria-modal="true" aria-label="Histórico de {jobName}">
  <header class="drawer-header">
    <div>
      <span class="tertiary">Histórico</span>
      <h2 class="mono">{jobName}</h2>
    </div>
    <button class="close" onclick={onClose} aria-label="Fechar">✕</button>
  </header>

  <div class="drawer-body">
    {#if loading}
      <p class="state">carregando…</p>
    {:else if error}
      <p class="state state-error">{error}</p>
    {:else if runs.length === 0}
      <p class="state">nenhuma execução registrada ainda</p>
    {:else}
      <ol class="runs">
        {#each runs as run}
          <li class="run" data-status={run.status}>
            <div class="run-status">
              <span class="dot" data-status={run.status}></span>
              <span class="run-status-label">{statusLabel(run.status)}</span>
            </div>
            <div class="run-meta">
              <span class="mono">{formatDateTime(run.startedAt)} BRT</span>
              {#if run.durationMs !== null}
                <span class="tertiary mono">· {formatDuration(run.durationMs)}</span>
              {/if}
            </div>
            {#if run.errorMessage}
              <div class="run-error mono">{run.errorMessage}</div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100;
    animation: fade-in var(--duration-normal) var(--easing-default);
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(480px, 100vw);
    background: var(--bg-elevated);
    border-left: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-lg);
    z-index: 101;
    display: flex;
    flex-direction: column;
    animation: slide-in var(--duration-normal) var(--easing-default);
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes slide-in {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }

  .drawer-header {
    padding: var(--space-5);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .drawer-header h2 {
    margin: var(--space-1) 0 0 0;
    font-size: 16px;
    font-weight: 600;
  }
  .drawer-header .tertiary {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .close {
    color: var(--text-tertiary);
    font-size: 18px;
    padding: var(--space-1) var(--space-2);
    transition: color var(--duration-fast) var(--easing-default);
  }
  .close:hover {
    color: var(--text-primary);
  }

  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4) var(--space-5);
  }

  .state {
    color: var(--text-tertiary);
    text-align: center;
    margin: var(--space-7) 0;
    font-size: 13px;
  }
  .state-error {
    color: var(--color-danger);
  }

  .runs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .run {
    background: var(--bg-overlay);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .run[data-status='failed'] {
    border-color: var(--color-danger-border);
  }
  .run[data-status='running'] {
    border-color: var(--color-running-border);
  }

  .run-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .dot[data-status='success'] { background: var(--color-success); }
  .dot[data-status='failed'] { background: var(--color-danger); }
  .dot[data-status='running'] { background: var(--color-running); }
  .run-status-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }
  .run-meta {
    font-size: 12px;
    color: var(--text-primary);
  }
  .run-error {
    font-size: 11px;
    color: var(--color-danger);
    word-break: break-word;
    max-height: 100px;
    overflow: auto;
    padding: var(--space-2);
    background: var(--color-danger-bg);
    border-radius: var(--radius-sm);
  }
</style>

