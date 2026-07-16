import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type {
  EffortLevel,
  ModelCatalogEntry,
  ModelCatalogResponse,
  ModelSelection,
} from '@argus/shared-types';
import { api } from '../lib/api';
import { Select, type SelectOption } from './ui/Select';
import { cn } from '../lib/utils';

/**
 * Catalog-driven model picker, shared by the new-session dialog and
 * the session header chip.
 *
 * The control set is generic — it renders whatever the agent's
 * catalog declares, with no adapter-specific branches:
 *
 *   - entries without `family` are flat options (claude-code, codex)
 *   - entries sharing a `family` collapse into one option + a second
 *     variant select (cursor-cli's slug matrix)
 *   - facet controls (effort / 1M context / fast tier) appear only
 *     when the selected entry declares them
 *
 * Two invariants from the design:
 *   - "Default" (empty selection) is always first and means "pass no
 *     model flags" — the CLI decides, identical to pre-picker behavior
 *   - the catalog constrains the UI but never the dispatch: a custom
 *     free-text model id is always available (and is the automatic
 *     fallback when the catalog can't be fetched), and whatever is
 *     selected passes through to the CLI opaquely
 */

// Module-level cache so reopening the dialog doesn't refetch (the
// server caches too — this just skips the round-trip + spinner).
const catalogCache = new Map<string, ModelCatalogResponse>();

/** Catalog identity since Phase 2 of the agent→runner refactor: a
 *  catalog belongs to the machine's installed binary, so the picker
 *  works before any agent of the type exists under the project. */
export interface CatalogTarget {
  machineId: string;
  cliType: string;
}

