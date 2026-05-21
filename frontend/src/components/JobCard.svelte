<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { JobInfo } from '../lib/api';
  import { jobsApi, ApiError } from '../lib/api';
  import { formatDuration, formatRelative } from '../lib/time';
  import { humanizeCron, nextRunAt, formatCountdown, formatBrtTime } from '../lib/cron';

  interface Props {
    job: JobInfo;
    triggering: boolean;
    onTrigger: () => void;
    onViewHistory: () => void;
    onScheduleChanged: () => void;
  }

  let { job, triggering, onTrigger, onViewHistory, onScheduleChanged }: Props = $props();

  const statusInfo = $derived(deriveStatus(job));

  let editingSchedule = $state(false);
  let scheduleDraft = $state('');
  let scheduleError = $state<string | null>(null);
  let savingSchedule = $state(false);

  // Now reativo pra countdown do próximo tick. Tick a cada 1s.
  let now = $state(new Date());
  let tickerId: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    tickerId = setInterval(() => {
      now = new Date();
    }, 1000);
  });
  onDestroy(() => {
    if (tickerId) clearInterval(tickerId);
  });

  const nextRun = $derived(nextRunAt(job.schedule, job.timezone));
  const nextRunLabel = $derived(
    nextRun
      ? `${formatBrtTime(nextRun)} · ${formatCountdown(nextRun, now)}`
      : 'desconhecido',
  );

  function deriveStatus(j: JobInfo): { variant: string; label: string } {
    if (triggering || j.lastRun?.status === 'running') {
      return { variant: 'running', label: 'rodando' };
    }
    if (!j.lastRun) return { variant: 'idle', label: 'nunca rodou' };
    if (j.lastRun.status === 'success') return { variant: 'success', label: 'ok' };
    return { variant: 'failed', label: 'falhou' };
  }

  function startEditingSchedule(): void {
    scheduleDraft = job.schedule;
    scheduleError = null;
    editingSchedule = true;
  }

  function cancelEditing(): void {
    editingSchedule = false;
    scheduleError = null;
  }

  async function saveSchedule(): Promise<void> {
    const trimmed = scheduleDraft.trim();
    if (!trimmed) {
      scheduleError = 'Schedule não pode ser vazio';
      return;
    }
    savingSchedule = true;
    scheduleError = null;
    try {
      await jobsApi.updateSchedule(job.name, trimmed);
      editingSchedule = false;
      onScheduleChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const body = err.body as { message?: string } | null;
        scheduleError = body?.message ?? 'Schedule inválido';
      } else {
        scheduleError = 'Erro ao salvar';
      }
    } finally {
      savingSchedule = false;
    }
  }

  async function resetToDefault(): Promise<void> {
    if (job.schedule === job.scheduleDefault) return;
    savingSchedule = true;
    try {
      await jobsApi.updateSchedule(job.name, job.scheduleDefault);
      onScheduleChanged();
    } catch {
      scheduleError = 'Erro ao resetar';
    } finally {
      savingSchedule = false;
    }
  }

  function handleScheduleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') void saveSchedule();
    if (e.key === 'Escape') cancelEditing();
  }
</script>

<article class="card" data-status={statusInfo.variant}>
  <header class="card-header">
    <div class="name-row">
      <span class="status-dot" data-status={statusInfo.variant}></span>
      <h3 class="name" class:humanized={!!job.displayName}>
        {job.displayName ?? job.name}
      </h3>
      <span class="status-label">{statusInfo.label}</span>
    </div>
    <p class="description">{job.description}</p>
    {#if job.displayName}
      <code class="slug">{job.name}</code>
    {/if}
  </header>

  <dl class="meta">
    <div class="meta-row">
      <dt>Quando roda</dt>
      <dd class="schedule-cell">
        {#if editingSchedule}
          <input
            type="text"
            class="schedule-input mono"
            bind:value={scheduleDraft}
            disabled={savingSchedule}
            onkeydown={handleScheduleKey}
            placeholder="0 6 * * *"
          />
          <div class="edit-actions">
            <button
              class="btn-mini btn-mini-primary"
              onclick={saveSchedule}
              disabled={savingSchedule}
            >
              {savingSchedule ? 'Salvando…' : 'Salvar'}
            </button>
            <button class="btn-mini" onclick={cancelEditing} disabled={savingSchedule}>
              Cancelar
            </button>
          </div>
          {#if scheduleError}
            <div class="schedule-error">{scheduleError}</div>
          {/if}
          <a
            class="schedule-help tertiary"
            href="https://crontab.guru/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Ajuda com sintaxe cron ↗
          </a>
        {:else}
          <button class="schedule-display" onclick={startEditingSchedule} title="Clique pra editar">
            <span class="schedule-human">{humanizeCron(job.schedule)}</span>
            <code class="schedule-cron mono">{job.schedule}</code>
          </button>
          <span class="tertiary">{job.timezone.replace('America/', '').replace('_', ' ')}</span>
          {#if job.scheduleIsOverridden}
            <span class="override-badge" title="Schedule modificado (default: {job.scheduleDefault})">
              modificado
            </span>
            <button class="reset-link" onclick={resetToDefault} disabled={savingSchedule}>
              resetar
            </button>
          {/if}
        {/if}
      </dd>
    </div>
    <div class="meta-row">
      <dt>Próxima execução</dt>
      <dd class="next-run">
        <span class="next-run-time mono">{nextRunLabel}</span>
      </dd>
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
  .name.humanized {
    font-family: var(--font-sans);
    font-size: 15px;
    letter-spacing: -0.01em;
  }
  .slug {
    display: inline-block;
    background: var(--bg-overlay);
    color: var(--text-tertiary);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    margin-top: var(--space-1);
    align-self: flex-start;
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
  .schedule-cell {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .schedule-display {
    background: transparent;
    border: 1px dashed transparent;
    border-radius: var(--radius-sm);
    padding: 2px 6px;
    margin: -2px -6px;
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    text-align: left;
    cursor: text;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .schedule-display:hover {
    background: var(--bg-hover);
    border-color: var(--border-strong);
  }
  .schedule-human {
    color: var(--text-primary);
    font-size: 13px;
  }
  .schedule-cron {
    color: var(--text-tertiary);
    font-size: 11px;
  }
  .override-badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-warning);
    background: var(--color-warning-bg);
    border: 1px solid var(--color-warning-border);
    border-radius: 3px;
    padding: 1px 6px;
  }
  .reset-link {
    background: transparent;
    color: var(--text-tertiary);
    font-size: 11px;
    text-decoration: underline;
    padding: 0;
  }
  .reset-link:hover {
    color: var(--text-secondary);
  }
  .schedule-input {
    flex: 1 1 200px;
    min-width: 160px;
    padding: var(--space-2) var(--space-3);
    font-size: 13px;
  }
  .edit-actions {
    display: flex;
    gap: var(--space-2);
  }
  .btn-mini {
    padding: var(--space-1) var(--space-3);
    font-size: 12px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  .btn-mini:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .btn-mini-primary {
    background: var(--accent-bg);
    color: var(--accent);
    border-color: var(--border-accent);
  }
  .btn-mini-primary:hover:not(:disabled) {
    background: var(--accent);
    color: white;
  }
  .schedule-error {
    width: 100%;
    color: var(--color-danger);
    font-size: 12px;
    margin-top: var(--space-1);
  }
  .schedule-help {
    width: 100%;
    font-size: 11px;
    text-decoration: none;
    margin-top: var(--space-1);
  }
  .schedule-help:hover {
    color: var(--text-secondary);
  }
  .next-run-time {
    color: var(--accent);
    font-size: 13px;
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
