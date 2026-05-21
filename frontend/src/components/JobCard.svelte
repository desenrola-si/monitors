<script lang="ts">
  import type { JobInfo } from '../lib/api';
  import { formatDuration, formatRelative } from '../lib/time';

  interface Props {
    job: JobInfo;
    triggering: boolean;
    onTrigger: () => void;
    onViewHistory: () => void;
  }

  let { job, triggering, onTrigger, onViewHistory }: Props = $props();

  const statusInfo = $derived(deriveStatus(job));

  function deriveStatus(j: JobInfo): { variant: string; label: string } {
    if (triggering || j.lastRun?.status === 'running') {
      return { variant: 'running', label: 'rodando' };
    }
    if (!j.lastRun) return { variant: 'idle', label: 'nunca rodou' };
    if (j.lastRun.status === 'success') return { variant: 'success', label: 'ok' };
    return { variant: 'failed', label: 'falhou' };
  }
</script>

<article class="card" data-status={statusInfo.variant}>
  <header class="card-header">
    <div class="name-row">
      <span class="status-dot" data-status={statusInfo.variant}></span>
      <h3 class="name">{job.name}</h3>
      <span class="status-label">{statusInfo.label}</span>
    </div>
    <p class="description">{job.description}</p>
  </header>

  <dl class="meta">
    <div class="meta-row">
      <dt>Schedule</dt>
      <dd><code>{job.schedule}</code> <span class="tertiary">({job.timezone})</span></dd>
    </div>
    {#if job.lastRun}
      <div class="meta-row">
        <dt>Última execução</dt>
        <dd>
          <span class="mono">{formatRelative(job.lastRun.startedAt)}</span>
          {#if job.lastRun.durationMs !== null}
            <span class="tertiary mono">· {formatDuration(job.lastRun.durationMs)}</span>
          {/if}
        </dd>
      </div>
      {#if job.lastRun.errorMessage}
        <div class="meta-row error-row">
          <dt>Erro</dt>
          <dd class="mono error-msg">{job.lastRun.errorMessage}</dd>
        </div>
      {/if}
    {:else}
      <div class="meta-row">
        <dt>Última execução</dt>
        <dd class="tertiary">—</dd>
      </div>
    {/if}
  </dl>

  <footer class="actions">
    <button class="btn-ghost" onclick={onViewHistory}>Histórico</button>
    <button class="btn-primary" onclick={onTrigger} disabled={triggering}>
      {triggering ? 'Disparando…' : 'Rodar agora'}
    </button>
  </footer>
</article>

<style>
  .card {
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    transition: border-color var(--duration-fast) var(--easing-default);
  }
  .card:hover {
    border-color: var(--border-strong);
  }
  .card[data-status='failed'] {
    border-color: var(--color-danger-border);
  }
  .card[data-status='running'] {
    border-color: var(--color-running-border);
  }

  .card-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot[data-status='success'] {
    background: var(--color-success);
    box-shadow: 0 0 8px var(--color-success);
  }
  .status-dot[data-status='failed'] {
    background: var(--color-danger);
    box-shadow: 0 0 8px var(--color-danger);
  }
  .status-dot[data-status='running'] {
    background: var(--color-running);
    box-shadow: 0 0 12px var(--color-running);
    animation: pulse 1.6s var(--easing-default) infinite;
  }
  .status-dot[data-status='idle'] {
    background: var(--text-disabled);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .name {
    font-family: var(--font-mono);
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
  }

  .status-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    font-weight: 500;
  }

  .description {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
  }

  .meta {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-subtle);
  }
  .meta-row {
    display: flex;
    gap: var(--space-3);
    align-items: baseline;
  }
  .meta-row dt {
    font-size: 12px;
    color: var(--text-tertiary);
    min-width: 110px;
    flex-shrink: 0;
  }
  .meta-row dd {
    margin: 0;
    font-size: 13px;
    color: var(--text-primary);
  }
  .meta-row code {
    background: var(--bg-overlay);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .error-row dd {
    color: var(--color-danger);
    font-size: 12px;
    word-break: break-word;
  }
  .error-msg {
    max-height: 80px;
    overflow: auto;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-1);
    justify-content: flex-end;
  }

  .btn-ghost {
    padding: var(--space-2) var(--space-4);
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-size: 13px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .btn-ghost:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .btn-primary {
    padding: var(--space-2) var(--space-4);
    background: var(--accent-bg);
    color: var(--accent);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-md);
    font-size: 13px;
    font-weight: 500;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