export function useModelCatalog(target: CatalogTarget | null) {
  const key = target ? `${target.machineId}::${target.cliType}` : null;
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(
    key ? (catalogCache.get(key) ?? null) : null,
  );
  // loading = nothing to show yet; refreshing = newer data on its way
  // while the current list stays interactive (client-side SWR).
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const machineId = target?.machineId;
  const cliType = target?.cliType;

  useEffect(() => {
    if (!key || !machineId || !cliType) {
      setCatalog(null);
      setError(null);
      return;
    }
    const cached = catalogCache.get(key) ?? null;
    setCatalog(cached);
    setError(null);
    // Always revalidate, even on cache hit — the server read is a
    // Postgres lookup (catalogs are pushed by the sidecar at agent
    // spawn), so this is cheap and picks up server-side refreshes the
    // module cache would otherwise mask for the whole page lifetime.
    let cancelled = false;
    if (cached) setRefreshing(true);
    else setLoading(true);
    api
      .getMachineModelCatalog(machineId, cliType)
      .then((resp) => {
        catalogCache.set(key, resp);
        if (!cancelled) setCatalog(resp);
      })
      .catch((e: Error) => {
        // A failed revalidate keeps showing the cached list silently.
        if (!cancelled && !cached) setError(e.message || 'failed to load models');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, machineId, cliType]);

  /** Manual refresh — the one path that forces a live CLI probe
   *  (`?refresh=1`). The current list stays interactive throughout;
   *  a failure leaves it untouched and surfaces the reason. */
  const refresh = () => {
    if (!key || !machineId || !cliType) return;
    setRefreshing(true);
    setError(null);
    api
      .getMachineModelCatalog(machineId, cliType, { refresh: true })
      .then((resp) => {
        catalogCache.set(key, resp);
        setCatalog(resp);
      })
      .catch((e: Error) => setError(e.message || 'refresh failed'))
      .finally(() => setRefreshing(false));
  };

  return { catalog, loading, refreshing, error, refresh };
}

const EFFORT_LABEL: Record<string, string> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra high',
  max: 'max',
};

type Props = {
  /** Machine × CLI whose catalog to load. Null = unknown → custom-
   *  input mode. */
  target: CatalogTarget | null;
  /** Current selection; null = "Default" (CLI decides). */
  value: ModelSelection | null;
  onChange: (v: ModelSelection | null) => void;
};

export function ModelPicker({ target, value, onChange }: Props) {
  const { catalog, loading, refreshing, error, refresh } = useModelCatalog(target);
  // Sticky custom mode: once the user picks "custom…" we keep the text
  // input visible even while the field is empty.
  const [customMode, setCustomMode] = useState(false);

  const { flat, families, byId } = useMemo(() => {
    const flat: ModelCatalogEntry[] = [];
    const families = new Map<string, ModelCatalogEntry[]>();
    const byId = new Map<string, ModelCatalogEntry>();
    for (const m of catalog?.models ?? []) {
      byId.set(m.id, m);
      if (m.family) {
        const list = families.get(m.family) ?? [];
        list.push(m);
        families.set(m.family, list);
      } else {
        flat.push(m);
      }
    }
    return { flat, families, byId };
  }, [catalog]);

  const selected = value?.model ? byId.get(value.model) : undefined;
  // A set model with no matching catalog entry renders as custom even
  // while the catalog is absent/loading — if the list arrives and
  // contains it, this flips to the dropdown selection automatically.
  const isCustom = customMode || (!!value?.model && !selected);

  function emitEntry(entry: ModelCatalogEntry) {
    const sel: ModelSelection = { model: entry.id };
    // Carry facet choices across model switches only where the new
    // entry actually supports them.
    if (value?.effort && entry.facets?.effort?.levels.includes(value.effort)) {
      sel.effort = value.effort;
    }
    if (value?.context === '1m' && entry.facets?.context) sel.context = '1m';
    if (value?.speed === 'fast' && entry.facets?.speed) sel.speed = 'fast';
    onChange(sel);
  }

  function onPrimaryChange(v: string) {
    if (v === '') {
      setCustomMode(false);
      onChange(null);
      return;
    }
    if (v === 'custom') {
      setCustomMode(true);
      onChange({ model: value?.model ?? '' });
      return;
    }
    setCustomMode(false);
    if (v.startsWith('f:')) {
      const members = families.get(v.slice(2)) ?? [];
      // Entering a family selects its base variant: the entry labeled
      // "Standard" (the one whose display name IS the family label),
      // else the first member in catalog order.
      const base = members.find((m) => m.variantLabel === 'Standard') ?? members[0];
      if (base) emitEntry(base);
      return;
    }
    const entry = byId.get(v.slice(2));
    if (entry) emitEntry(entry);
  }

  const primaryValue = isCustom
    ? 'custom'
    : selected
      ? selected.family
        ? `f:${selected.family}`
        : `m:${selected.id}`
      : '';

  const familyMembers = selected?.family ? (families.get(selected.family) ?? []) : [];

  const primaryOptions: SelectOption[] = [
    { value: '', label: 'Default', hint: 'CLI decides' },
    ...flat.map((m) => ({
      value: `m:${m.id}`,
      label: m.displayName,
      hint: m.isDefault ? 'CLI default' : undefined,
    })),
    ...[...families.keys()].map((f) => ({ value: `f:${f}`, label: f })),
    { value: 'custom', label: 'custom…' },
  ];

  // Two nested rows, not one: the controls wrap among themselves in a
  // flex-1 track and the refresh button sits OUTSIDE that track, so it
  // can never be the item that wraps. It used to ride the same wrap
  // container with `ml-auto`, which reads as "anchor right" but really
  // means "float right on whatever line I land on" — at the 352px both
  // callers render at (312px of content in CreateAgentPopover), a
  // claude-code row (model + effort + 1M) overshot by ~16px and pushed
  // the button alone onto a second line.
  //
  // flex-wrap inside the track is still the safety valve — long model
  // names (codex) or cursor's model+variant+effort trio push the later
  // controls onto a second line instead of truncating everything. The
  // description renders below both, not in the track: as a trailing
  // flex item it wraps to a full line in narrow panels and strands
  // whatever follows it.
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Select
            value={primaryValue}
            options={primaryOptions}
            onChange={onPrimaryChange}
            className="min-w-[104px] flex-[2]"
          />

          {selected?.family && familyMembers.length > 0 && (
            <Select
              value={selected.id}
              options={familyMembers.map((m) => ({
                value: m.id,
                label: m.variantLabel || m.displayName,
                hint: m.isDefault ? 'CLI default' : undefined,
              }))}
              onChange={(id) => {
                const entry = byId.get(id);
                if (entry) emitEntry(entry);
              }}
              className="min-w-[110px] flex-1"
            />
          )}

          {selected?.facets?.effort && (
            <Select
              value={value?.effort ?? ''}
              options={[
                {
                  value: '',
                  label: 'effort: default',
                  hint: EFFORT_LABEL[selected.facets.effort.default] ?? undefined,
                },
                ...selected.facets.effort.levels.map((l) => ({
                  value: l,
                  label: `effort: ${EFFORT_LABEL[l] ?? l}`,
                })),
              ]}
              onChange={(v) => {
                const next = { ...(value ?? {}) } as ModelSelection;
                if (v) next.effort = v as EffortLevel;
                else delete next.effort;
                onChange(next);
              }}
              className="min-w-[110px] flex-1"
              title="effort / thinking strength"
            />
          )}

          {selected?.facets?.context && (
            <FacetToggle
              label="1M"
              title="1M-token context window (may require plan upgrade or usage credits)"
              active={value?.context === '1m'}
              onToggle={(on) => {
                const next = { ...(value ?? {}) } as ModelSelection;
                if (on) next.context = '1m';
                else delete next.context;
                onChange(next);
              }}
            />
          )}
          {selected?.facets?.speed && (
            <FacetToggle
              label="fast"
              title="priority / fast service tier"
              active={value?.speed === 'fast'}
              onToggle={(on) => {
                const next = { ...(value ?? {}) } as ModelSelection;
                if (on) next.speed = 'fast';
                else delete next.speed;
                onChange(next);
              }}
            />
          )}
        </div>

        {target && (
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            title="refresh model list (probes the CLI directly)"
            // h-8 matches the Select trigger's height so `items-start`
            // lines the glyph up with the first control row and keeps it
            // there when the track wraps.
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2/60 hover:text-fg-primary disabled:hover:bg-transparent"
          >
            <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
          </button>
        )}
      </div>

      {selected?.description && <div className="text-meta">{selected.description}</div>}

      {loading && (
        <div className="flex items-center gap-1.5 text-meta">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          loading models — Default works right away
        </div>
      )}
      {error && !loading && (
        <div className="text-meta text-amber-600 dark:text-amber-400/80">
          {catalog ? `refresh failed: ${error}` : `model list unavailable: ${error}`}
        </div>
      )}

      {isCustom && (
        <input
          value={value?.model ?? ''}
          onChange={(e) =>
            onChange(e.target.value.trim() ? { model: e.target.value.trim() } : { model: '' })
          }
          placeholder="model id passed to the CLI verbatim"
          autoFocus
          className="w-full rounded-md bg-surface-2/40 px-3 py-2 font-mono text-xs text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:bg-surface-2"
        />
      )}
    </div>
  );
}

function FacetToggle({
  label,
  title,
  active,
  onToggle,
}: {
  label: string;
  title: string;
  active: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      title={title}
      className={cn(
        'rounded-md px-2.5 py-1.5 text-xs transition-colors',
        active
          ? 'bg-surface-2 text-fg-primary'
          : 'bg-transparent text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-primary',
      )}
    >
      {label}
    </button>
  );
}

/** Compact human label for the current selection, e.g. for the
 *  session-header chip: "Opus 4.8 1M · Thinking · xhigh" or "Default". */
export function modelSelectionLabel(
  value: ModelSelection | null | undefined,
  catalog?: ModelCatalogResponse | null,
): string {
  if (!value?.model) return 'Default';
  const entry = catalog?.models.find((m) => m.id === value.model);
  let base = entry?.displayName ?? value.model;
  if (entry?.family && entry.variantLabel && entry.variantLabel !== 'Standard') {
    base = `${entry.family} · ${entry.variantLabel}`;
  }
  const parts = [base];
  if (value.effort) parts.push(EFFORT_LABEL[value.effort] ?? value.effort);
  if (value.context === '1m') parts.push('1M');
  if (value.speed === 'fast') parts.push('fast');
  return parts.join(' · ');
}
