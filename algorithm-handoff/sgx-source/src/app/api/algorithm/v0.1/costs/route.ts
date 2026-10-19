import { NextResponse } from 'next/server';
import { algorithmCostTable, internalAlgorithmRuntime as runtime, internalRequestError,
  requestWorkspace, workspaceRequestError } from '../_shared/runtime.ts';

export const dynamic = 'force-dynamic';

/** Read-only cost provenance for the internal workbench; it never calls a provider. */
export async function GET(request: Request): Promise<NextResponse> {
  const blocked = internalRequestError(request);
  if (blocked) return blocked;
  try {
    const workspace = requestWorkspace(request);
    const table = workspace ? algorithmCostTable(workspace.sessionHandles) : algorithmCostTable();
    return NextResponse.json({
      ...table,
      budgetAggregate: runtime.budget(),
    }, {
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch (error) { return workspaceRequestError(error); }
}
