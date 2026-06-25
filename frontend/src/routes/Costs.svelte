<script lang="ts">
  import { onMount } from 'svelte';
  import { costsApi, type CostBreakdown, type CostTokens, ApiError } from '../lib/api';

  interface Props {
    onUnauthorized: () => void;
  }

  let { onUnauthorized }: Props = $props();

  let data = $state<CostBreakdown | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let tab = $state<'client' | 'workflow' | 'model'>('client');

  function isoDaysAgo(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  let from = $state(isoDaysAgo(29));
  let to = $state(isoDaysAgo(0));

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      data = await costsApi.breakdown(from, to);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      error = err instanceof Error ? err.message : 'erro ao carregar';
    } finally {
      loading = false;
    }
  }

  function usd(v: number): string {
    return `$${v.toFixed(v < 1 ? 4 : 2)}`;
  }
  function brl(v: number): string {
    return `R$ ${v.toFixed(2).replace('.', ',')}`;
  }
  function num(v: number): string {
    return v.toLocaleString('pt-BR');
  }
  function cacheHit(t: CostTokens): string {
    if (!t.prompt) return '—';
    return `${((100 * t.cached) / t.prompt).toFixed(0)}%`;
  }

  onMount(() => {
    void load();
  });
</script>

<div class="costs">
  <div class="toolbar">
    <div class="period">
      <label class="field">
        <span class="field-label mono">de</span>
        <input type="date" bind:value={from} max={to} />
      </label>
      <label class="field">
        <span class="field-label mono">até</span>
        <input type="date" bind:value={to} min={from} />
      </label>
      <button class="apply" onclick={() => void load()}>Aplicar</button>
    </div>
  </div>

  {#if loading}
    <p class="state">carregando custos…</p>
  {:else if error}
    <p class="state state-error">{error}</p>
  {:else if data}
    <div class="totals">
      <div class="total-card primary">
        <span class="total-label">Total no período</span>
        <span class="total-value">{usd(data.total.usd)}</span>
        <span class="total-sub mono">{brl(data.total.brl)}</span>
      </div>
      <div class="total-card">
        <span class="total-label">Chamadas de IA</span>
        <span class="total-value">{num(data.total.calls)}</span>
        <span class="total-sub mono">{data.byClient.length} cliente(s)</span>
      </div>
      <div class="total-card">
        <span class="total-label">Cache hit</span>
        <span class="total-value">{cacheHit(data.total.tokens)}</span>
        <span class="total-sub mono">{num(data.total.tokens.prompt)} tok in</span>
      </div>
      <div class="total-card">
        <span class="total-label">Tokens saída</span>
        <span class="total-value">{num(data.total.tokens.completion)}</span>
        <span class="total-sub mono">tokens out</span>
      </div>
    </div>

    {#if data.total.unpricedCalls > 0}
      <p class="warn mono">
        {num(data.total.unpricedCalls)} chamada(s) de modelo sem tabela de preço — não somadas ao custo.
      </p>
    {/if}

    <div class="tabs">
      <button class="tab" class:active={tab === 'client'} onclick={() => (tab = 'client')}>
        Por cliente
      </button>
      <button class="tab" class:active={tab === 'workflow'} onclick={() => (tab = 'workflow')}>
        Por workflow
      </button>
      <button class="tab" class:active={tab === 'model'} onclick={() => (tab = 'model')}>
        Por modelo
      </button>
    </div>

    <table class="grid-table">
      <thead>
        <tr>
          <th>{tab === 'client' ? 'Cliente' : tab === 'workflow' ? 'Workflow' : 'Provedor / Modelo'}</th>
          <th class="num">Chamadas</th>
          <th class="num">Cache hit</th>
          <th class="num">USD</th>
          <th class="num">BRL</th>
        </tr>
      </thead>
      <tbody>
        {#if tab === 'client'}
          {#each data.byClient as row (row.tenantId)}
            <tr>
              <td><span class="row-name">{row.name ?? row.tenantId}</span></td>
              <td class="num">{num(row.calls)}</td>
              <td class="num">{cacheHit(row.tokens)}</td>
              <td class="num strong">{usd(row.usd)}</td>
              <td class="num mono">{brl(row.brl)}</td>
            </tr>
          {/each}
          {#if data.byClient.length === 0}
            <tr><td colspan="5" class="empty">Sem custo no período.</td></tr>
          {/if}
        {:else if tab === 'workflow'}
          {#each data.byWorkflow as row (row.workflowDefinitionId ?? row.tenantId)}
            <tr>
              <td>
                <span class="row-name">{row.name ?? row.slug ?? '(sem definição)'}</span>
                {#if row.slug}<span class="row-sub mono">{row.slug}</span>{/if}
              </td>
              <td class="num">{num(row.calls)}</td>
              <td class="num">{cacheHit(row.tokens)}</td>
              <td class="num strong">{usd(row.usd)}</td>
              <td class="num mono">{brl(row.brl)}</td>
            </tr>
          {/each}
          {#if data.byWorkflow.length === 0}
            <tr><td colspan="5" class="empty">Sem custo no período.</td></tr>
          {/if}
        {:else}
          {#each data.byModel as row (`${row.provider}|${row.model}`)}
            <tr>
              <td>
                <span class="row-name">
                  {row.model ?? '(desconhecido)'}
                  {#if !row.priced}<span class="badge-unpriced">sem preço</span>{/if}
                </span>
                {#if row.provider}<span class="row-sub mono">{row.provider}</span>{/if}
              </td>
              <td class="num">{num(row.calls)}</td>
              <td class="num">{cacheHit(row.tokens)}</td>
              <td class="num strong">{row.priced ? usd(row.usd) : '—'}</td>
              <td class="num mono">{row.priced ? brl(row.brl) : '—'}</td>
            </tr>
          {/each}
          {#if data.byModel.length === 0}
            <tr><td colspan="5" class="empty">Sem custo no período.</td></tr>
          {/if}
        {/if}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .costs {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .toolbar {
    display: flex;
    justify-content: flex-end;
  }
  .period {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .field-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
  }
  .field input {
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    padding: var(--space-2) var(--space-3);
    font-size: 13px;
  }
  .apply {
    background: var(--color-accent, var(--bg-hover));
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    font-size: 13px;
    cursor: pointer;
    transition: all var(--duration-fast) var(--easing-default);
  }
  .apply:hover {
    background: var(--bg-hover);
  }

  .totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-4);
  }
  .total-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .total-card.primary {
    border-color: var(--color-success);
  }
  .total-label {
    font-size: 12px;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .total-value {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text-primary);
  }
  .total-sub {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .warn {
    font-size: 12px;
    color: var(--color-warning, var(--text-tertiary));
  }

  .tabs {
    display: flex;
    gap: var(--space-2);
    border-bottom: 1px solid var(--border-subtle);
  }
  .tab {
    padding: var(--space-2) var(--space-3);
    font-size: 13px;
    color: var(--text-tertiary);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
    transition: color var(--duration-fast) var(--easing-default);
  }
  .tab:hover {
    color: var(--text-secondary);
  }
  .tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--color-success);
  }

  .grid-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .grid-table th {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    color: var(--text-tertiary);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border-subtle);
  }
  .grid-table td {
    padding: var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    vertical-align: top;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .strong {
    color: var(--text-primary);
    font-weight: 600;
  }
  .row-name {
    display: block;
    color: var(--text-primary);
  }
  .row-sub {
    display: block;
    font-size: 11px;
    color: var(--text-tertiary);
    margin-top: 2px;
  }
  .badge-unpriced {
    display: inline-block;
    margin-left: var(--space-2);
    padding: 1px 6px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-warning, #d9a441);
    border: 1px solid var(--color-warning, #d9a441);
    border-radius: var(--radius-sm);
  }
  .empty {
    text-align: center;
    color: var(--text-tertiary);
    padding: var(--space-6);
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
