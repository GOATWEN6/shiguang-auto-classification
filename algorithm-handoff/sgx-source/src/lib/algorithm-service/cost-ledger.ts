import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A provider reservation is the only cost fact available before an invoice is
 * settled.  This ledger deliberately keeps that fact separate from the final
 * provider charge, which remains null while the local test bill is pending.
 */
export const ALGORITHM_COST_LEDGER_SCHEMA = 'algorithm-cost-ledger-v0.1' as const;

export type AlgorithmCostBillingState = 'PENDING_INVOICE' | 'SETTLED';

export interface AlgorithmCostContext {
  ipFingerprint: string;
  ipSource: 'direct' | 'forwarded' | 'unknown';
  sessionHandle?: string;
  sessionEpoch?: string;
  round?: number;
  turnId?: string;
}

export interface AlgorithmCostEntry {
  schemaVersion: typeof ALGORITHM_COST_LEDGER_SCHEMA;
  entryId: string;
  occurredAt: string;
  ipFingerprint: string;
  ipSource: AlgorithmCostContext['ipSource'];
  sessionLabel: string;
  round: number;
  turnLabel: string;
  module: string;
  requestId: string;
  reservedCny: number;
  actualCostCny: number | null;
  status: 'RESERVED';
  billingState: AlgorithmCostBillingState;
  basis: 'provider_reservation_upper_bound';
}

export interface AlgorithmCostTableRow {
  ipFingerprint: string;
  sessionLabel: string;
  round: number;
  modules: string[];
  attemptCount: number;
  reservedCny: number;
  actualCostCny: number | null;
  billingState: AlgorithmCostBillingState;
  firstAt: string;
  lastAt: string;
}

export interface AlgorithmCostIpTotal {
  ipFingerprint: string;
  sessionCount: number;
  roundCount: number;
  attemptCount: number;
  reservedCny: number;
  actualCostCny: number | null;
  billingState: AlgorithmCostBillingState;
}

export interface AlgorithmCostTable {
  schemaVersion: 'algorithm-cost-table-v0.1';
  generatedAt: string;
  basis: 'provider_reservation_upper_bound';
  actualCostAvailable: false;
  entries: AlgorithmCostEntry[];
  rows: AlgorithmCostTableRow[];
  ipTotals: AlgorithmCostIpTotal[];
  unattributedEntryCount: number;
  legacyAggregate: {
    reservationCount: number;
    reservedCny: number;
    moduleTotals: Record<string, number>;
    moduleCounts: Record<string, number>;
    ipBinding: 'not_recorded';
    sessionBinding: 'not_recorded';
    roundBinding: 'not_recorded';
  };
  note: string;
}

function money(value: number): number {
  return Number(value.toFixed(6));
}

/** Stable redaction: enough to group a client across rounds without storing its IP. */
export function fingerprintClientIp(rawIp: string): string {
  const normalized = rawIp.trim().toLowerCase() || 'unknown';
  return createHash('sha256').update(`sgx-cost-ledger-v0.1:${normalized}`).digest('hex').slice(0, 16);
}

function label(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return createHash('sha256').update(`sgx-cost-ledger-label-v0.1:${value}`).digest('hex').slice(0, 12);
}

/** Public only for server-side workspace filtering; it never exposes the raw handle. */
export function algorithmCostSessionLabel(sessionHandle: string): string {
  return label(sessionHandle, 'unattributed');
}

function isEntry(value: unknown): value is AlgorithmCostEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AlgorithmCostEntry>;
  return item.schemaVersion === ALGORITHM_COST_LEDGER_SCHEMA
    && typeof item.entryId === 'string' && typeof item.occurredAt === 'string'
    && typeof item.ipFingerprint === 'string' && typeof item.sessionLabel === 'string'
    && typeof item.round === 'number' && typeof item.module === 'string'
    && typeof item.requestId === 'string' && typeof item.reservedCny === 'number'
    && item.actualCostCny === null && item.status === 'RESERVED'
    && item.billingState === 'PENDING_INVOICE'
    && item.basis === 'provider_reservation_upper_bound';
}

