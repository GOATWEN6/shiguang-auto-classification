import type { VoiceTtsConfigStatus, VoiceTtsProviderName } from './types.ts';

export interface MiniMaxTtsConfig {
  provider: 'minimax';
  endpoint: string;
  apiKey: string;
  model: string;
  voiceId: string;
  outputFormat: 'mp3' | 'wav' | 'pcm';
  sampleRate: number;
  bitrate: number;
  speed: number;
  volume: number;
  pitch: number;
  connectTimeoutMs: number;
  synthesisTimeoutMs: number;
}

export interface DoubaoTtsConfig {
  provider: 'doubao';
  endpoint: string;
  apiKey?: string;
  appId?: string;
  appKey?: string;
  accessKey?: string;
  resourceId: string;
  model: string;
  voiceId: string;
  outputFormat: 'mp3' | 'wav' | 'pcm' | 'ogg_opus';
  sampleRate: number;
  speed: number;
  volume: number;
  pitch: number;
  synthesisTimeoutMs: number;
}

export type VoiceTtsConfig = MiniMaxTtsConfig | DoubaoTtsConfig;

const DEFAULT_MINIMAX_ENDPOINT = 'wss://api.minimaxi.com/ws/v1/t2a_v2';
const DEFAULT_MINIMAX_MODEL = 'speech-2.8-turbo';
const DEFAULT_MINIMAX_VOICE_ID = 'male-qn-qingse';
const DEFAULT_DOUBAO_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_DOUBAO_TTS_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_DOUBAO_TTS_SPEAKER = 'zh_female_vv_uranus_bigtts';

