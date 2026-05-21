<script lang="ts">
  import { onMount } from 'svelte';
  import { jobsApi, type JobLogEntry } from '../lib/api';
  import type { JobLogEvent, JobLogLevel } from '../lib/stream';

  interface Props {
    jobName: string;
    jobDisplayName: string;
    /** Logs ao vivo do Dashboard (vem via SSE buffer). Quando muda, concatenamos. */
    liveLogs: JobLogEvent[];
    onClose: () => void;
  }

  let { jobName, jobDisplayName, liveLogs, onClose }: Props = $props();

  type LogEntry = JobLogEntry | JobLogEvent;

  let logs = $state<LogEntry[]>([]);
  let loadLimit = $state(100);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let copied = $state(false);

  // Filtros
  let levelFilter = $state<Set<JobLogLevel>>(
    new Set<JobLogLevel>(['debug', 'info', 'warn', 'error']),
  );
  let searchQuery = $state('');
  let listBody: HTMLDivElement | null = $state(null);
  let autoScroll = $state(true);

  async function load(limit: number): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await jobsApi.logs(jobName, limit);
      logs = res.logs;
      // scroll pra baixo após carregar
      await new Promise((r) => setTimeout(r, 50));
      if (listBody && autoScroll) listBody.scrollTop = listBody.scrollHeight;
    } catch (err) {
      error = err instanceof Error ? err.message : 'erro ao carregar logs';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load(loadLimit);
  });

  // Append logs ao vivo do Dashboard (SSE). Compara por timestamp pra evitar dup.
  $effect(() => {
    if (liveLogs.length === 0) return;
    const lastTs = logs[logs.length - 1]?.timestamp ?? '';
    const newOnes = liveLogs.filter(
      (l) => l.timestamp > lastTs && !logs.some((x) => x.timestamp === l.timestamp && x.message === l.message),
    );
    if (newOnes.length === 0) return;
    logs = [...logs, ...newOnes].slice(-1000);
    if (autoScroll) {
      void new Promise((r) => setTimeout(r, 30)).then(() => {
        if (listBody) listBody.scrollTop = listBody.scrollHeight;
      });
    }
  });

  const filtered = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return logs.filter((l) => {
      if (!levelFilter.has(l.level)) return false;
      if (q && !l.message.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  function toggleLevel(lvl: JobLogLevel): void {
    const next = new Set(levelFilter);
    if (next.has(lvl)) next.delete(lvl);
    else next.add(lvl);
    levelFilter = next;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatFullTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }

  async function copyAll(): Promise<void> {
    const text = filtered
      .map((l) => {
        const dataStr =
          l.data && Object.keys(l.data).length > 0
            ? ' ' + JSON.stringify(l.data)
            : '';
        return `[${formatFullTime(l.timestamp)}] [${l.level.toUpperCase()}] ${l.message}${dataStr}`;
      })
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch (err) {
      console.error('copy failed', err);
    }
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && filtered.length > 0) {
      // só intercepta se nada está selecionado
      const sel = window.getSelection?.()?.toString() ?? '';
      if (!sel) {
        e.preventDefault();
        void copyAll();
      }
    }
  }

  function handleScroll(): void {
    if (!listBody) return;
    const isAtBottom =
      listBody.scrollHeight - listBody.scrollTop - listBody.clientHeight < 30;
    autoScroll = isAtBottom;
  }

  onMount(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  });

  const LEVELS: JobLogLevel[] = ['debug', 'info', 'warn', 'error'];
  const LEVEL_LABEL: Record<JobLogLevel, string> = {
    debug: 'Debug',
    info: 'Info',
    warn: 'Warn',
    error: 'Error',
  };
</script>

<svelte:window onkeydown={handleKey} />

<div class="backdrop" onclick={onClose} role="presentation"></div>
<div
  class="modal"
  role="dialog"
  aria-modal="true"
  aria-label="Logs de {jobDisplayName}"
>
  <header class="modal-header">
    <div>
      <span class="eyebrow">Logs</span>
      <h2 class="title">{jobDisplayName}</h2>
    </div>
    <button class="close" onclick={onClose} aria-label="Fechar">✕</button>
  </header>

  <div class="toolbar">
    <div class="filters">
      {#each LEVELS as lvl}
        <button
          class="level-chip"
          class:active={levelFilter.has(lvl)}
          data-level={lvl}
          onclick={() => toggleLevel(lvl)}
        >
          <span class="chip-dot" data-level={lvl}></span>
          {LEVEL_LABEL[lvl]}
        </button>
      {/each}
    </div>
    <input
      type="text"
      placeholder="Buscar no log…"
      bind:value={searchQuery}
      class="search"
    />
    <select bind:value={loadLimit} onchange={() => load(loadLimit)} class="range-select">
      <option value={100}>Últimos 100</option>
      <option value={250}>Últimos 250</option>
      <option value={500}>Últimos 500</option>
    </select>
    <button class="copy-btn" onclick={copyAll} disabled={filtered.length === 0}>
      {copied ? '✓ Copiado' : 'Copiar'}
    </button>
  </div>

  <div class="logs-list" bind:this={listBody} onscroll={handleScroll}>
    {#if loading}
      <div class="state">carregando…</div>
    {:else if error}
      <div class="state state-error">{error}</div>
    {:else if filtered.length === 0}
      <div class="state">
        {logs.length === 0
          ? 'Nenhum log registrado ainda'
          : 'Nenhum log bate com os filtros atuais'}
      </div>
    {:else}
      {#each filtered as log, i (log.timestamp + i + log.message.slice(0, 20))}
        <div class="log-line" data-level={log.level}>
          <span class="log-time mono" title={formatFullTime(log.timestamp)}>
            {formatTime(log.timestamp)}
          </span>
          <span class="log-level" data-level={log.level}>
            {log.level.charAt(0).toUpperCase()}
          </span>
          <div class="log-content">
            <div class="log-msg">{log.message}</div>
            {#if log.data && Object.keys(log.data).length > 0}
              <div class="log-data mono">{JSON.stringify(log.data, null, 2)}</div>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <footer class="modal-footer">
    <span class="count">
      {filtered.length} de {logs.length} {logs.length === 1 ? 'log' : 'logs'}
    </span>
    {#if !autoScroll}
      <button
        class="follow-btn"
        onclick={() => {
          autoScroll = true;
          if (listBody) listBody.scrollTop = listBody.scrollHeight;
        }}
      >
        ↓ Acompanhar fim
      </button>
    {:else}
      <span class="follow-status">📡 acompanhando</span>
    {/if}
  </footer>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    z-index: 200;
    animation: fade-in var(--duration-normal) var(--easing-default);
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(900px, calc(100vw - 32px));
    height: calc(100vh - 80px);
    max-height: 800px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
    z-index: 201;
    display: flex;
    flex-direction: column;
    animation: pop-in var(--duration-normal) var(--easing-default);
    overflow: hidden;
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes pop-in {
    from { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
    to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }

  .modal-header {
    padding: var(--space-5);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    flex-shrink: 0;
  }
  .eyebrow {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    display: block;
  }
  .title {
    margin: var(--space-1) 0 0 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }
  .close {
    color: var(--text-tertiary);
    font-size: 18px;
    padding: var(--space-1) var(--space-2);
    transition: color var(--duration-fast) var(--easing-default);
  }
  .close:hover { color: var(--text-primary); }

  .toolbar {
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    gap: var(--space-3);
    align-items: center;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .filters {
    display: flex;
    gap: 4px;
  }
  .level-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 100px;
    color: var(--text-tertiary);
    font-size: 11px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .level-chip:hover { background: var(--bg-hover); }
  .level-chip.active {
    background: var(--bg-overlay);
    color: var(--text-primary);
    border-color: var(--border-accent);
  }
  .chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .chip-dot[data-level='info'] { background: var(--color-info); }
  .chip-dot[data-level='warn'] { background: var(--color-warning); }
  .chip-dot[data-level='error'] { background: var(--color-danger); }
  .chip-dot[data-level='debug'] { background: var(--text-tertiary); }

  .search {
    flex: 1;
    min-width: 180px;
    padding: var(--space-2) var(--space-3);
    font-size: 13px;
  }
  .range-select {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }
  .copy-btn {
    padding: var(--space-2) var(--space-4);
    background: var(--accent-bg);
    color: var(--accent);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-md);
    font-size: 12px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .copy-btn:hover:not(:disabled) {
    background: var(--accent);
    color: white;
  }
  .copy-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .logs-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-3) var(--space-5);
    background: #060708;
    font-size: 13px;
    line-height: 1.55;
  }
  .state {
    color: var(--text-tertiary);
    text-align: center;
    padding: var(--space-7);
    font-style: italic;
  }
  .state-error { color: var(--color-danger); }

  .log-line {
    display: grid;
    grid-template-columns: 70px 18px 1fr;
    gap: 10px;
    padding: 4px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    align-items: baseline;
  }
  .log-line:last-child { border-bottom: none; }

  .log-time {
    color: var(--text-tertiary);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    cursor: help;
  }
  .log-level {
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    font-family: var(--font-mono);
    margin-top: 2px;
  }
  .log-level[data-level='info'] {
    background: rgba(96, 165, 250, 0.15);
    color: var(--color-info);
  }
  .log-level[data-level='warn'] {
    background: rgba(251, 191, 36, 0.18);
    color: var(--color-warning);
  }
  .log-level[data-level='error'] {
    background: rgba(248, 113, 113, 0.2);
    color: var(--color-danger);
  }
  .log-level[data-level='debug'] {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-tertiary);
  }
  .log-content { min-width: 0; }
  .log-msg {
    color: var(--text-primary);
    word-break: break-word;
  }
  .log-line[data-level='warn'] .log-msg { color: var(--color-warning); }
  .log-line[data-level='error'] .log-msg { color: var(--color-danger); }
  .log-line[data-level='debug'] .log-msg { color: var(--text-secondary); }

  .log-data {
    margin-top: 4px;
    padding: 6px 10px;
    background: rgba(255, 255, 255, 0.025);
    border-left: 2px solid var(--border-strong);
    color: var(--text-tertiary);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    border-radius: 0 4px 4px 0;
  }

  .modal-footer {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  .count {
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .follow-btn {
    padding: var(--space-1) var(--space-3);
    background: var(--accent-bg);
    color: var(--accent);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-sm);
    font-size: 11px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .follow-btn:hover {
    background: var(--accent);
    color: white;
  }
  .follow-status {
    color: var(--color-success);
    font-size: 11px;
  }
</style>
