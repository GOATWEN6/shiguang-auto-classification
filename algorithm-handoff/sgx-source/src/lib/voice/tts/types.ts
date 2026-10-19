export type VoiceTtsProviderName = 'minimax' | 'doubao' | 'disabled';

export interface VoiceTtsAudio {
  base64Audio: string;
  mimeType: string;
  provider: VoiceTtsProviderName;
  model?: string;
  voiceId?: string;
  receivedAt: string;
}

export interface VoiceTtsConfigStatus {
  configured: boolean;
  provider: VoiceTtsProviderName;
  missing: string[];
  endpoint?: string;
  model?: string;
  voiceId?: string;
  outputFormat?: string;
  sampleRate?: number;
}

export interface VoiceTtsSynthesisInput {
  text: string;
  signal?: AbortSignal;
}

export interface VoiceTtsSynthesisResult {
  available: boolean;
  audio?: VoiceTtsAudio;
  reason?: string;
}
