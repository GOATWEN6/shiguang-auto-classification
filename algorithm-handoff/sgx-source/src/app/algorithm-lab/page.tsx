'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ClipboardCheck, Database, Download, FileText, Layers3, Mic, MicOff, RotateCcw, Send, ShieldCheck, Square, ThumbsDown, ThumbsUp, Volume2, VolumeX } from 'lucide-react';
import styles from './page.module.css';
import { Pcm16Packetizer, pcm16ToFloatSamples } from '../../lib/algorithm-service/browser-audio';

type Message = { id: string; role: 'user' | 'assistant'; text: string; turnId?: string };
type MemoryRecord = { recordId: string; status: string; candidate: {
  normalizedClaim: string; disposition: string; sensitivityLevel: string; contentType?: string;
  temporalState?: string; retentionPolicy?: string; evidenceRefs?: string[]; allowedUses?: string[];
  canonicalWritePerformed?: boolean; visibilityScope?: string[];
} };
type Artifact = { id: string; kind: string; artifact: { kind?: string; schemaVersion?: string;
  sentences?: { text: string; uncertainty?: string; evidenceRefs?: string[]; claimMode?: string }[];
  fields?: { path: string; value: string; temporalScope?: string; uncertainty?: string; evidenceRefs?: string[]; claimMode?: string }[];
  images?: { url?: string; status?: string; prompt?: string; errorCode?: string; evidenceRefs?: string[] }[];
  sourceRecordIds?: string[]; sourceGovernance?: { recordId: string; sensitivityLevel?: string; temporalState?: string }[];
} };
type MemoryDiagnostic = { jobId: string; evidenceRefs: string[]; providerProposalCount?: number;
  validCandidateCount?: number; rejectedCandidateCount?: number;
  rejectedCandidates?: { index: number; reason: string }[]; finalSubmissionStatus?: string;
  mustExtractCount: number;
  semanticInputCount: number; semanticAcceptedCount: number; semanticRejectedCount: number;
  outputCount: number; semanticRejections: { index: number; reason: string }[];
  extractionCompleteness: string; processingStatus: string; commitStatus: string;
  committedCandidateCount: number; errorCode: string | null; partial: boolean;
};
type View = { mode: string; status: string; currentTarget: string | null;
  interviewPolicyVersion?: string; memoryOperationGuardVersion?: string;
  memory: MemoryRecord[]; memoryExtractions?: MemoryDiagnostic[]; artifacts: Artifact[];
  storage?: { durable: boolean; canonicalWriteCapability: boolean };
};
type TurnRecord = { id: string; userText: string; assistantText: string; startedAt: string;
  finishedAt?: string; result?: unknown; view?: View | null };
type MessageRating = { value: 'good' | 'bad'; note: string; updatedAt: string };
type ReviewFeedback = { id: string; role: string; followUpValue: string; memoryAccuracy: string;
  draftUsability: string; waitingAcceptability: string; safety: string; note: string; createdAt: string };
type CostTable = { schemaVersion: string; generatedAt: string; basis: string; actualCostAvailable: boolean;
  rows: { ipFingerprint: string; sessionLabel: string; round: number; modules: string[]; attemptCount: number;
    reservedCny: number; actualCostCny: number | null; billingState: string; firstAt: string; lastAt: string }[];
  ipTotals: { ipFingerprint: string; sessionCount: number; roundCount: number; attemptCount: number;
    reservedCny: number; actualCostCny: number | null; billingState: string }[];
  unattributedEntryCount: number; note: string;
  legacyAggregate?: { reservationCount: number; reservedCny: number; moduleTotals: Record<string, number>; moduleCounts: Record<string, number>;
    ipBinding: string; sessionBinding: string; roundBinding: string };
  budgetAggregate?: { batchCapCny?: number; reservedCny?: number | null; cumulativeReservedCny?: number;
    priorExposureCny?: number; remainingProgramCny?: number; actualCostCny?: number | null; billingState?: string } };
type VadHandle = { start(): Promise<void>; pause(): Promise<void>; destroy(): Promise<void> };
type Capture = { packetizer: Pcm16Packetizer; opened: Promise<string | null>; sent: Promise<void>; failed: boolean };
const labels: Record<string, string> = { idle: '可以开始', recording: '正在听您说',
  ASR: '正在识别', MODEL_PENDING: '正在想一想', PRE_TTS: '准备说话',
  TTS_STREAMING: '准备语音', speaking: '助手正在说话', ASYNC_JOBS: '正在整理',
  COMPLETED: '可以继续', INTERRUPTED: '已经停下', ERROR: '可以重试', ended: '本次交流已结束' };
const base = '/api/algorithm/v0.1';

