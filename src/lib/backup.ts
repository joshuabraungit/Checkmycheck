import { validateWorkspace } from './validate';
import { SCHEMA_VERSION, type Workspace } from './types';

export const BACKUP_APP_ID = 'check-my-check';

export function workspaceToBackupJson(ws: Workspace, exportedAt: string = new Date().toISOString()): string {
  return JSON.stringify(
    {
      app: BACKUP_APP_ID,
      schemaVersion: SCHEMA_VERSION,
      exportedAt,
      plans: ws.plans,
      deals: ws.deals,
      payments: ws.payments,
      allocations: ws.allocations,
    },
    null,
    2,
  );
}

export interface BackupPreview {
  workspace: Workspace;
  counts: { plans: number; deals: number; payments: number; allocations: number };
  exportedAt: string | null;
}

export type BackupParseResult = { ok: true; preview: BackupPreview } | { ok: false; errors: string[] };

/** Parse and fully validate a backup file before anything is replaced. */
export function parseBackupJson(text: string): BackupParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['This file is not valid JSON.'] };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['This file is not a Check My Check backup.'] };
  }
  const obj = data as Record<string, unknown>;
  if (obj.app !== undefined && obj.app !== BACKUP_APP_ID) {
    return { ok: false, errors: ['This file is not a Check My Check backup.'] };
  }
  const result = validateWorkspace(obj);
  if (!result.ok) return result;
  const ws = result.workspace;
  return {
    ok: true,
    preview: {
      workspace: ws,
      counts: { plans: ws.plans.length, deals: ws.deals.length, payments: ws.payments.length, allocations: ws.allocations.length },
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : null,
    },
  };
}
