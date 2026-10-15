import { NextResponse } from 'next/server';

import { algorithmHttpService, internalRequestError, internalAlgorithmRuntime } from '../_shared/runtime.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const blocked = internalRequestError(request);
  if (blocked) return blocked;
  const result = algorithmHttpService.health();
  return NextResponse.json({ ...result.body as object,
    providerConfigurationPresent: internalAlgorithmRuntime.configurationReady,
    budgetAuthorized: internalAlgorithmRuntime.budgetAuthorized,
    budget: internalAlgorithmRuntime.budget(),
    storage: 'process_memory_fictional_only', transport: 'continuous_pcm_asr_and_incremental_pcm_tts',
    localContentRetention: { days: 40, sourceWithdrawal: 'immediate', expirySweepSeconds: 60,
      externalProviderDeletionVerified: false } }, { status: result.status });
}
