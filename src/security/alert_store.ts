/**
 * alert_store.ts — Shared in-memory alert registry for AutoMate Phase 4
 *
 * Acts as the single source of truth for all live security alerts detected
 * by the realtime scanner, prompt scanner, and dataset monitor.
 *
 * Consumers (extension.ts, monitorPanel, openrouter_client) read from here.
 * Producers (realtime_scanner, prompt_scanner) write to here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Alert contract — matches FINAL OUTPUT spec in Phase 4 brief
// ─────────────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AlertCategory =
    | 'secret_exposure'
    | 'pii_detected'
    | 'prompt_leakage'
    | 'dataset_risk'
    | 'policy_violation';
export type PolicyAction = 'blocked' | 'warned' | 'logged';

export interface SecurityAlert {
    /** Unique ID (uuid-like) */
    id: string;
    /** Alert type label (e.g. "API key detected") */
    type: string;
    /** Severity tier */
    severity: AlertSeverity;
    /** Functional category */
    category: AlertCategory;
    /** Workspace-relative file path */
    file: string;
    /** 1-based line number, undefined for prompt/dataset alerts */
    line?: number;
    /** Human-readable pattern description */
    pattern: string;
    /** ISO-8601 timestamp */
    timestamp: string;
    /** Short code snippet (≤ 80 chars) */
    snippet?: string;
    /** Policy action applied, if any */
    policyAction?: PolicyAction;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum alerts kept in memory (circular buffer) */
const MAX_ALERTS = 200;

let _alerts: SecurityAlert[] = [];
const _listeners: Array<(alert: SecurityAlert) => void> = [];

/** Subscribe to new alerts. Returns an unsubscribe function. */
export function onAlert(listener: (alert: SecurityAlert) => void): () => void {
    _listeners.push(listener);
    return () => {
        const idx = _listeners.indexOf(listener);
        if (idx !== -1) { _listeners.splice(idx, 1); }
    };
}

/** Push a new alert into the store and notify all listeners. */
export function pushAlert(alert: SecurityAlert): void {
    _alerts.unshift(alert);                     // newest first
    if (_alerts.length > MAX_ALERTS) {
        _alerts.length = MAX_ALERTS;            // trim tail
    }
    _listeners.forEach(fn => {
        try { fn(alert); } catch { /* listener errors must not break producer */ }
    });
}

/** Return a snapshot of current alerts (newest first). */
export function getAlerts(): SecurityAlert[] {
    return [..._alerts];
}

/** Return the N most recent alerts. */
export function getRecentAlerts(n: number = 50): SecurityAlert[] {
    return _alerts.slice(0, n);
}

/** Clear all stored alerts (e.g. on workspace reset). */
export function clearAlerts(): void {
    _alerts = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — create a well-formed alert
// ─────────────────────────────────────────────────────────────────────────────

let _counter = 0;

export function makeAlert(
    type: string,
    severity: AlertSeverity,
    category: AlertCategory,
    file: string,
    pattern: string,
    opts: Partial<Pick<SecurityAlert, 'line' | 'snippet' | 'policyAction'>> = {}
): SecurityAlert {
    _counter++;
    return {
        id: `sa-${Date.now()}-${_counter}`,
        type,
        severity,
        category,
        file,
        pattern,
        timestamp: new Date().toISOString(),
        ...opts,
    };
}
