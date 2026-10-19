import { NextResponse } from 'next/server';

import {
  algorithmCostTable,
  algorithmHttpService,
  internalAlgorithmRuntime as runtime,
  internalRequestError,
  workspaceRequestError,
} from '../../../_shared/runtime.ts';
import {
  workspaceJsonError,
  workspaceTokenFromRequest,
} from '../../../_shared/workspace.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const blocked = internalRequestError(request);
  if (blocked) return blocked;
  const token = workspaceTokenFromRequest(request);
  if (!token) return workspaceJsonError(401, 'workspace_required', '需要先建立此设备的测试工作区。');
  try {
    const workspaceExport = runtime.workspaceStore.exportCurrent(token);
    const costs = algorithmCostTable(workspaceExport.workspace.sessionHandles);
    const version = algorithmHttpService.version().body;
    return NextResponse.json({
      schemaVersion: 'sgx-test-workspace-export-v0.1',
      exportedAt: workspaceExport.exportedAt,
      version,
      budget: runtime.budget(),
      workspace: workspaceExport.workspace,
      costs,
      exclusions: ['raw_audio', 'provider_keys', 'cookies', 'server_paths', 'global_cost_ledger'],
    }, { headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment; filename="sgx-test-workspace-export.json"',
    } });
  } catch (error) { return workspaceRequestError(error); }
}