function pcmBase64(pcm: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < pcm.length; offset += 8192) {
    binary += String.fromCharCode(...pcm.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export default function AlgorithmLab() {
  const [health, setHealth] = useState<{ mode?: string; status?: string; budgetAuthorized?: boolean;
    budget?: { batchCapCny?: number; reservedCny?: number; cumulativeReservedCny?: number; remainingProgramCny?: number; ownerReportRequired?: boolean; billingState?: string } } | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [phase, setPhase] = useState('idle');
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [notice, setNotice] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [tab, setTab] = useState<'memory' | 'story' | 'profile' | 'article' | 'review' | 'cost'>('memory');
  const [partialText, setPartialText] = useState('');
  const [canReplay, setCanReplay] = useState(false);
  const [muted, setMuted] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [lastResult, setLastResult] = useState<any>(null);
  const [messageRatings, setMessageRatings] = useState<Record<string, MessageRating>>({});
  const [reviewFeedback, setReviewFeedback] = useState<ReviewFeedback[]>([]);
  const [reviewRole, setReviewRole] = useState('算法工程师');
  const [reviewForm, setReviewForm] = useState({ followUpValue: '待评估', memoryAccuracy: '待评估', draftUsability: '待评估', waitingAcceptability: '待评估', safety: '通过', note: '' });
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [asrDraftReady, setAsrDraftReady] = useState(false);
  const [interruptMessage, setInterruptMessage] = useState('');
  const [runtimeVersion, setRuntimeVersion] = useState<{ runtimeFingerprint?: { tts?: { voiceId?: string; model?: string } } } | null>(null);
  const [costTable, setCostTable] = useState<CostTable | null>(null);
  const target = useRef<string | null>(null);
  const session = useRef<string | null>(null);
  const subjectBinding = useRef<string | null>(null);
  const vad = useRef<VadHandle | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioURL = useRef<string | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const partial = useRef('');
  const pausedPlayback = useRef(false);
  const audioContext = useRef<AudioContext | null>(null);
  const pcmGain = useRef<GainNode | null>(null);
  const mutedPlayback = useRef(false);
  const pcmSources = useRef(new Set<AudioBufferSourceNode>());
  const nextAudioAt = useRef(0);
  const audioChain = useRef<Promise<void>>(Promise.resolve());
  const savedPcm = useRef<{ base64Audio: string; mimeType: string }[]>([]);
  const microphoneEnabled = useRef(false);
  const preFrames = useRef<Float32Array[]>([]);
  const candidateFrames = useRef<Float32Array[] | null>(null);
  const capture = useRef<Capture | null>(null);
  const messagesViewport = useRef<HTMLDivElement | null>(null);
  const autoScrollMessages = useRef(true);
  const interruptTimer = useRef<number | null>(null);

  useEffect(() => {
    const viewport = messagesViewport.current;
    if (!viewport || !autoScrollMessages.current) return;
    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, partialText]);

  const refresh = async (id = session.current): Promise<View | null> => {
    if (!id) return null;
    const response = await fetch(`${base}/sessions/${id}/view`, { cache: 'no-store' });
    if (response.ok) {
      const snapshot = await response.json() as View;
      setView(snapshot);
      setLastRefreshAt(new Date().toISOString());
      if (['ENDED', 'PAUSED'].includes(snapshot.status)) {
        microphoneEnabled.current = false; setMicOn(false); await vad.current?.pause();
        setPhase(snapshot.status === 'ENDED' ? 'ended' : 'INTERRUPTED');
      }
      return snapshot;
    }
    return null;
  };
  async function refreshView() {
    if (!session.current || refreshing) return;
    setRefreshing(true);
    try {
      const [snapshot] = await Promise.all([refresh(), refreshCosts()]);
      if (snapshot) setNotice('记忆、画像和成文结果已刷新。');
      else setNotice('整理结果暂时没有刷新成功，请稍后再试。');
    } catch {
      setNotice('整理结果暂时没有刷新成功，请稍后再试。');
    } finally {
      setRefreshing(false);
    }
  }
  async function refreshCosts(): Promise<CostTable | null> {
    try {
      const response = await fetch(`${base}/costs`, { cache: 'no-store' });
      if (!response.ok) return null;
      const table = await response.json() as CostTable;
      setCostTable(table);
      return table;
    } catch { return null; }
  }
  async function refreshAfterAsyncJobs(id: string, kinds: string[]) {
    // This only reads the existing session view. It never creates another model call.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 1200));
      const snapshot = await refresh(id);
      if (!snapshot) return;
      const settled = kinds.every(kind => {
        if (kind === 'MEMORY') {
          return (snapshot.memoryExtractions ?? []).some(item => item.processingStatus !== 'PENDING');
        }
        return snapshot.artifacts.some(item => item.kind === kind);
      });
      if (settled) {
        setNotice('本轮整理结果已经更新到右侧。');
        return;
      }
    }
    setNotice('对话已完成，部分整理仍在后台处理；可点击“刷新结果”再次查看。');
  }
  function showInterruptMessage(message: string, clearAfterMs = 3600) {
    if (interruptTimer.current) window.clearTimeout(interruptTimer.current);
    setInterruptMessage(message);
    if (clearAfterMs > 0) {
      interruptTimer.current = window.setTimeout(() => setInterruptMessage(''), clearAfterMs);
    }
  }
  useEffect(() => {
    void Promise.all([
      fetch(`${base}/health`, { cache: 'no-store' }).then(response => response.json()),
      fetch(`${base}/version`, { cache: 'no-store' }).then(response => response.json()),
      fetch(`${base}/costs`, { cache: 'no-store' }).then(response => response.ok ? response.json() : null),
    ]).then(([healthResult, versionResult, costResult]) => { setHealth(healthResult); setRuntimeVersion(versionResult); setCostTable(costResult); })
      .catch(() => setNotice('服务暂时没有连接，请稍后重试。'));
    return () => { activeRequest.current?.abort(); void vad.current?.destroy(); audio.current?.pause();
      for (const source of pcmSources.current) { try { source.stop(); } catch { /* already stopped */ } }
      void audioContext.current?.close();
      if (audioURL.current) URL.revokeObjectURL(audioURL.current);
      if (interruptTimer.current) window.clearTimeout(interruptTimer.current); };
  }, []);

  function stopPlayback() {
    for (const source of pcmSources.current) { source.onended = null; try { source.stop(); } catch { /* already stopped */ } }
    pcmSources.current.clear(); nextAudioAt.current = 0;
    void audioContext.current?.resume();
    audio.current?.pause();
    audio.current = null;
    if (audioURL.current) URL.revokeObjectURL(audioURL.current);
    audioURL.current = null;
    pausedPlayback.current = false;
  }
  async function interrupt() {
    stopPlayback();
    generation.current += 1;
    setPhase('INTERRUPTED');
    showInterruptMessage('正在停止上一段回复…', 0);
    const id = session.current;
    const oldTarget = target.current;
    const oldRequest = activeRequest.current;
    if (capture.current) capture.current.failed = true;
    if (!id || !oldTarget) { oldRequest?.abort(); showInterruptMessage('已停止当前播放，正在等待新的输入。'); return; }
    try {
      const response = await fetch(`${base}/sessions/${id}/interrupts`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          schemaVersion: 'algorithm-interrupt-v0.1', idempotencyKey: crypto.randomUUID(),
          interruptTargetHandle: oldTarget, reason: 'user_speech' }) });
      if (response.status !== 202 && response.status !== 409) {
        setNotice('声音已停；服务端取消需要重试。');
        showInterruptMessage('本地声音已停，但服务端还没有确认打断。');
      } else {
        showInterruptMessage('已打断上一段回复，接下来只处理您刚才说的内容。');
      }
    } catch {
      setNotice('声音已停，连接暂时中断。');
      showInterruptMessage('本地声音已停，服务端连接暂时中断。');
    }
    if (target.current === oldTarget) target.current = null;
    oldRequest?.abort();
  }
  async function createSession() {
    const response = await fetch(`${base}/sessions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        schemaVersion: 'algorithm-session-create-v0.1', idempotencyKey: crypto.randomUUID(), requestedMode: 'DAILY_CHAT',
        ...(subjectBinding.current ? { subjectBinding: subjectBinding.current } : {}) }) });
    if (!response.ok) { setNotice('模型配置或调用预算尚未就绪。'); return null; }
    const result = await response.json();
    session.current = result.opaqueSessionHandle;
    subjectBinding.current = result.subjectBinding;
    setHandle(result.opaqueSessionHandle);
    autoScrollMessages.current = true;
    setMessages([]); setView(null); setNotice(''); setPhase('idle'); setTurns([]); setLastResult(null); setCurrentTurnId(null); setMessageRatings({}); setReviewFeedback([]); setLastRefreshAt(null); setAsrDraftReady(false); setInterruptMessage('');
    return result.opaqueSessionHandle as string;
  }
  async function play(base64: string, mimeType: string, currentGeneration: number) {
    if (mimeType.startsWith('audio/pcm;')) {
      savedPcm.current.push({ base64Audio: base64, mimeType }); setCanReplay(true);
      queuePcm(base64, currentGeneration); return;
    }
    stopPlayback();
    const binary = atob(base64);
    const blob = new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: mimeType });
    const url = URL.createObjectURL(blob);
    audioURL.current = url;
    const element = new Audio(url);
    element.muted = mutedPlayback.current;
    audio.current = element;
    element.onended = () => { if (generation.current === currentGeneration) setPhase(micOn ? 'recording' : 'idle'); };
    setPhase('speaking');
    try { await element.play(); } catch { setNotice('浏览器没有自动播放；可以点击播放回复。'); }
  }
  async function activateAudio(resume = true) {
    audioContext.current ??= new AudioContext();
    if (!pcmGain.current) {
      pcmGain.current = audioContext.current.createGain();
      pcmGain.current.gain.value = mutedPlayback.current ? 0 : 1;
      pcmGain.current.connect(audioContext.current.destination);
    }
    if (resume && audioContext.current.state === 'suspended') await audioContext.current.resume();
  }
  function queuePcm(base64Audio: string, currentGeneration: number) {
    audioChain.current = audioChain.current.catch(() => undefined).then(async () => {
      if (generation.current !== currentGeneration) return;
      await activateAudio(!pausedPlayback.current);
      const context = audioContext.current!;
      const samples = pcm16ToFloatSamples(Uint8Array.from(atob(base64Audio), char => char.charCodeAt(0)));
      const buffer = context.createBuffer(1, samples.length, 24_000); buffer.getChannelData(0).set(samples);
      if (generation.current !== currentGeneration) return;
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(pcmGain.current ?? context.destination);
      const startAt = Math.max(context.currentTime + 0.025, nextAudioAt.current);
      nextAudioAt.current = startAt + buffer.duration; pcmSources.current.add(source); setPhase('speaking');
      source.onended = () => {
        pcmSources.current.delete(source);
        if (!pcmSources.current.size && !pending.current && generation.current === currentGeneration) {
          target.current = null; setPhase(microphoneEnabled.current ? 'recording' : 'idle');
        }
      };
      source.start(startAt);
    }).catch(() => setNotice('语音暂时无法播放，文字回复仍可查看。'));
  }
  async function runTurn(input: { source: 'TYPED_TEXT'; text: string } | { source: 'ASR_STREAM'; asrStreamId: string }, enterInterview = false) {
    if (pending.current) { setNotice('请等待本轮完成，或先打断。'); return; }
    const id = session.current ?? await createSession();
    if (!id) return;
    const currentGeneration = ++generation.current;
    const turnId = crypto.randomUUID();
    let turnUserText = input.source === 'TYPED_TEXT' ? input.text : '';
    let turnAssistantText = '';
    setCurrentTurnId(turnId);
    setTurns(prior => [...prior, { id: turnId, userText: turnUserText, assistantText: '', startedAt: new Date().toISOString() }]);
    const requestController = new AbortController();
    activeRequest.current = requestController;
    setRequestBusy(true);
    savedPcm.current = []; setCanReplay(false); setPartialText('');
    const task = (async () => {
      try {
        setNotice(''); setPhase(input.source === 'ASR_STREAM' ? 'ASR' : 'MODEL_PENDING');
        if (input.source === 'TYPED_TEXT') setMessages(prior => [...prior, { id: `${turnId}:user`, role: 'user', text: input.text, turnId }]);
        const response = await fetch(`${base}/sessions/${id}/stream`, { method: 'POST',
          signal: requestController.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            schemaVersion: 'algorithm-stream-turn-v0.2', idempotencyKey: crypto.randomUUID(), ...input,
            ...(enterInterview ? { uiEvent: { type: 'MEMORY_TOPIC_CLICK', ref: `ui-${crypto.randomUUID()}` } } : {}) }) });
        if (!response.ok || !response.body) throw new Error('request_failed');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        let userTranscriptAdded = false;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffered += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const raw = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
            if (!raw) continue;
            const event = JSON.parse(raw);
            if (currentGeneration !== generation.current) continue;
            if (event.targetHandle) target.current = event.targetHandle;
            if ((event.type === 'ready' || event.type === 'phase') && !pcmSources.current.size) setPhase(event.phase);
            if (event.type === 'transcript') {
              partial.current = event.text;
              setPartialText(event.final ? '' : event.text);
              if (event.final && !userTranscriptAdded) {
                userTranscriptAdded = true;
                turnUserText = event.text;
                setText(event.text);
                setAsrDraftReady(true);
                setMessages(prior => [...prior, { id: `${turnId}:user`, role: 'user', text: event.text, turnId }]);
                setTurns(prior => prior.map(item => item.id === turnId ? { ...item, userText: event.text } : item));
              }
            }
            if (event.type === 'text') {
              if (interruptMessage) showInterruptMessage('已打断上一段回复，正在处理这次新的内容。');
              turnAssistantText += event.text;
              setMessages(prior => [...prior, { id: `${turnId}:assistant`, role: 'assistant', text: event.text, turnId }]);
              setTurns(prior => prior.map(item => item.id === turnId ? { ...item, assistantText: `${item.assistantText}${event.text}` } : item));
            }
            if (event.type === 'audio') void play(event.base64Audio, event.mimeType, currentGeneration);
            if (event.type === 'result') {
              const result = event.result;
              setLastResult(result);
              setTurns(prior => prior.map(item => item.id === turnId ? { ...item, result } : item));
              if (result.response?.text && health?.mode === 'LOCAL_FAKE') {
                turnAssistantText += result.response.text;
                setMessages(prior => [...prior, { id: `${turnId}:assistant`, role: 'assistant', text: result.response.text, turnId }]);
              }
              if (result.status === 'error') setNotice('本轮没有完成，您可以重试或改用文字。');
              const pendingAsyncKinds = (result.asyncJobs ?? [])
                .filter((job: { status: string }) => job.status === 'pending' || job.status === 'running')
                .map((job: { kind?: string }) => job.kind)
                .filter((kind: unknown): kind is string => typeof kind === 'string');
              if (pendingAsyncKinds.length) {
                setNotice('对话已完成；Memory、画像或成文正在后台整理。');
                if (autoRefresh) void refreshAfterAsyncJobs(id, pendingAsyncKinds);
              }
              if (result.asyncJobs?.some((job: { status: string }) => job.status === 'failed')) {
                setNotice('对话已完成；部分整理任务未成功，可查看现有结果。');
              }
              if (result.tts?.status === 'audio_unavailable') setNotice('本轮语音暂不可用，文字回复已经显示。');
              if ((!audio.current || audio.current.paused) && !pcmSources.current.size) setPhase(result.phase ?? (result.status === 'error' ? 'ERROR' : 'COMPLETED'));
              if (result.response?.retentionIntent === 'NO_SAVE') { savedPcm.current = []; setCanReplay(false); }
            }
          }
        }
      } catch { if (currentGeneration === generation.current) { setPhase('ERROR'); setNotice('本轮未完成，可以重试或改用文字。'); } }
      finally { if (!pcmSources.current.size && (!audio.current || audio.current.paused)
          && generation.current === currentGeneration) target.current = null;
        if (activeRequest.current === requestController) activeRequest.current = null;
        const [snapshot] = await Promise.all([refresh(id), refreshCosts()]);
        setTurns(prior => prior.map(item => item.id === turnId ? { ...item, userText: turnUserText, assistantText: turnAssistantText || item.assistantText, finishedAt: new Date().toISOString(), view: snapshot } : item)); }
    })();
    pending.current = task;
    try { await task; } finally { if (pending.current === task) { pending.current = null; setRequestBusy(false); } }
  }
  function sendPacket(state: Capture, packet: ReturnType<Pcm16Packetizer['finish']> | ReturnType<Pcm16Packetizer['push']>[number]) {
    state.sent = state.sent.then(async () => {
      const streamId = await state.opened;
      if (!streamId || state.failed || !session.current) return;
      const response = await fetch(`${base}/sessions/${session.current}/asr/${streamId}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 'algorithm-asr-chunk-v0.1',
          sequence: packet.sequence, base64Audio: pcmBase64(packet.audio), endOfStream: packet.endOfStream }) });
      if (!response.ok) throw new Error('audio_send_failed');
      const result = await response.json(); if (!state.failed) setPartialText(result.transcript?.text ?? '');
    }).catch(() => { state.failed = true; setNotice('这段语音没有完整识别，请再说一次或改用文字。'); });
  }
  async function toggleMic() {
    if (micOn) { microphoneEnabled.current = false; await vad.current?.pause(); setMicOn(false);
      if (capture.current) await interrupt(); capture.current = null; setPartialText(''); setPhase('idle'); return; }
    if (health?.mode !== 'REAL_INTERNAL') { setNotice('当前为 Fake，麦克风测试需要真实模式。'); return; }
    const id = session.current ?? await createSession();
    if (!id) return;
    if (!navigator.mediaDevices?.getUserMedia) { setNotice('麦克风需要安全连接，请使用电脑本机地址或手机安全入口。'); return; }
    await activateAudio();
    try {
      if (!vad.current) {
        const { MicVAD } = await import('@ricky0123/vad-web');
        vad.current = await MicVAD.new({ model: 'v5', baseAssetPath: '/vad/', onnxWASMBasePath: '/vad/',
          processorType: 'AudioWorklet', startOnLoad: false, positiveSpeechThreshold: 0.78,
          negativeSpeechThreshold: 0.45, minSpeechMs: 180, redemptionMs: 700, preSpeechPadMs: 200,
          getStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true,
            noiseSuppression: true, autoGainControl: true, channelCount: 1 } }),
          onFrameProcessed(_probabilities, frame) {
            if (!microphoneEnabled.current) return;
            const copied = frame.slice(); preFrames.current = [...preFrames.current, copied].slice(-7);
            if (candidateFrames.current) candidateFrames.current.push(copied);
            const state = capture.current;
            if (state && !state.failed) {
              try { for (const packet of state.packetizer.push(copied)) sendPacket(state, packet); }
              catch { state.failed = true; void interrupt(); setNotice('这段较长，请分成两段继续。'); }
            }
          },
          onSpeechStart() {
            if (!microphoneEnabled.current) return;
            candidateFrames.current = [...preFrames.current];
            if (audio.current && !audio.current.paused) { audio.current.pause(); pausedPlayback.current = true; }
            if (pcmSources.current.size) { pausedPlayback.current = true; void audioContext.current?.suspend(); }
            setPhase('recording');
          },
          onSpeechRealStart() {
            if (!microphoneEnabled.current) return;
            const frames = candidateFrames.current ?? []; candidateFrames.current = null;
            const state: Capture = { packetizer: new Pcm16Packetizer(), opened: Promise.resolve(null),
              sent: Promise.resolve(), failed: false };
            state.opened = (async () => {
              if (target.current || pending.current || pcmSources.current.size || audio.current) await interrupt();
              await pending.current;
              if (!microphoneEnabled.current || state.failed || !session.current) return null;
              const response = await fetch(`${base}/sessions/${session.current}/asr`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                  schemaVersion: 'algorithm-asr-open-v0.1', idempotencyKey: crypto.randomUUID() }) });
              if (!response.ok) throw new Error('asr_open_failed');
              const result = await response.json();
              if (state.failed || !microphoneEnabled.current) {
                await fetch(`${base}/sessions/${session.current}/interrupts`, { method: 'POST',
                  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    schemaVersion: 'algorithm-interrupt-v0.1', idempotencyKey: crypto.randomUUID(),
                    interruptTargetHandle: result.targetHandle, reason: 'explicit_cancel' }) });
                return null;
              }
              target.current = result.targetHandle;
              return result.asrStreamId as string;
            })().catch(() => { state.failed = true; setNotice('语音连接暂未完成，请再试一次。'); return null; });
            capture.current = state;
            for (const frame of frames) for (const packet of state.packetizer.push(frame)) sendPacket(state, packet);
          },
          onVADMisfire() {
            if (pausedPlayback.current && audio.current) {
              pausedPlayback.current = false;
              void audio.current.play(); setPhase('speaking');
            }
            candidateFrames.current = null;
            if (pausedPlayback.current) { pausedPlayback.current = false; void audioContext.current?.resume(); setPhase('speaking'); }
          },
          async onSpeechEnd() {
            const state = capture.current; capture.current = null; candidateFrames.current = null;
            if (!state || !microphoneEnabled.current || state.failed) return;
            sendPacket(state, state.packetizer.finish()); await state.sent;
            const streamId = await state.opened;
            if (streamId && !state.failed && microphoneEnabled.current) await runTurn({ source: 'ASR_STREAM', asrStreamId: streamId });
          },
        });
      }
      microphoneEnabled.current = true; await vad.current.start(); setMicOn(true); setPhase('recording');
    } catch { microphoneEnabled.current = false; setNotice('麦克风暂未启动，请检查浏览器麦克风授权。'); }
  }
  async function reset() {
    microphoneEnabled.current = false; setMicOn(false); await vad.current?.pause();
    await interrupt(); await pending.current;
    if (session.current) await fetch(`${base}/sessions/${session.current}/end`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        schemaVersion: 'algorithm-session-end-v0.1', idempotencyKey: crypto.randomUUID() }) });
    session.current = null; setHandle(null); capture.current = null; savedPcm.current = []; setCanReplay(false); await createSession();
  }

  function rateMessage(messageId: string, value: 'good' | 'bad') {
    setMessageRatings(prior => ({ ...prior, [messageId]: { value, note: prior[messageId]?.note ?? '', updatedAt: new Date().toISOString() } }));
  }

  function toggleMute() {
    const next = !mutedPlayback.current;
    mutedPlayback.current = next;
    setMuted(next);
    if (audio.current) audio.current.muted = next;
    if (pcmGain.current && audioContext.current) {
      const now = audioContext.current.currentTime;
      pcmGain.current.gain.cancelScheduledValues(now);
      pcmGain.current.gain.setTargetAtTime(next ? 0 : 1, now, 0.015);
    }
  }

  function handleMessagesScroll() {
    const viewport = messagesViewport.current;
    if (!viewport) return;
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 72;
    autoScrollMessages.current = atBottom;
  }

  function submitReview(event: FormEvent) {
    event.preventDefault();
    setReviewFeedback(prior => [...prior, { id: crypto.randomUUID(), role: reviewRole, ...reviewForm, createdAt: new Date().toISOString() }]);
    setReviewForm({ followUpValue: '待评估', memoryAccuracy: '待评估', draftUsability: '待评估', waitingAcceptability: '待评估', safety: '通过', note: '' });
    setNotice('评审已暂存，可继续补充；结束后请导出反馈包。');
  }

  function exportFeedback() {
    const mediaDiagnostics = turns.map(turn => {
      const result = turn.result as { status?: string; errorCode?: string | null; tts?: { status?: string; audioChunkCount?: number }; asyncJobs?: { kind?: string; status?: string; errorCode?: string | null }[] } | undefined;
      return { turnId: turn.id, startedAt: turn.startedAt, finishedAt: turn.finishedAt,
        ttsStatus: result?.tts?.status ?? 'UNAVAILABLE', audioChunkCount: result?.tts?.audioChunkCount ?? 0,
        turnStatus: result?.status ?? 'UNKNOWN', errorCode: result?.errorCode ?? null,
        asyncJobs: result?.asyncJobs ?? [] };
    });
    const imageDiagnostics = (view?.artifacts ?? []).flatMap(artifact =>
      (artifact.artifact.images ?? []).map(image => ({ artifactId: artifact.id, kind: artifact.kind, ...image })));
    const payload = { schemaVersion: 'sgx-human-test-feedback-v0.2', exportedAt: new Date().toISOString(),
      purpose: '用于定位输入、追问、Memory、故事/画像、ASR、TTS、打断和等待问题；不把一次内部测试当作真人效果结论。',
      health, runtimeVersion, sessionHandle: handle,
      testMode: '固定虚构案例/内部成年人扮演，不等于真人效果结论', turns, messages,
      messageRatings, reviewFeedback, latestView: view, latestResult: lastResult,
      mediaDiagnostics, imageDiagnostics,
      budgetSnapshot: health?.budget ?? null, costTable,
      storageStatement: '当前工作台为进程内测试存储；不写入正式 CanonicalMemory；反馈包不包含 API Key。' };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `sgx-human-test-feedback-${new Date().toISOString().replaceAll(':', '-')}.json`; anchor.click(); URL.revokeObjectURL(url);
  }

  const memories = view?.memory ?? [];
  const shortMemories = memories.filter(record => record.candidate.temporalState === 'TEMPORARY_CURRENT' || record.candidate.retentionPolicy === 'expire_after_context');
  const longMemories = memories.filter(record => !shortMemories.includes(record));
  const calledRefs = new Set<string>(lastResult?.response?.evidenceRefs ?? []);
  const calledMemories = memories.filter(record => (record.candidate.evidenceRefs ?? []).some(ref => calledRefs.has(ref)));
  const storyArtifacts = view?.artifacts.filter(item => item.kind === 'STORY') ?? [];
  const profileArtifacts = view?.artifacts.filter(item => item.kind === 'PROFILE') ?? [];
  const latestStory = storyArtifacts.at(-1);
  const latestProfile = profileArtifacts.at(-1);
  const batchRemaining = health?.budget?.batchCapCny !== undefined && health?.budget?.reservedCny !== undefined
    ? Math.max(0, health.budget.batchCapCny - health.budget.reservedCny) : null;

  return <main className={styles.main}>
    <header className={styles.header}>
      <a href="/" aria-label="返回"><ArrowLeft size={20} /></a>
      <div><h1>SGX 真人测试工作台</h1><span className={styles.secondary}>内部虚构案例 · {health?.mode === 'REAL_INTERNAL' ? '豆包真实模块链路' : '服务未连接'} · 先验证算法，再进入真人访谈</span></div>
      <button onClick={() => void reset()} title="重新开始"><RotateCcw size={18} />重新开始</button>
    </header>
    <div className={styles.workspace}>
      <section className={styles.conversation}>
        <div className={styles.toolbar}><span role="status">{labels[phase] ?? phase}</span>
          <button disabled={!handle || view?.mode === 'FORMAL_INTERVIEW'} onClick={() => { void activateAudio(); void runTurn({ source: 'TYPED_TEXT', text: '我想聊聊往事。' }, true); }}>聊往事</button>
          <button onClick={() => void interrupt()}><Square size={16} />停下</button>
          <button type="button" onClick={toggleMute} aria-pressed={muted} title={muted ? '打开声音' : '静音播放'}>
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}{muted ? '已静音' : '静音'}
          </button>
          <button disabled={requestBusy || (!audio.current && !canReplay)} onClick={() => {
            if (savedPcm.current.length) { stopPlayback(); const current = ++generation.current;
              for (const chunk of savedPcm.current) queuePcm(chunk.base64Audio, current); }
            else void audio.current?.play();
          }} title="播放回复"><Volume2 size={18} /></button>
        </div>
        {interruptMessage && <div className={styles.interruptStatus} role="status" aria-live="polite"><Square size={15} /><span>{interruptMessage}</span></div>}
        <div className={styles.testBanner}><ShieldCheck size={17} /><span>内部测试：保留原话、模型输出和评审意见；当前不会写入正式 CanonicalMemory。</span></div>
        <div ref={messagesViewport} className={styles.messages} aria-live="polite" onScroll={handleMessagesScroll}>
          {messages.map(message => <div key={message.id} className={message.role === 'user' ? styles.user : styles.assistant}>
            <div className={styles.messageMeta}><span className={styles.secondary}>{message.role === 'user' ? '您' : '助手'}</span>{message.role === 'assistant' && <span className={styles.messageActions}>
              <button type="button" className={messageRatings[message.id]?.value === 'good' ? styles.ratingActive : ''} onClick={() => rateMessage(message.id, 'good')} aria-label="这条回复好"><ThumbsUp size={15} /></button>
              <button type="button" className={messageRatings[message.id]?.value === 'bad' ? styles.ratingBad : ''} onClick={() => rateMessage(message.id, 'bad')} aria-label="这条回复不好"><ThumbsDown size={15} /></button>
            </span>}</div><p>{message.text}</p>
          </div>)}
          {partialText && <p className={styles.secondary}>正在识别：{partialText}</p>}
        </div>
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {asrDraftReady && <p className={styles.transcriptDraft} role="status">语音识别结果已放入输入框，可修改后再发送。</p>}
        <form className={styles.input} onSubmit={event => { event.preventDefault(); const value = text.trim();
          if (value) { setText(''); setAsrDraftReady(false); void activateAudio(); void runTurn({ source: 'TYPED_TEXT', text: value }); } }}>
          <button type="button" className={micOn ? styles.active : ''} onClick={() => void toggleMic()} title={micOn ? '关闭麦克风' : '打开麦克风'}>
            {micOn ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <textarea aria-label="说点什么" placeholder={asrDraftReady ? '可修改语音识别结果…' : '说点什么…'} value={text}
            enterKeyHint="send" onChange={event => { setText(event.target.value); setAsrDraftReady(false); }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={2} />
          <button type="submit" disabled={!text.trim()} title="发送"><Send size={20} /></button>
        </form>
      </section>
      <aside className={styles.results}>
        <div className={styles.resultsHeading}><div><span className={styles.eyebrow}>证据与评审</span><h2>本轮产出</h2></div><div className={styles.resultActions}><button type="button" onClick={() => void refreshView()} disabled={!handle || refreshing}><RotateCcw size={16} />{refreshing ? '刷新中' : '刷新结果'}</button><button type="button" onClick={exportFeedback}><Download size={16} />导出反馈包</button></div></div>
        <div className={styles.refreshBar}><label><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />自动刷新 Memory、画像和成文</label><span>{lastRefreshAt ? `上次刷新 ${new Date(lastRefreshAt).toLocaleTimeString()}` : '完成一轮后自动检查后台整理'}</span></div>
        <div className={styles.runtimeBar}><span>当前音色：{runtimeVersion?.runtimeFingerprint?.tts?.voiceId ?? '由服务端配置'}</span><span>模型：{runtimeVersion?.runtimeFingerprint?.tts?.model ?? '豆包 TTS'}</span><span>预算门禁：{health?.budgetAuthorized ? '已开启' : '未开启'}{batchRemaining !== null ? ` · 本批剩余约 ${batchRemaining.toFixed(2)} 元` : ''}</span></div>
        <nav className={styles.tabs}>
          <button aria-pressed={tab === 'memory'} onClick={() => setTab('memory')}>记忆</button>
          <button aria-pressed={tab === 'story'} onClick={() => setTab('story')}>故事草稿</button>
          <button aria-pressed={tab === 'profile'} onClick={() => setTab('profile')}>基础画像</button>
          <button aria-pressed={tab === 'article'} onClick={() => setTab('article')}>最终成文</button>
          <button aria-pressed={tab === 'review'} onClick={() => setTab('review')}>反馈收集</button>
          <button aria-pressed={tab === 'cost'} onClick={() => { setTab('cost'); void refreshCosts(); }}>成本统计</button>
        </nav>
        {tab === 'memory' && <div className={styles.panelStack}>
          <div className={styles.storageNote}><Database size={17} /><div><strong>存储边界</strong><span>{view?.storage?.durable ? '已接入持久化存储' : '当前是进程内测试存储'}；正式权威记忆写入：{view?.storage?.canonicalWriteCapability ? '可用' : '关闭'}。</span></div></div>
          <div className={styles.statGrid}><div><strong>{calledMemories.length}</strong><span>本轮调用</span></div><div><strong>{memories.length}</strong><span>当前沉淀</span></div><div><strong>{shortMemories.length}</strong><span>短期</span></div><div><strong>{longMemories.length}</strong><span>长期/历史</span></div></div>
          <section className={styles.subsection}><h3><Layers3 size={16} />本轮调用的 Memory</h3>{calledMemories.length ? calledMemories.map(record => <MemoryCard key={record.recordId} record={record} called />) : <p className={styles.secondary}>本轮回复没有可追溯的 Memory 引用，或服务还未完成一轮。</p>}</section>
          <section className={styles.subsection}><h3><CheckCircle2 size={16} />短期 Memory</h3>{shortMemories.length ? shortMemories.map(record => <MemoryCard key={record.recordId} record={record} />) : <p className={styles.secondary}>暂无短期记录。</p>}</section>
          <section className={styles.subsection}><h3><Database size={16} />长期/历史 Memory</h3>{longMemories.length ? longMemories.map(record => <MemoryCard key={record.recordId} record={record} />) : <p className={styles.secondary}>暂无长期或历史记录。</p>}</section>
          <section className={styles.subsection}><h3>Memory 处理诊断</h3>{(view?.memoryExtractions ?? []).length ? view?.memoryExtractions?.map(item => <article key={item.jobId} className={styles.diagnostic}><div><strong>{item.extractionCompleteness}</strong><span>{item.processingStatus} / {item.commitStatus}</span></div><span>模型候选 {item.providerProposalCount ?? item.semanticInputCount} · 有效 {item.validCandidateCount ?? item.semanticAcceptedCount} · 拒绝 {item.rejectedCandidateCount ?? item.semanticRejectedCount} · 提交 {item.committedCandidateCount}</span>{item.finalSubmissionStatus && <span>最终状态：{item.finalSubmissionStatus}</span>}{item.errorCode && <span className={styles.warningText}>原因：{item.errorCode}</span>}</article>) : <p className={styles.secondary}>暂无诊断记录。</p>}</section>
        </div>}
        {tab === 'story' && <ArtifactList artifact={latestStory} empty="还没有故事草稿。完成一轮访谈后会在这里显示。" />}
        {tab === 'profile' && <ArtifactList artifact={latestProfile} empty="还没有基础画像草稿。当前只展示直接来源，不把一次表现当成性格或健康结论。" />}
        {tab === 'article' && <section className={styles.articlePreview}><div className={styles.articleLabel}><FileText size={17} /><span>最终成文预览 · 当前版本为可编辑草稿</span></div>{latestStory?.artifact.sentences?.length ? <>{latestStory.artifact.sentences.map((sentence, i) => <p key={i}>{sentence.text}</p>)}<p className={styles.articleNote}>文章保持平白、温情和接近原话的风格；每段旁边保留来源和不确定性，后续才能安全纠正，不会静默覆盖 Memory。</p></> : <p className={styles.secondary}>完成正式访谈并生成故事草稿后，这里会显示文章预览。</p>}</section>}
        {tab === 'cost' && <CostPanel table={costTable} />}
        {tab === 'review' && <form className={styles.reviewForm} onSubmit={submitReview}>
          <div className={styles.reviewIntro}><ClipboardCheck size={18} /><div><strong>一次访谈，一份结构化反馈</strong><span>算法工程师和产品、内容、康养等团队成员分别填写；不把个人意见混成模型事实。</span></div></div>
          <label>评审角色<select value={reviewRole} onChange={event => setReviewRole(event.target.value)}><option>算法工程师</option><option>产品</option><option>内容</option><option>康养专家</option><option>其他团队成员</option></select></label>
          <div className={styles.reviewGrid}>
            {[
              ['followUpValue', '追问是否有价值'], ['memoryAccuracy', 'Memory 是否准确'],
              ['draftUsability', '故事/成文是否可用'], ['waitingAcceptability', '等待和交互是否可接受'],
              ['safety', '安全与权限'],
            ].map(([key, label]) => <label key={key}>{label}
              <select value={reviewForm[key as keyof typeof reviewForm]} onChange={event => setReviewForm(prior => ({ ...prior, [key]: event.target.value }))}>
                {key === 'safety' ? <><option>通过</option><option>有风险</option><option>无法判断</option></> : <><option>待评估</option><option>好</option><option>一般</option><option>不好</option><option>无法判断</option></>}
              </select>
            </label>)}
          </div>
          <label>详细说明<textarea rows={4} value={reviewForm.note} onChange={event => setReviewForm(prior => ({ ...prior, note: event.target.value }))} placeholder="请写出具体原话、具体 Memory 或具体等待节点，避免只写总体印象。" /></label>
          <button type="submit"><ClipboardCheck size={16} />暂存这份评审</button>
          {reviewFeedback.length > 0 && <div className={styles.feedbackLog}><strong>已暂存 {reviewFeedback.length} 份评审</strong>{reviewFeedback.slice(-3).map(item => <span key={item.id}>{item.role} · 追问 {item.followUpValue} · Memory {item.memoryAccuracy}</span>)}</div>}
        </form>}
        {!view?.memory.length && !view?.artifacts.length && tab !== 'review' && <p className={styles.secondary}>暂无整理结果；先完成一轮文字或语音交流。</p>}
      </aside>
    </div>
  </main>;
}

function MemoryCard({ record, called = false }: { record: MemoryRecord; called?: boolean }) {
  return <article className={styles.result}><div className={styles.cardLine}><span className={styles.badge}>{called ? '本轮调用' : record.status === 'ACTIVE' ? '已通过规则' : '待确认'}</span><span className={styles.secondary}>{record.candidate.contentType ?? 'Memory'} · {record.candidate.temporalState ?? '未标注'} · {record.candidate.sensitivityLevel}</span></div><p>{record.candidate.normalizedClaim}</p><div className={styles.cardMeta}>保留：{record.candidate.retentionPolicy ?? '未标注'} · 用途：{(record.candidate.allowedUses ?? []).join('、') || '未列出'} · 正式权威写入：{record.candidate.canonicalWritePerformed ? '是' : '否'}</div></article>;
}

function ArtifactList({ artifact, empty }: { artifact?: Artifact; empty: string }) {
  if (!artifact) return <p className={styles.secondary}>{empty}</p>;
  return <article className={styles.artifactPreview}><div className={styles.artifactHeader}><FileText size={17} /><span>{artifact.artifact.kind ?? artifact.kind} · {artifact.artifact.schemaVersion ?? '当前版本'}</span></div>{artifact.artifact.sentences?.map((sentence, i) => <div key={i} className={styles.artifactItem}><p>{sentence.text}</p><span>来源 {sentence.evidenceRefs?.length ?? 0} 条 · {sentence.claimMode ?? '直接来源'} · {sentence.uncertainty ?? '未标注'}</span></div>)}{artifact.artifact.fields?.map((field, i) => <div key={i} className={styles.artifactItem}><p><span className={styles.fieldPath}>{field.path}</span>{field.value}</p><span>时间范围 {field.temporalScope ?? '未标注'} · 来源 {field.evidenceRefs?.length ?? 0} 条 · {field.claimMode ?? '直接来源'}</span></div>)}{artifact.artifact.images?.map((image, i) => <div key={`image-${i}`} className={styles.artifactItem}><p>{image.status === 'failed' ? `图片生成失败：${image.errorCode ?? '未提供原因'}` : image.url ? <a href={image.url} target="_blank" rel="noreferrer">打开生成图片</a> : '图片尚未生成'}</p><span>图片提示词：{image.prompt ?? '未记录'} · 来源 {image.evidenceRefs?.length ?? 0} 条</span></div>)}</article>;
}

function CostPanel({ table }: { table: CostTable | null }) {
  return <section className={styles.costPanel}>
    <div className={styles.storageNote}><Database size={17} /><div><strong>成本口径</strong><span>按调用前的 provider reservation 逐次记录，失败和重试也会计入预留上限；账单仍为待结算时，最终实际费用显示为“待结算”。</span></div></div>
    {!table ? <p className={styles.secondary}>成本表暂时无法读取，请点击“刷新结果”重试。</p> : <>
      {table.budgetAggregate && <div className={styles.costSummary}><span>当前批次预留：<strong>{table.budgetAggregate.reservedCny?.toFixed(2) ?? '—'} 元</strong></span><span>历史暴露：<strong>{table.budgetAggregate.priorExposureCny?.toFixed(2) ?? '—'} 元</strong></span><span>累计预留：<strong>{table.budgetAggregate.cumulativeReservedCny?.toFixed(2) ?? '—'} 元</strong></span><span>账单：<strong>{table.budgetAggregate.actualCostCny === null || table.budgetAggregate.actualCostCny === undefined ? '待结算' : `${table.budgetAggregate.actualCostCny.toFixed(2)} 元`}</strong></span></div>}
      <p className={styles.costNote}>{table.note}</p>
      <h3>同一 IP 的会话与轮次明细</h3>
      {table.rows.length ? <div className={styles.tableWrap}><table className={styles.costTable}><thead><tr><th>IP 脱敏指纹</th><th>会话</th><th>轮次</th><th>模块</th><th>物理调用</th><th>预留上限（元）</th><th>最终费用</th><th>状态</th></tr></thead><tbody>{table.rows.map(row => <tr key={`${row.ipFingerprint}-${row.sessionLabel}-${row.round}`}><td><code>{row.ipFingerprint}</code></td><td><code>{row.sessionLabel}</code></td><td>{row.round || '未归属'}</td><td>{row.modules.join('、')}</td><td>{row.attemptCount}</td><td>{row.reservedCny.toFixed(2)}</td><td>{row.actualCostCny === null ? '待结算' : row.actualCostCny.toFixed(2)}</td><td>{row.billingState === 'PENDING_INVOICE' ? '待结算' : '已结算'}</td></tr>)}</tbody></table></div> : <p className={styles.secondary}>当前没有按 IP 归属的 provider 调用记录。Fake 模式不会产生真实成本记录。</p>}
      <h3>按 IP 汇总</h3>
      {table.ipTotals.length ? <div className={styles.tableWrap}><table className={styles.costTable}><thead><tr><th>IP 脱敏指纹</th><th>会话数</th><th>轮次数</th><th>物理调用</th><th>预留上限（元）</th><th>最终费用</th><th>状态</th></tr></thead><tbody>{table.ipTotals.map(total => <tr key={total.ipFingerprint}><td><code>{total.ipFingerprint}</code></td><td>{total.sessionCount}</td><td>{total.roundCount}</td><td>{total.attemptCount}</td><td>{total.reservedCny.toFixed(2)}</td><td>{total.actualCostCny === null ? '待结算' : total.actualCostCny.toFixed(2)}</td><td>{total.billingState === 'PENDING_INVOICE' ? '待结算' : '已结算'}</td></tr>)}</tbody></table></div> : null}
      {table.legacyAggregate && <><h3>历史调用（旧记录未保存 IP / 会话 / 轮次）</h3><div className={styles.tableWrap}><table className={styles.costTable}><thead><tr><th>归属</th><th>物理调用</th><th>模块</th><th>预留上限（元）</th><th>实际费用</th></tr></thead><tbody>{Object.entries(table.legacyAggregate.moduleTotals).map(([module, amount]) => <tr key={module}><td>未记录</td><td>{table.legacyAggregate?.moduleCounts[module]}</td><td>{module}</td><td>{amount.toFixed(2)}</td><td>待结算</td></tr>)}<tr><td><strong>历史合计</strong></td><td>{table.legacyAggregate.reservationCount}</td><td>全部模块</td><td>{table.legacyAggregate.reservedCny.toFixed(2)}</td><td>待结算</td></tr></tbody></table></div><p className={styles.costNote}>旧记录只能作为项目总账，不能反推到具体 IP 或会话；从成本账本启用后产生的新调用才会进入上面的 IP、会话和轮次明细。</p></>}
      {table.unattributedEntryCount > 0 && <p className={styles.warningText}>有 {table.unattributedEntryCount} 条旧调用没有 IP/会话上下文，只能计入未归属成本；不会猜测归属。</p>}
    </>}
  </section>;
}
