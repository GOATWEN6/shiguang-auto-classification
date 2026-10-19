import { NextResponse } from 'next/server';
import { internalAlgorithmRuntime as runtime, sessionRequestError } from '../../../_shared/runtime.ts';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: { opaqueSessionHandle: string } }) {
  const blocked = sessionRequestError(request, context.params.opaqueSessionHandle);
  if (blocked) return blocked;
  try {
    const handle = context.params.opaqueSessionHandle;
    const view = runtime.composition?.view(handle) ?? {
      schemaVersion: 'algorithm-session-view-v0.1',
      mode: runtime.orchestrator.getSessionSnapshot(handle).mode,
      status: runtime.orchestrator.getSessionSnapshot(handle).status,
      currentTarget: runtime.orchestrator.getCurrentTarget(handle), memory: [], artifacts: [],
      storage: { durable: false, canonicalWriteCapability: false },
    };
    return NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ code: 'session_not_found' }, { status: 404 }); }
}
