/**
 * dashboard.ts — DEPRECATED. Import from governance.ts instead.
 *
 * This file exists only to prevent import errors during the transition.
 * It re-exports the typed DashboardData from governance.ts.
 *
 * The `any`-typed DashboardState is intentionally removed.
 * Any file still importing DashboardState will get a compile error —
 * that error forces migration to the typed governance.ts interface.
 *
 * Migration:
 *   BEFORE: import { DashboardState } from './types/dashboard';
 *   AFTER:  import { DashboardData }  from './types/governance';
 */
export type { DashboardData } from './governance';

// DashboardState (all `any`) is intentionally NOT re-exported.
