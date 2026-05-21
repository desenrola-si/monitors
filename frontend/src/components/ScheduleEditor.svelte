<script lang="ts">
  import { onMount } from 'svelte';
  import { humanizeCron, nextRunAt, formatCountdown, formatBrtTime } from '../lib/cron';
  import {
    detectPreset,
    presetToCron,
    UNIT_LABELS_PT,
    WEEKDAY_LABELS_PT,
    type ScheduleMode,
    type FrequencyUnit,
    type Weekday,
  } from '../lib/schedule';

  interface Props {
    jobName: string;
    jobDisplayName: string;
    currentSchedule: string;
    defaultSchedule: string;
    timezone: string;
    onCancel: () => void;
    onSave: (newSchedule: string) => Promise<void>;
  }

  let {
    jobName,
    jobDisplayName,
    currentSchedule,
    defaultSchedule,
    timezone,
    onCancel,
    onSave,
  }: Props = $props();

  // Detecta modo baseado no schedule atual
  const initialPreset = detectPreset(currentSchedule);
  let mode = $state<ScheduleMode>(initialPreset.mode);

  // Estado por modo
  let freqEvery = $state(initialPreset.mode === 'frequency' ? initialPreset.every : 5);
  let freqUnit = $state<FrequencyUnit>(
    initialPreset.mode === 'frequency' ? initialPreset.unit : 'minutes',
  );

  let timeHour = $state(initialPreset.mode === 'time-of-day' ? initialPreset.hour : 6);
  let timeMinute = $state(initialPreset.mode === 'time-of-day' ? initialPreset.minute : 0);
  let weekdays = $state<Weekday[]>(
    initialPreset.mode === 'time-of-day' ? initialPreset.weekdays : [],
  );

  let advancedCron = $state(
    initialPreset.mode === 'advanced' ? initialPreset.cron : currentSchedule,
  );

  let saving = $state(false);
  let error = $state<string | null>(null);

  // Cron resultante (computed)
  const computedCron = $derived.by(() => {
    try {
      if (mode === 'frequency') {
        return presetToCron({ mode: 'frequency', every: freqEvery, unit: freqUnit });
      }
      if (mode === 'time-of-day') {
        return presetToCron({
          mode: 'time-of-day',
          hour: timeHour,
          minute: timeMinute,
          weekdays,
        });
      }
      return advancedCron.trim();
    } catch {
      return '';
    }
  });

  const previewHuman = $derived(humanizeCron(computedCron));
  const previewNext = $derived.by(() => {
    const next = nextRunAt(computedCron, timezone);
    if (!next) return null;
    return `${formatBrtTime(next)} · ${formatCountdown(next)}`;
  });

  function toggleWeekday(w: Weekday): void {
    if (weekdays.includes(w)) {
      weekdays = weekdays.filter((d) => d !== w);
    } else {
      weekdays = [...weekdays, w].sort((a, b) => a - b);
    }
  }

  async function save(): Promise<void> {
    if (saving) return;
    error = null;
    if (!computedCron) {
      error = 'Schedule vazio';
      return;
    }
    saving = true;
    try {
      await onSave(computedCron);
    } catch (err) {
      error =
        err instanceof Error ? err.message : 'Erro ao salvar';
    } finally {
      saving = false;
    }
  }

  function resetToDefault(): void {
    advancedCron = defaultSchedule;
    const detected = detectPreset(defaultSchedule);
    mode = detected.mode;
    if (detected.mode === 'frequency') {
      freqEvery = detected.every;
      freqUnit = detected.unit;
    } else if (detected.mode === 'time-of-day') {
      timeHour = detected.hour;
      timeMinute = detected.minute;
      weekdays = detected.weekdays;
    }
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
  }

  onMount(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  });

  const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 0];
  const isChanged = $derived(computedCron !== currentSchedule);
</script>

<svelte:window onkeydown={handleKey} />