export function createAlgorithmCostLedger(options: { directory: string }) {
  const file = join(options.directory, 'cost-ledger.jsonl');
  const entries: AlgorithmCostEntry[] = [];
  if (existsSync(file)) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const value: unknown = JSON.parse(line);
        if (isEntry(value)) entries.push(value);
      }
    } catch {
      // A malformed diagnostic file must not prevent the algorithm service from
      // starting. New entries continue in memory and are written atomically per
      // line; the old malformed line is intentionally not surfaced to clients.
    }
  }

  function record(context: AlgorithmCostContext | undefined, input: {
    module: string; requestId: string; reservedCny: number; occurredAt?: string;
  }): AlgorithmCostEntry {
    const now = input.occurredAt ?? new Date().toISOString();
    const entry: AlgorithmCostEntry = {
      schemaVersion: ALGORITHM_COST_LEDGER_SCHEMA,
      entryId: randomUUID(),
      occurredAt: now,
      ipFingerprint: context?.ipFingerprint ?? 'unattributed-internal',
      ipSource: context?.ipSource ?? 'unknown',
      sessionLabel: label(context?.sessionHandle, 'unattributed'),
      round: Number.isInteger(context?.round) && (context?.round ?? 0) > 0 ? context!.round! : 0,
      turnLabel: label(context?.turnId, 'unattributed'),
      module: input.module,
      requestId: input.requestId,
      reservedCny: money(input.reservedCny),
      actualCostCny: null,
      status: 'RESERVED',
      billingState: 'PENDING_INVOICE',
      basis: 'provider_reservation_upper_bound',
    };
    entries.push(entry);
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return structuredClone(entry);
  }

  function buildTable(sourceEntries: readonly AlgorithmCostEntry[], includeLegacy: boolean): AlgorithmCostTable {
    const rows = new Map<string, AlgorithmCostTableRow>();
    const totals = new Map<string, AlgorithmCostIpTotal>();
    for (const entry of sourceEntries) {
      const rowKey = `${entry.ipFingerprint}:${entry.sessionLabel}:${entry.round}`;
      const row = rows.get(rowKey) ?? {
        ipFingerprint: entry.ipFingerprint, sessionLabel: entry.sessionLabel, round: entry.round,
        modules: [], attemptCount: 0, reservedCny: 0, actualCostCny: null,
        billingState: 'PENDING_INVOICE', firstAt: entry.occurredAt, lastAt: entry.occurredAt,
      };
      if (!row.modules.includes(entry.module)) row.modules.push(entry.module);
      row.attemptCount += 1;
      row.reservedCny = money(row.reservedCny + entry.reservedCny);
      row.firstAt = entry.occurredAt < row.firstAt ? entry.occurredAt : row.firstAt;
      row.lastAt = entry.occurredAt > row.lastAt ? entry.occurredAt : row.lastAt;
      rows.set(rowKey, row);

      const total = totals.get(entry.ipFingerprint) ?? {
        ipFingerprint: entry.ipFingerprint, sessionCount: 0, roundCount: 0,
        attemptCount: 0, reservedCny: 0, actualCostCny: null,
        billingState: 'PENDING_INVOICE',
      };
      total.attemptCount += 1;
      total.reservedCny = money(total.reservedCny + entry.reservedCny);
      totals.set(entry.ipFingerprint, total);
    }
    const tableRows = [...rows.values()].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    for (const total of totals.values()) {
      const userRows = tableRows.filter(row => row.ipFingerprint === total.ipFingerprint);
      total.sessionCount = new Set(userRows.map(row => row.sessionLabel)).size;
      total.roundCount = userRows.length;
    }
    const knownRequestIds = new Set(entries.map(entry => entry.requestId));
    const legacy = { reservationCount: 0, reservedCny: 0, moduleTotals: {} as Record<string, number>, moduleCounts: {} as Record<string, number> };
    const reservationsFile = join(options.directory, 'reservations.jsonl');
    if (includeLegacy && existsSync(reservationsFile)) {
      try {
        for (const line of readFileSync(reservationsFile, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const value = JSON.parse(line) as { requestId?: unknown; module?: unknown; reservedCny?: unknown };
          if (typeof value.requestId !== 'string' || knownRequestIds.has(value.requestId)
            || typeof value.module !== 'string' || typeof value.reservedCny !== 'number') continue;
          legacy.reservationCount += 1;
          legacy.reservedCny = money(legacy.reservedCny + value.reservedCny);
          legacy.moduleTotals[value.module] = money((legacy.moduleTotals[value.module] ?? 0) + value.reservedCny);
          legacy.moduleCounts[value.module] = (legacy.moduleCounts[value.module] ?? 0) + 1;
        }
      } catch {
        // The aggregate is supplemental diagnostics. The per-entry ledger above
        // remains authoritative when an older reservation log is malformed.
      }
    }
    return {
      schemaVersion: 'algorithm-cost-table-v0.1', generatedAt: new Date().toISOString(),
      basis: 'provider_reservation_upper_bound', actualCostAvailable: false,
      entries: sourceEntries.map(entry => structuredClone(entry)),
      rows: tableRows, ipTotals: [...totals.values()].sort((a, b) => a.ipFingerprint.localeCompare(b.ipFingerprint)),
      unattributedEntryCount: sourceEntries.filter(entry => entry.ipFingerprint === 'unattributed-internal').length,
      legacyAggregate: { ...legacy, ipBinding: 'not_recorded', sessionBinding: 'not_recorded', roundBinding: 'not_recorded' },
      note: includeLegacy
        ? '同一 IP 使用脱敏指纹聚合；reservedCny 是调用前预留上限。豆包账单为 PENDING 时 actualCostCny 保持 null。历史 aggregate 预算未绑定 IP/会话，只在 health 的累计预算中保留。'
        : '只显示当前设备工作区绑定会话的预留记录；不包含其他设备或无法归属的历史 aggregate。',
    };
  }

  function table(): AlgorithmCostTable {
    return buildTable(entries, true);
  }

  function tableForSessions(sessionHandles: readonly string[]): AlgorithmCostTable {
    const allowed = new Set(sessionHandles.map(algorithmCostSessionLabel));
    return buildTable(entries.filter(entry => allowed.has(entry.sessionLabel)), false);
  }

  return { record, table, tableForSessions, size: () => entries.length };
}
