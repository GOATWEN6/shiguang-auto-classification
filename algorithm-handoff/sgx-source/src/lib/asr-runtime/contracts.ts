import type {
  ProviderUsage,
  RuntimeIdentity,
} from '../algorithm-runtime/contracts.ts';

export interface Pcm16AudioFormat {
  codec: 'pcm16';
  sampleRateHz: number;
  bitsPerSample: number;
  channels: number;
}

export interface Pcm16AudioChunk {
  sequence: number;
  audio: Uint8Array;
  format: Pcm16AudioFormat;
  endOfStream: boolean;
}

export interface ValidatedPcm16AudioChunk extends Pcm16AudioChunk {
  byteLength: number;
  durationMs: number;
}

export interface AsrAttemptContext {
  identity: RuntimeIdentity;
  attemptId: string;
  connectionId: string;
}

export interface AsrEventContext extends AsrAttemptContext {
  receivedAt: string;
}

interface SequencedAsrEvent extends AsrEventContext {
  providerSequence: number;
  /** Stable digest of one decoded provider packet; never contains transcript text. */
  providerPacketFingerprint?: string;
}

interface SegmentAsrEvent extends SequencedAsrEvent {
  segmentIndex: number;
  revision: number;
  text: string;
  providerSegmentId?: string;
  startTimeMs?: number;
  endTimeMs?: number;
}

export interface AsrPartialEvent extends SegmentAsrEvent {
  kind: 'partial';
}

export interface AsrSegmentFinalEvent extends SegmentAsrEvent {
  kind: 'segment_final';
}

export interface AsrUsageEvent extends SequencedAsrEvent {
  kind: 'usage';
  usage: ProviderUsage;
}

export interface AsrStreamFinalEvent extends SequencedAsrEvent {
  kind: 'stream_final';
}

export type AsrCanonicalEvent =
  | AsrPartialEvent
  | AsrSegmentFinalEvent
  | AsrUsageEvent
  | AsrStreamFinalEvent;

export interface TranscriptEvidence {
  kind: 'transcript_final';
  evidenceId: string;
  segmentKey: string;
  identity: RuntimeIdentity;
  attemptId: string;
  connectionId: string;
  receivedAt: string;
  providerSequence: number;
  providerPacketFingerprint?: string;
  segmentIndex: number;
  revision: number;
  text: string;
  providerSegmentId?: string;
  startTimeMs?: number;
  endTimeMs?: number;
}

export type AsrRejectReason =
  | 'no_active_attempt'
  | 'stale_connection'
  | 'generation_mismatch'
  | 'response_id_missing'
  | 'response_id_mismatch'
  | 'evidence_mismatch'
  | 'cancelled'
  | 'finalized'
  | 'duplicate'
  | 'stale_revision'
  | 'final_already_committed'
  | 'after_stream_final'
  | 'incomplete_stream'
  | 'fatal_conflict'
  | 'invalid_schema';

export type AsrAcceptResult =
  | { accepted: true }
  | {
      accepted: false;
      reason: AsrRejectReason;
      errorCode?: 'invalid_schema' | 'incomplete_stream';
      fatal?: boolean;
    };

export interface AsrReducerSnapshot {
  activeAttempt?: AsrAttemptContext;
  usage?: ProviderUsage;
  streamFinal: boolean;
  pendingSegmentIndexes: number[];
  emittedSegmentCount: number;
  fatalError?: 'invalid_schema';
}

export interface AsrStreamReducerOptions {
  cancellationRegistry: {
    accepts(identity: RuntimeIdentity, channel: 'asr'): {
      accepted: boolean;
      reason?: string;
    };
  };
  onPartial?: (event: Record<string, unknown>) => void;
  onEvidence?: (evidence: Record<string, unknown>) => void;
  /**
   * Kept only as an observable hard-boundary probe. The reducer never invokes
   * this callback: transcript finals become Evidence, never Memory candidates.
   */
  onMemoryCandidate?: (candidate: Record<string, unknown>) => void;
}

export interface DoubaoDecodedUtterance {
  id?: string;
  index?: number;
  revision?: number;
  definite: boolean;
  text: string;
  start_time?: number;
  end_time?: number;
}

export interface DoubaoDecodedResult {
  text?: string;
  utterances?: DoubaoDecodedUtterance[];
}

export interface DoubaoDecodedPayload {
  code?: number;
  payload_sequence: number;
  last?: boolean;
  is_last_package?: boolean;
  result?: DoubaoDecodedResult;
  payload_msg?: {
    result?: DoubaoDecodedResult;
    audio_info?: { duration?: number };
  };
  usage?: ProviderUsage;
  audio_info?: { duration?: number };
}

export interface DoubaoTranslationContext extends AsrEventContext {}

export interface DoubaoTransportOpenOptions {
  [key: string]: unknown;
  identity: RuntimeIdentity;
  requestId: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  onDecodedPayload: (payload: unknown) => void | Promise<void>;
}

export interface DoubaoInjectedTransportConnection {
  send(value: ValidatedPcm16AudioChunk): void | Promise<void>;
  end(): void | Promise<void>;
  cancel(reason?: string): void | Promise<void>;
}

export interface DoubaoInjectedTransport {
  open(
    options: DoubaoTransportOpenOptions,
  ): DoubaoInjectedTransportConnection | Promise<DoubaoInjectedTransportConnection>;
}

export type DoubaoTransportFactory = () => DoubaoInjectedTransport;

export interface DoubaoStreamingAdapterOptions {
  transportFactory: DoubaoTransportFactory;
}

export interface DoubaoStreamingOpenOptions {
  identity: RuntimeIdentity;
  requestId: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  onDecodedPayload: (payload: unknown) => void | Promise<void>;
}

export interface DoubaoStreamingAsrSession {
  send(chunk: Pcm16AudioChunk): Promise<ValidatedPcm16AudioChunk>;
  end(): Promise<void>;
  cancel(reason: string): Promise<void>;
}

export interface DoubaoStreamingAsrAdapter {
  readonly provider: 'doubao-independent-streaming-asr';
  readonly hiddenRetryCapability: false;
  readonly networkCapability: 'injected_transport_only';
  open(options: DoubaoStreamingOpenOptions): Promise<DoubaoStreamingAsrSession>;
}