<div class="backdrop" onclick={onCancel} role="presentation"></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="Editar agendamento de {jobName}">
  <header class="modal-header">
    <div>
      <span class="modal-eyebrow">Editar agendamento</span>
      <h2 class="modal-title">{jobDisplayName}</h2>
    </div>
    <button class="close-btn" onclick={onCancel} aria-label="Fechar">✕</button>
  </header>

  <div class="tabs">
    <button
      class="tab"
      class:tab-active={mode === 'frequency'}
      onclick={() => (mode = 'frequency')}
    >
      <span class="tab-icon">⚡</span>
      <span>Repetir</span>
    </button>
    <button
      class="tab"
      class:tab-active={mode === 'time-of-day'}
      onclick={() => (mode = 'time-of-day')}
    >
      <span class="tab-icon">🕐</span>
      <span>Horário fixo</span>
    </button>
    <button
      class="tab"
      class:tab-active={mode === 'advanced'}
      onclick={() => (mode = 'advanced')}
    >
      <span class="tab-icon">⚙</span>
      <span>Avançado</span>
    </button>
  </div>

  <div class="modal-body">
    {#if mode === 'frequency'}
      <div class="field">
        <label>A cada</label>
        <div class="row">
          <input
            type="number"
            min="1"
            max="999"
            bind:value={freqEvery}
            class="num-input"
          />
          <select bind:value={freqUnit} class="select">
            <option value="minutes">{freqEvery === 1 ? UNIT_LABELS_PT.minutes.singular : UNIT_LABELS_PT.minutes.plural}</option>
            <option value="hours">{freqEvery === 1 ? UNIT_LABELS_PT.hours.singular : UNIT_LABELS_PT.hours.plural}</option>
            <option value="days">{freqEvery === 1 ? UNIT_LABELS_PT.days.singular : UNIT_LABELS_PT.days.plural}</option>
          </select>
        </div>
        <p class="hint">
          {freqUnit === 'minutes' ? `Vai disparar em :00, :${String(freqEvery).padStart(2, '0')}, :${String(freqEvery * 2).padStart(2, '0')}…` : ''}
          {freqUnit === 'hours' ? `Vai disparar todo dia a cada ${freqEvery}h, começando em 00:00` : ''}
          {freqUnit === 'days' ? `Vai disparar à meia-noite a cada ${freqEvery} dia(s)` : ''}
        </p>
      </div>

      <div class="presets">
        <span class="presets-label">Atalhos:</span>
        <button class="preset-chip" onclick={() => { freqEvery = 5; freqUnit = 'minutes'; }}>
          5 minutos
        </button>
        <button class="preset-chip" onclick={() => { freqEvery = 15; freqUnit = 'minutes'; }}>
          15 minutos
        </button>
        <button class="preset-chip" onclick={() => { freqEvery = 30; freqUnit = 'minutes'; }}>
          30 minutos
        </button>
        <button class="preset-chip" onclick={() => { freqEvery = 1; freqUnit = 'hours'; }}>
          1 hora
        </button>
        <button class="preset-chip" onclick={() => { freqEvery = 6; freqUnit = 'hours'; }}>
          6 horas
        </button>
      </div>
    {/if}

    {#if mode === 'time-of-day'}
      <div class="field">
        <label>Todo dia às</label>
        <div class="row">
          <input
            type="number"
            min="0"
            max="23"
            bind:value={timeHour}
            class="num-input"
            aria-label="Hora"
          />
          <span class="time-sep">:</span>
          <input
            type="number"
            min="0"
            max="59"
            bind:value={timeMinute}
            class="num-input"
            aria-label="Minuto"
          />
          <span class="tertiary">({timezone.replace('America/', '').replace('_', ' ')})</span>
        </div>
      </div>

      <div class="field">
        <label>Dias da semana</label>
        <div class="weekday-row">
          {#each WEEKDAYS as w}
            <button
              class="weekday-chip"
              class:weekday-active={weekdays.length === 0 || weekdays.includes(w)}
              onclick={() => toggleWeekday(w)}
            >
              {WEEKDAY_LABELS_PT[w].short}
            </button>
          {/each}
        </div>
        <p class="hint">
          {weekdays.length === 0 || weekdays.length === 7
            ? 'Todos os dias'
            : `Apenas: ${weekdays.map((w) => WEEKDAY_LABELS_PT[w].long).join(', ')}`}
        </p>
      </div>

      <div class="presets">
        <span class="presets-label">Atalhos:</span>
        <button class="preset-chip" onclick={() => { timeHour = 6; timeMinute = 0; weekdays = []; }}>
          Toda manhã 06:00
        </button>
        <button class="preset-chip" onclick={() => { timeHour = 9; timeMinute = 0; weekdays = [1, 2, 3, 4, 5]; }}>
          Seg–Sex 09:00
        </button>
        <button class="preset-chip" onclick={() => { timeHour = 22; timeMinute = 0; weekdays = []; }}>
          Toda noite 22:00
        </button>
      </div>
    {/if}

    {#if mode === 'advanced'}
      <div class="field">
        <label>Expressão cron</label>
        <input
          type="text"
          bind:value={advancedCron}
          class="cron-input mono"
          placeholder="*/5 * * * *"
        />
        <p class="hint">
          Formato: <span class="mono">minuto hora dia mês dia-semana</span>.
          <a href="https://crontab.guru/" target="_blank" rel="noopener noreferrer">
            crontab.guru ↗
          </a>
        </p>
      </div>
    {/if}

    <!-- Preview ao vivo -->
    <div class="preview">
      <div class="preview-row">
        <span class="preview-label">Quando vai rodar</span>
        <span class="preview-value">{previewHuman}</span>
      </div>
      <div class="preview-row">
        <span class="preview-label">Próxima execução</span>
        <span class="preview-value mono">{previewNext ?? '—'}</span>
      </div>
      <div class="preview-row">
        <span class="preview-label">Expressão cron</span>
        <span class="preview-value mono cron-text">{computedCron || '—'}</span>
      </div>
    </div>

    {#if error}
      <div class="error">{error}</div>
    {/if}
  </div>

  <footer class="modal-footer">
    {#if currentSchedule !== defaultSchedule}
      <button class="btn-link" onclick={resetToDefault} disabled={saving}>
        Resetar pro padrão
      </button>
    {/if}
    <div class="footer-actions">
      <button class="btn-ghost" onclick={onCancel} disabled={saving}>
        Cancelar
      </button>
      <button
        class="btn-primary"
        onclick={save}
        disabled={saving || !isChanged || !computedCron}
      >
        {saving ? 'Salvando…' : 'Salvar'}
      </button>
    </div>
  </footer>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 200;
    animation: fade-in var(--duration-normal) var(--easing-default);
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
    z-index: 201;
    display: flex;
    flex-direction: column;
    animation: pop-in var(--duration-normal) var(--easing-default);
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
  }
  .modal-eyebrow {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    display: block;
  }
  .modal-title {
    margin: var(--space-1) 0 0 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }
  .close-btn {
    color: var(--text-tertiary);
    font-size: 18px;
    padding: var(--space-1) var(--space-2);
    transition: color var(--duration-fast) var(--easing-default);
  }
  .close-btn:hover {
    color: var(--text-primary);
  }

  .tabs {
    display: flex;
    gap: 4px;
    padding: var(--space-3) var(--space-5) 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .tab {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    color: var(--text-tertiary);
    font-size: 13px;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .tab:hover { color: var(--text-secondary); }
  .tab.tab-active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
  }
  .tab-icon { font-size: 14px; }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
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
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .hint {
    margin: 0;
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .hint a {
    color: var(--accent);
    text-decoration: none;
  }
  .hint a:hover { color: var(--accent-hover); }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .num-input {
    width: 80px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-size: 15px;
    font-weight: 600;
  }
  .select {
    flex: 1;
    padding: var(--space-3) var(--space-4);
    background: var(--bg-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 14px;
  }
  .time-sep {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-tertiary);
  }
  .cron-input {
    font-size: 14px;
    padding: var(--space-3) var(--space-4);
  }

  .weekday-row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .weekday-chip {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--text-tertiary);
    font-size: 12px;
    min-width: 48px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .weekday-chip:hover { background: var(--bg-hover); }
  .weekday-chip.weekday-active {
    background: var(--accent-bg);
    color: var(--accent);
    border-color: var(--border-accent);
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  .presets-label {
    font-size: 12px;
    color: var(--text-tertiary);
  }
  .preset-chip {
    padding: var(--space-1) var(--space-3);
    background: var(--bg-overlay);
    border: 1px solid var(--border-strong);
    border-radius: 100px;
    color: var(--text-secondary);
    font-size: 12px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .preset-chip:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-accent);
  }

  .preview {
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .preview-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
  }
  .preview-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
  }
  .preview-value {
    font-size: 13px;
    color: var(--text-primary);
    text-align: right;
  }
  .cron-text {
    color: var(--accent);
    font-size: 12px;
  }

  .error {
    color: var(--color-danger);
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    font-size: 13px;
  }

  .modal-footer {
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
  }
  .btn-link {
    color: var(--text-tertiary);
    font-size: 12px;
    text-decoration: underline;
    padding: 0;
  }
  .btn-link:hover { color: var(--text-secondary); }
  .footer-actions {
    display: flex;
    gap: var(--space-2);
  }
  .btn-ghost {
    padding: var(--space-3) var(--space-5);
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    font-size: 13px;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-primary {
    padding: var(--space-3) var(--space-5);
    background: var(--accent);
    color: white;
    border-radius: var(--radius-md);
    font-size: 13px;
    font-weight: 500;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-primary:disabled {
    background: var(--bg-hover);
    color: var(--text-tertiary);
    cursor: not-allowed;
  }
</style>
