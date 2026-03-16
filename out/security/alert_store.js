"use strict";
/**
 * alert_store.ts — Shared in-memory alert registry for AutoMate Phase 4
 *
 * Acts as the single source of truth for all live security alerts detected
 * by the realtime scanner, prompt scanner, and dataset monitor.
 *
 * Consumers (extension.ts, monitorPanel, openrouter_client) read from here.
 * Producers (realtime_scanner, prompt_scanner) write to here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.onAlert = onAlert;
exports.pushAlert = pushAlert;
exports.getAlerts = getAlerts;
exports.getRecentAlerts = getRecentAlerts;
exports.clearAlerts = clearAlerts;
exports.makeAlert = makeAlert;
// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────
/** Maximum alerts kept in memory (circular buffer) */
const MAX_ALERTS = 200;
let _alerts = [];
const _listeners = [];
/** Subscribe to new alerts. Returns an unsubscribe function. */
function onAlert(listener) {
    _listeners.push(listener);
    return () => {
        const idx = _listeners.indexOf(listener);
        if (idx !== -1) {
            _listeners.splice(idx, 1);
        }
    };
}
/** Push a new alert into the store and notify all listeners. */
function pushAlert(alert) {
    _alerts.unshift(alert); // newest first
    if (_alerts.length > MAX_ALERTS) {
        _alerts.length = MAX_ALERTS; // trim tail
    }
    _listeners.forEach(fn => {
        try {
            fn(alert);
        }
        catch { /* listener errors must not break producer */ }
    });
}
/** Return a snapshot of current alerts (newest first). */
function getAlerts() {
    return [..._alerts];
}
/** Return the N most recent alerts. */
function getRecentAlerts(n = 50) {
    return _alerts.slice(0, n);
}
/** Clear all stored alerts (e.g. on workspace reset). */
function clearAlerts() {
    _alerts = [];
}
// ─────────────────────────────────────────────────────────────────────────────
// Helper — create a well-formed alert
// ─────────────────────────────────────────────────────────────────────────────
let _counter = 0;
function makeAlert(type, severity, category, file, pattern, opts = {}) {
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
//# sourceMappingURL=alert_store.js.map