<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { JobInfo } from '../lib/api';
  import type { JobLogEvent } from '../lib/stream';
  import { jobsApi, ApiError } from '../lib/api';
  import { formatDuration, formatRelative } from '../lib/time';
  import { humanizeCron, nextRunAt, formatCountdown, formatBrtTime } from '../lib/cron';
  import ScheduleEditor from './ScheduleEditor.svelte';

  interface Props {
    job: JobInfo;
    triggering: boolean;
    logs: JobLogEvent[];
    onTrigger: () => void;
    onViewHistory: () => void;
    onScheduleChanged: () => void;
  }

  let { job, triggering, logs, onTrigger, onViewHistory, onScheduleChanged }: Props = $props();

  let logsExpanded = $state(false);
  let logsBody = $state<HTMLDivElement | null>(null);

  // Auto-scroll sempre que logs mudam (independente de expandido ou não)
  $effect(() => {
    if (!logsBody) return;
    void logs.length;
    void tick().then(() => {
      if (logsBody) logsBody.scrollTop = logsBody.scrollHeight;
    });
  });

  function formatLogTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  const statusInfo = $derived(deriveStatus(job));

  let scheduleEditorOpen = $state(false);
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

  async function saveSchedule(newCron: string): Promise<void> {
    savingSchedule = true;
    try {
      await jobsApi.updateSchedule(job.name, newCron);
      scheduleEditorOpen = false;
      onScheduleChanged();
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 400
          ? ((err.body as { message?: string } | null)?.message ?? 'Schedule inválido')
          : 'Erro ao salvar';
      throw new Error(message);
    } finally {
      savingSchedule = false;
    }
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
        <span class="schedule-human">{humanizeCron(job.schedule)}</span>
        <span class="tertiary">{job.timezone.replace('America/', '').replace('_', ' ')}</span>
        <button
          class="edit-schedule-btn"
          onclick={() => (scheduleEditorOpen = true)}
          aria-label="Editar agendamento"
          title="Editar agendamento"
        >
          ✎ Editar
        </button>
        {#if job.scheduleIsOverridden}
          <span class="override-badge" title="Schedule modificado (padrão: {job.scheduleDefault})">
            modificado
          </span>
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
          <span class="mono">{formatRelative(job.lastRun.startedAt, now)}</span>
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

  {#if logs.length > 0 || job.lastRun?.status === 'running'}
    <section class="logs-panel" class:logs-expanded={logsExpanded}>
      <button
        class="logs-toggle"
        onclick={() => (logsExpanded = !logsExpanded)}
        title={logsExpanded ? 'Reduzir painel' : 'Expandir painel'}
      >
        <span class="logs-toggle-icon">{logsExpanded ? '▾' : '▸'}</span>
        <span class="logs-toggle-label">
          {job.lastRun?.status === 'running' ? 'Logs ao vivo' : 'Últimos logs'}
        </span>
        <span class="logs-count">{logs.length}</span>
      </button>
      <div class="logs-body" bind:this={logsBody}>
        {#if logs.length === 0}
          <div class="logs-empty">aguardando primeiro log…</div>
        {:else}
          {#each logs as log, i (log.timestamp + i)}
            <div class="log-line" data-level={log.level}>
              <span class="log-time mono">{formatLogTime(log.timestamp)}</span>
              <span class="log-level-dot" data-level={log.level} title={log.level}>
                {log.level.charAt(0).toUpperCase()}
              </span>
              <span class="log-msg">
                {log.message}{#if log.data && Object.keys(log.data).length > 0}<span class="log-data mono">  {JSON.stringify(log.data).slice(0, 160)}</span>{/if}
              </span>
            </div>
          {/each}
        {/if}
      </div>
    </section>
  {/if}

  <footer class="actions">
    <button class="btn-ghost" onclick={onViewHistory}>Histórico</button>
    <button class="btn-primary" onclick={onTrigger} disabled={triggering}>
      {triggering ? 'Disparando…' : 'Rodar agora'}
    </button>
  </footer>
</article>

{#if scheduleEditorOpen}
  <ScheduleEditor
    jobName={job.name}
    jobDisplayName={job.displayName ?? job.name}
    currentSchedule={job.schedule}
    defaultSchedule={job.scheduleDefault}
    timezone={job.timezone}
    onCancel={() => (scheduleEditorOpen = false)}
    onSave={saveSchedule}
  />
{/if}

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
    min-height: 320px;
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
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-subtle);
  }
  .meta-row {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: var(--space-3);
    align-items: baseline;
    min-height: 22px;
  }
  .meta-row dt {
    font-size: 12px;
    color: var(--text-tertiary);
  }
  .meta-row dd {
    margin: 0;
    font-size: 13px;
    color: var(--text-primary);
    min-width: 0;
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
  .schedule-human {
    color: var(--text-primary);
    font-size: 13px;
  }
  .edit-schedule-btn {
    padding: 2px 8px;
    background: var(--bg-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 11px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .edit-schedule-btn:hover {
    background: var(--accent-bg);
    color: var(--accent);
    border-color: var(--border-accent);
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
  .next-run-time {
    color: var(--accent);
    font-size: 13px;
  }

  /* — Logs panel — */
  .logs-panel {
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .logs-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    color: var(--text-secondary);
    font-size: 12px;
    text-align: left;
    transition: background var(--duration-fast) var(--easing-default);
  }
  .logs-toggle:hover {
    background: var(--bg-hover);
  }
  .logs-toggle-icon {
    color: var(--text-tertiary);
    font-size: 10px;
    width: 12px;
  }
  .logs-toggle-label {
    flex: 1;
  }
  .logs-count {
    color: var(--text-tertiary);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .logs-body {
    max-height: 130px;
    overflow-y: auto;
    padding: var(--space-2) var(--space-3);
    background: #060708;
    border-top: 1px solid var(--border-subtle);
    font-size: 12px;
    line-height: 1.45;
    transition: max-height var(--duration-normal) var(--easing-default);
  }
  .logs-panel.logs-expanded .logs-body {
    max-height: 320px;
  }
  .logs-empty {
    color: var(--text-tertiary);
    text-align: center;
    padding: var(--space-3);
    font-style: italic;
  }
  .log-line {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 8px;
    padding: 3px 0;
    align-items: baseline;
  }
  .log-time {
    color: var(--text-tertiary);
    font-size: 10px;
    flex-shrink: 0;
    align-self: baseline;
    font-variant-numeric: tabular-nums;
  }
  .log-level-dot {
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    font-family: var(--font-mono);
    align-self: baseline;
    margin-top: 2px;
  }
  .log-level-dot[data-level='info'] {
    background: rgba(96, 165, 250, 0.15);
    color: var(--color-info);
  }
  .log-level-dot[data-level='warn'] {
    background: rgba(251, 191, 36, 0.15);
    color: var(--color-warning);
  }
  .log-level-dot[data-level='error'] {
    background: rgba(248, 113, 113, 0.18);
    color: var(--color-danger);
  }
  .log-level-dot[data-level='debug'] {
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-tertiary);
  }
  .log-msg {
    color: var(--text-primary);
    min-width: 0;
    word-break: break-word;
  }
  .log-line[data-level='warn'] .log-msg {
    color: var(--color-warning);
  }
  .log-line[data-level='error'] .log-msg {
    color: var(--color-danger);
  }
  .log-line[data-level='debug'] .log-msg {
    color: var(--text-secondary);
  }
  .log-data {
    color: var(--text-tertiary);
    font-size: 10px;
    margin-left: 4px;
    opacity: 0.7;
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
    margin-top: auto;
    padding-top: var(--space-2);
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
