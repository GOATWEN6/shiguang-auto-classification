import { getVoiceTtsConfig, getVoiceTtsConfigStatus } from './config';
import { synthesizeWithDoubaoTts } from './doubao-provider';
import { synthesizeWithMiniMaxTts } from './minimax-provider';
import { VoiceTtsConfigStatus, VoiceTtsSynthesisInput, VoiceTtsSynthesisResult } from './types';

export * from './types';
export * from './config';

export function getMaskedVoiceTtsStatus(): VoiceTtsConfigStatus {
  return getVoiceTtsConfigStatus();
}

export async function synthesizeSpeech(input: VoiceTtsSynthesisInput): Promise<VoiceTtsSynthesisResult> {
  const status = getVoiceTtsConfigStatus();
  const config = getVoiceTtsConfig();
  if (!status.configured || !config) {
    return {
      available: false,
      reason: `tts_not_configured:${status.missing.join(',')}`,
    };
  }

  if (config.provider === 'minimax') {
    const audio = await synthesizeWithMiniMaxTts(config, input.text, input.signal);
    return {
      available: true,
      audio,
    };
  }

  if (config.provider === 'doubao') {
    const audio = await synthesizeWithDoubaoTts(config, input.text, input.signal);
    return {
      available: true,
      audio,
    };
  }

  return {
    available: false,
    reason: 'tts_provider_not_supported',
  };
}