function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(defaultValue: number, ...names: string[]): number {
  const value = readEnv(...names);
  if (!value) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readProvider(): VoiceTtsProviderName {
  const provider = readEnv('VOICE_TTS_PROVIDER')?.toLowerCase();
  if (provider === 'disabled' || provider === 'none' || provider === 'off') return 'disabled';
  if (provider === 'doubao') return 'doubao';
  if (provider === 'minimax') return 'minimax';
  if (readEnv('DOUBAO_TTS_API_KEY', 'DOUBAO_API_KEY', 'VOLCENGINE_TTS_API_KEY')) return 'doubao';
  return readEnv('MINIMAX_API_KEY', 'MINIMAX_TTS_API_KEY') ? 'minimax' : 'disabled';
}

function readOutputFormat(...names: string[]): DoubaoTtsConfig['outputFormat'] {
  const value = readEnv(...names);
  if (value === 'wav' || value === 'pcm' || value === 'ogg_opus') return value;
  return 'mp3';
}

export function getVoiceTtsConfigStatus(): VoiceTtsConfigStatus {
  const provider = readProvider();
  const endpoint = readEnv('MINIMAX_TTS_ENDPOINT') || DEFAULT_MINIMAX_ENDPOINT;
  const model = readEnv('MINIMAX_TTS_MODEL') || DEFAULT_MINIMAX_MODEL;
  const voiceId = readEnv('MINIMAX_TTS_VOICE_ID') || DEFAULT_MINIMAX_VOICE_ID;
  const outputFormat = readOutputFormat();
  const sampleRate = readNumber(32000, 'MINIMAX_TTS_SAMPLE_RATE');

  if (provider === 'disabled') {
    return {
      configured: false,
      provider,
      missing: ['VOICE_TTS_PROVIDER=doubao', 'DOUBAO_TTS_API_KEY'],
      endpoint,
      model,
      voiceId,
      outputFormat,
      sampleRate,
    };
  }
  if (provider === 'doubao') {
    const doubaoEndpoint = readEnv('DOUBAO_TTS_ENDPOINT') || DEFAULT_DOUBAO_TTS_ENDPOINT;
    const apiKey = readEnv('DOUBAO_TTS_API_KEY', 'DOUBAO_API_KEY', 'VOLCENGINE_TTS_API_KEY');
    const appId = readEnv('DOUBAO_TTS_APP_ID', 'VOLCENGINE_TTS_APPID');
    const accessKey = readEnv('DOUBAO_TTS_ACCESS_KEY', 'VOLCENGINE_TTS_ACCESS_KEY');
    const appKey = readEnv('DOUBAO_TTS_APP_KEY', 'VOLCENGINE_TTS_APP_KEY');
    const resourceId = readEnv('DOUBAO_TTS_RESOURCE_ID', 'VOLCENGINE_TTS_RESOURCE_ID') || DEFAULT_DOUBAO_TTS_RESOURCE_ID;
    const voice = readEnv('DOUBAO_TTS_SPEAKER', 'DOUBAO_TTS_VOICE_ID', 'VOLCENGINE_TTS_SPEAKER') || DEFAULT_DOUBAO_TTS_SPEAKER;
    const missing: string[] = [];
    if (!apiKey && !(appId && accessKey)) missing.push('DOUBAO_TTS_API_KEY 或 DOUBAO_TTS_APP_ID+DOUBAO_TTS_ACCESS_KEY');
    if (!resourceId) missing.push('DOUBAO_TTS_RESOURCE_ID');
    if (!voice) missing.push('DOUBAO_TTS_SPEAKER');
    return {
      configured: missing.length === 0,
      provider,
      missing,
      endpoint: doubaoEndpoint,
      model: resourceId,
      voiceId: voice,
      outputFormat: readOutputFormat('DOUBAO_TTS_FORMAT', 'VOLCENGINE_TTS_FORMAT'),
      sampleRate: readNumber(24000, 'DOUBAO_TTS_SAMPLE_RATE', 'VOLCENGINE_TTS_SAMPLE_RATE'),
    };
  }

  const apiKey = readEnv('MINIMAX_API_KEY', 'MINIMAX_TTS_API_KEY');
  return {
    configured: Boolean(apiKey),
    provider,
    missing: apiKey ? [] : ['MINIMAX_API_KEY'],
    endpoint,
    model,
    voiceId,
    outputFormat: readOutputFormat('MINIMAX_TTS_FORMAT'),
    sampleRate,
  };
}

export function getVoiceTtsConfig(): VoiceTtsConfig | null {
  const status = getVoiceTtsConfigStatus();
  if (!status.configured) return null;

  if (status.provider === 'doubao') {
    return {
      provider: 'doubao',
      endpoint: readEnv('DOUBAO_TTS_ENDPOINT') || DEFAULT_DOUBAO_TTS_ENDPOINT,
      apiKey: readEnv('DOUBAO_TTS_API_KEY', 'DOUBAO_API_KEY', 'VOLCENGINE_TTS_API_KEY'),
      appId: readEnv('DOUBAO_TTS_APP_ID', 'VOLCENGINE_TTS_APPID'),
      appKey: readEnv('DOUBAO_TTS_APP_KEY', 'VOLCENGINE_TTS_APP_KEY'),
      accessKey: readEnv('DOUBAO_TTS_ACCESS_KEY', 'VOLCENGINE_TTS_ACCESS_KEY'),
      resourceId: readEnv('DOUBAO_TTS_RESOURCE_ID', 'VOLCENGINE_TTS_RESOURCE_ID') || DEFAULT_DOUBAO_TTS_RESOURCE_ID,
      model: readEnv('DOUBAO_TTS_RESOURCE_ID', 'VOLCENGINE_TTS_RESOURCE_ID') || DEFAULT_DOUBAO_TTS_RESOURCE_ID,
      voiceId: readEnv('DOUBAO_TTS_SPEAKER', 'DOUBAO_TTS_VOICE_ID', 'VOLCENGINE_TTS_SPEAKER') || DEFAULT_DOUBAO_TTS_SPEAKER,
      outputFormat: readOutputFormat('DOUBAO_TTS_FORMAT', 'VOLCENGINE_TTS_FORMAT'),
      sampleRate: readNumber(24000, 'DOUBAO_TTS_SAMPLE_RATE', 'VOLCENGINE_TTS_SAMPLE_RATE'),
      speed: readNumber(0.95, 'DOUBAO_TTS_SPEED', 'VOLCENGINE_TTS_SPEED'),
      volume: readNumber(1, 'DOUBAO_TTS_VOLUME', 'VOLCENGINE_TTS_VOLUME'),
      pitch: readNumber(1, 'DOUBAO_TTS_PITCH', 'VOLCENGINE_TTS_PITCH'),
      synthesisTimeoutMs: readNumber(12000, 'DOUBAO_TTS_SYNTHESIS_TIMEOUT_MS', 'VOLCENGINE_TTS_SYNTHESIS_TIMEOUT_MS'),
    };
  }

  return {
    provider: 'minimax',
    endpoint: readEnv('MINIMAX_TTS_ENDPOINT') || DEFAULT_MINIMAX_ENDPOINT,
    apiKey: readEnv('MINIMAX_API_KEY', 'MINIMAX_TTS_API_KEY')!,
    model: readEnv('MINIMAX_TTS_MODEL') || DEFAULT_MINIMAX_MODEL,
    voiceId: readEnv('MINIMAX_TTS_VOICE_ID') || DEFAULT_MINIMAX_VOICE_ID,
    outputFormat: readOutputFormat('MINIMAX_TTS_FORMAT') as MiniMaxTtsConfig['outputFormat'],
    sampleRate: readNumber(32000, 'MINIMAX_TTS_SAMPLE_RATE'),
    bitrate: readNumber(128000, 'MINIMAX_TTS_BITRATE'),
    speed: readNumber(0.95, 'MINIMAX_TTS_SPEED'),
    volume: readNumber(1, 'MINIMAX_TTS_VOLUME'),
    pitch: readNumber(0, 'MINIMAX_TTS_PITCH'),
    connectTimeoutMs: readNumber(3500, 'MINIMAX_TTS_CONNECT_TIMEOUT_MS'),
    synthesisTimeoutMs: readNumber(12000, 'MINIMAX_TTS_SYNTHESIS_TIMEOUT_MS'),
  };
}

export function mimeTypeForTtsFormat(format: VoiceTtsConfig['outputFormat']): string {
  if (format === 'wav') return 'audio/wav';
  if (format === 'pcm') return 'audio/pcm';
  if (format === 'ogg_opus') return 'audio/ogg; codecs=opus';
  return 'audio/mpeg';
}
