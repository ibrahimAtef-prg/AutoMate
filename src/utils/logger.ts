/**
 * logger.ts — Structured Logger for AutoMate Aurora
 *
 * Replaces all console.log / console.warn / console.error with a
 * controlled, environment-toggleable logging system.
 *
 * Rules:
 *  - DEBUG=false (default): only errors are emitted
 *  - DEBUG=true: all levels emitted
 *  - No sensitive data (keys, raw PII) in log messages
 *  - Production paths MUST use this module — never raw console.*
 *
 * Usage:
 *   import { log } from '../utils/logger';
 *   log.info('Pipeline complete', { rows: 500 });
 *   log.error('Validation failed', { missing: ['privacy_score'] });
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  tag:   string;
  msg:   string;
  data?: Record<string, unknown>;
  ts:    string;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info (msg: string, data?: Record<string, unknown>): void;
  warn (msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  setDebug(enabled: boolean): void;
  isDebug(): boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────────────────────────────────────────

let _debug = false;
const _tag = '[AutoMate]';

function _sanitize(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) { return undefined; }
  // Strip any field names that look like they carry secrets or raw PII.
  const REDACT_KEYS = /key|token|secret|password|api_key|ssn|credit_card/i;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    result[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : v;
  }
  return result;
}

function _emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    tag:  _tag,
    msg,
    data: _sanitize(data),
    ts:   new Date().toISOString(),
  };

  switch (level) {
    case 'debug':
      if (_debug) { console.debug(`${_tag} [DEBUG] ${msg}`, entry.data ?? ''); }
      break;
    case 'info':
      if (_debug) { console.info(`${_tag} ${msg}`, entry.data ?? ''); }
      break;
    case 'warn':
      if (_debug) { console.warn(`${_tag} [WARN] ${msg}`, entry.data ?? ''); }
      break;
    case 'error':
      // Errors always surface — they are never suppressed by the debug flag.
      console.error(`${_tag} [ERROR] ${msg}`, entry.data ?? '');
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export const log: Logger = {
  debug:   (msg, data) => _emit('debug', msg, data),
  info:    (msg, data) => _emit('info',  msg, data),
  warn:    (msg, data) => _emit('warn',  msg, data),
  error:   (msg, data) => _emit('error', msg, data),
  setDebug:(on)        => { _debug = on; },
  isDebug: ()          => _debug,
};

// Allow the VS Code extension host to enable debug logging via a global flag.
// Set window.__AUTOMATE_DEBUG = true in the webview before the script loads.
if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>)['__AUTOMATE_DEBUG'] === true) {
  log.setDebug(true);
}
