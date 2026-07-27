import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Sparkles, ChevronDown, Zap } from 'lucide-react';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { cn } from '../../lib/utils';
import { classifyOrionIntent, type OrionIntent } from '../../lib/orion/router';
import { ORION_AGENT_MODEL, orionChat, pullOrionModel } from '../../lib/orion/client';
import { orionController } from '../../lib/orion/controller';
import {
  GLOBAL_THREAD_KEY,
  appendMessage,
  getThreadMessages,
  loadOrionThreads,
  setThreadMessages,
  threadKeyForContext,
  threadLabel,
  writeOrionThreads,
  type ChatMessage,
  type OrionThreads,
} from '../../lib/orionThreads';
import { buildWorldState, renderWorldStateForPrompt } from '../../lib/orion/worldState';
import type { AppState, PerformanceLog } from '../../types';
import type { ChartHandle } from '../Chart';

const ORION_MODEL = 'llama3.2';

interface OrionChatSidepanelProps {
  className?: string;
  performanceLog: PerformanceLog;
  lightMode?: boolean;
  // Full canonical app state + chart handle so Orion always reasons off the
  // same world snapshot the rest of the UI is rendering. Individual scalars
  // used to be threaded in one-by-one; that path drifted easily during
  // symbol switches, which was the root of the cross-symbol answer bug.
  appState: AppState;
  chartRef: { current: ChartHandle | null } | null;
}

const ORION_STATUS_MESSAGES = [
  'Installing Orion on your system…',
  'Calibrating your risk model…',
  'Loading your trading telemetry…',
  'Preparing your private AI coach…',
  'Syncing with your replay session…',
];

function CyclingOrionStatus() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % ORION_STATUS_MESSAGES.length);
    }, 3000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="h-5 overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.span
          key={index}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.35 }}
          className="block text-[13px] font-medium leading-tight"
        >
          {ORION_STATUS_MESSAGES[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export function OrionChatSidepanel({
  className,
  performanceLog,
  lightMode = false,
  appState,
  chartRef,
}: OrionChatSidepanelProps) {
  // Extract the fields we still read locally (thread scoping, breadcrumb).
  // Anything else flows through buildWorldState during handleSend so we
  // never re-derive scattered context from stale scalar props.
  const { symbol, replayDate, sessionActive } = appState;
  // Threaded chat state: one message list per (symbol, date) plus a `global`
  // thread for cross-symbol questions. `pinnedGlobal` lets the user override
  // the auto-selected session thread and stay on the global thread while
  // switching symbols. Threads are persisted to
  // `app_data_dir/data/orion_threads.json` via the Tauri IPC helpers.
  const [threads, setThreads] = useState<OrionThreads>({});
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [pinnedGlobal, setPinnedGlobal] = useState(false);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);

  const sessionThreadKey = threadKeyForContext(symbol, replayDate, sessionActive);
  const activeThreadKey = pinnedGlobal || sessionThreadKey === GLOBAL_THREAD_KEY
    ? GLOBAL_THREAD_KEY
    : sessionThreadKey;

  const messages = useMemo<ChatMessage[]>(
    () => getThreadMessages(threads, activeThreadKey),
    [threads, activeThreadKey]
  );

  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load persisted threads once on mount. Subsequent writes are debounced
  // through `writeOrionThreads` fire-and-forget on every state change.
  useEffect(() => {
    let cancelled = false;
    loadOrionThreads().then((loaded) => {
      if (cancelled) return;
      setThreads(loaded);
      setThreadsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist whenever threads mutate, but only after the initial load has
  // completed so we don't clobber the disk copy with an empty object.
  useEffect(() => {
    if (!threadsLoaded) return;
    void writeOrionThreads(threads);
  }, [threads, threadsLoaded]);

  // Agent-tier bootstrap state. `unknown` at boot; flips to `ready` on
  // first successful use, `pulling` while `pullOrionModel` streams progress,
  // or `missing` if the local Ollama install cannot fetch it (offline).
  const [agentModelStatus, setAgentModelStatus] = useState<'unknown' | 'ready' | 'pulling' | 'missing'>('unknown');
  const [agentPullPercent, setAgentPullPercent] = useState(0);
  // Latest classifier decision for the pending user turn — surfaced in the
  // header chip so the user can see when Orion is thinking in agent mode.
  const [lastIntent, setLastIntent] = useState<OrionIntent>('chat');

  const [setupStage, setSetupStage] = useState<'checking-ollama' | 'ollama-missing' | 'downloading-ollama' | 'starting-ollama' | 'checking-model' | 'pulling-model' | 'ready' | 'error'>('checking-ollama');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [pullProgress, setPullProgress] = useState(0);
  const [errorText, setErrorText] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const isTauri = typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

  // Full Orion boot pipeline: start/download Ollama, then pull the Orion model.
  useEffect(() => {
    let cancelled = false;

    const tauriInvoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      const win = window as any;
      const tauri = win.__TAURI__?.core ?? win.__TAURI_INTERNALS__;
      if (!tauri?.invoke) throw new Error('Tauri runtime not available');
      return tauri.invoke(cmd, args);
    };

    const tauriListen = async <T extends unknown>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> => {
      const win = window as any;
      const eventApi = win.__TAURI__?.event;
      if (!eventApi?.listen) throw new Error('Tauri event API not available');
      return eventApi.listen(event, handler);
    };

    const pullModel = async () => {
      setSetupStage('pulling-model');
      setPullProgress(0);
      try {
        const response = await tauriFetch('http://localhost:11434/api/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ORION_MODEL, stream: true }),
        });
        if (cancelled) return;

        if (!response.ok || !response.body) {
          throw new Error(`Pull failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          if (cancelled) return;
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const update: { status?: string; completed?: number; total?: number } = JSON.parse(line);
              if (typeof update.completed === 'number' && typeof update.total === 'number' && update.total > 0) {
                setPullProgress(Math.min(100, Math.round((update.completed / update.total) * 100)));
              }
              if (update.status?.toLowerCase().includes('success')) {
                setSetupStage('ready');
                return;
              }
            } catch {
              // ignore malformed NDJSON lines
            }
          }
        }

        if (!cancelled) setSetupStage('ready');
      } catch (err) {
        if (cancelled) return;
        setErrorText(err instanceof Error ? err.message : String(err));
        setSetupStage('error');
      }
    };

    const checkModel = async () => {
      setSetupStage('checking-model');
      setErrorText('');
      try {
        const response = await tauriFetch('http://localhost:11434/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: ORION_MODEL }),
        });
        if (cancelled) return;

        if (response.ok) {
          setSetupStage('ready');
          return;
        }

        await pullModel();
      } catch (err) {
        if (cancelled) return;
        setErrorText(err instanceof Error ? err.message : String(err));
        setSetupStage('error');
      }
    };

    const downloadOllama = async () => {
      setSetupStage('downloading-ollama');
      setDownloadProgress(0);
      let unlisten: (() => void) | undefined;
      try {
        unlisten = await tauriListen<{ stage: string; percent: number; message: string }>(
          'ollama-download-progress',
          (event) => {
            if (cancelled) return;
            const p = event.payload;
            if (p.stage === 'downloading' || p.stage === 'extracting') {
              setDownloadProgress(p.percent);
            } else if (p.stage === 'complete') {
              setDownloadProgress(100);
            }
          }
        );
        await tauriInvoke('download_ollama');
        if (cancelled) return;
      } finally {
        if (unlisten) unlisten();
      }
    };

    const setupOrion = async () => {
      setSetupStage('checking-ollama');
      setErrorText('');
      try {
        const status = (await tauriInvoke('ensure_ollama_running')) as string;
        if (cancelled) return;

        if (status === 'RUNNING' || status === 'STARTED') {
          setSetupStage('checking-model');
          await checkModel();
          return;
        }

        if (status === 'OLLAMA_MISSING') {
          await downloadOllama();
          if (cancelled) return;

          setSetupStage('starting-ollama');
          const status2 = (await tauriInvoke('ensure_ollama_running')) as string;
          if (cancelled) return;

          if (status2 === 'RUNNING' || status2 === 'STARTED') {
            setSetupStage('checking-model');
            await checkModel();
            return;
          }
          throw new Error('Ollama did not start after download');
        }

        throw new Error(`Unexpected Ollama status: ${status}`);
      } catch (err) {
        if (cancelled) return;
        setErrorText(err instanceof Error ? err.message : String(err));
        setSetupStage('error');
      }
    };

    if (isTauri) {
      setupOrion();
    } else {
      checkModel();
    }

    return () => {
      cancelled = true;
    };
  }, [isTauri, retryCount]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isTyping || setupStage !== 'ready') return;

    const userMessage: ChatMessage = { sender: 'user', text: trimmed };
    const nextMessages = [...messages, userMessage];
    // Capture the key at send-time so a mid-flight symbol switch cannot
    // redirect the assistant's reply into the wrong thread.
    const targetThreadKey = activeThreadKey;
    setThreads((prev) => setThreadMessages(prev, targetThreadKey, nextMessages));
    setInput('');
    setIsTyping(true);

    // Route the turn through the two-tier model: a chat message stays on
    // llama3.2 (snappy); a task-flavored message ("go to AAPL and run…")
    // gets the llama3.1:8b tool-calling brain. See `router.ts` for the
    // rulebook.
    const decision = classifyOrionIntent(trimmed);
    setLastIntent(decision.intent);

    const wantsAgent = decision.intent === 'agent';
    let effectiveTier: 'chat' | 'agent' = decision.intent;
    let modeNotice: string | null = null;

    // Agent-tier bootstrap. Lazy pull so the 8B model never downloads on
    // app boot — only when the user first asks Orion to actually do
    // something. During the pull we fall back to the chat model for THIS
    // turn so the conversation stays alive.
    if (wantsAgent && agentModelStatus !== 'ready') {
      if (agentModelStatus === 'unknown' || agentModelStatus === 'missing') {
        setAgentModelStatus('pulling');
        setAgentPullPercent(0);
        // Kick off the pull in the background; do NOT await here so the
        // current turn responds quickly on the chat model.
        void (async () => {
          try {
            await pullOrionModel(ORION_AGENT_MODEL, (pct) => {
              if (pct >= 0) setAgentPullPercent(pct);
            });
            setAgentModelStatus('ready');
          } catch (e) {
            console.warn('[Orion] Agent model pull failed:', e);
            setAgentModelStatus('missing');
          }
        })();
      }
      effectiveTier = 'chat';
      modeNotice = 'Warming up agent brain in the background… responding with the chat model for now.';
    }

    // If the agent brain is ready and the user wants action, hand the turn
    // to the automation driver. The controller posts its own replies to the
    // active thread, so we just need to refresh the UI after it finishes.
    if (wantsAgent && agentModelStatus === 'ready') {
      if (orionController.status !== 'idle') {
        setThreads((prev) =>
          appendMessage(prev, targetThreadKey, { sender: 'ai', text: 'Orion is already running a task. Press Esc to cancel it first.' })
        );
        setIsTyping(false);
        return;
      }
      try {
        const result = await orionController.runAgentTask(trimmed);
        if (!result.ok) {
          setThreads((prev) =>
            appendMessage(prev, targetThreadKey, {
              sender: 'ai',
              text: `Orion task could not start: ${result.reason ?? 'unknown'}.`,
            })
          );
        } else {
          const latest = await loadOrionThreads();
          setThreads(latest);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setThreads((prev) => appendMessage(prev, targetThreadKey, { sender: 'ai', text: `Orion task failed: ${detail}` }));
      } finally {
        setIsTyping(false);
      }
      return;
    }

    try {
      // Build the canonical world snapshot at send-time so the prompt cannot
      // reference stale state from a previous render (e.g. mid-symbol switch).
      const world = buildWorldState(appState, chartRef, performanceLog);
      const telemetry = renderWorldStateForPrompt(world);
      const threadScope = targetThreadKey === GLOBAL_THREAD_KEY
        ? 'This is the GLOBAL thread — the user may ask about any symbol/date; answer using the JOURNAL section, not the current SESSION.'
        : `This thread is scoped to ${symbol || 'the current symbol'}${replayDate ? ' on ' + replayDate : ''}. Anchor your answers to that session; do not confuse it with prior symbols.`;

      const agentSystemAddendum = effectiveTier === 'agent'
        ? [
            '',
            'AGENT MODE',
            'You are in agent mode. In a future turn you will be able to call tools that navigate the chart and execute trades. For now, if the user asks you to do something you cannot yet perform, briefly acknowledge the task, describe the plan you would run, and note that autonomous execution is arriving in the next update.',
          ].join('\n')
        : '';

      const systemPrompt = [
        'You are Orion, an observant, offline AI trading coach embedded in OpenRewind. You watch the user\'s replay unfold in real time.',
        threadScope,
        'Use the WORLD STATE below to answer accurately about what is happening right now and what the user has done.',
        'When the user asks about a specific trade, only cite records whose symbol matches the question. Never label a trade with a symbol you cannot verify from the snapshot.',
        'Be concise: 2-4 short sentences unless the user asks for detail. Use plain English only. Never use markdown, LaTeX, code blocks, bullet points, or asterisks.',
        'Do not provide regulated investment advice; focus on execution quality, risk management, and what the user just did on the chart.',
        '',
        'WORLD STATE',
        '-----------',
        telemetry,
        agentSystemAddendum,
      ].join('\n');

      const history = nextMessages.map((m) => ({
        role: m.sender === 'ai' ? ('assistant' as const) : ('user' as const),
        content: m.text,
      }));

      const response = await orionChat({
        tier: effectiveTier,
        messages: [{ role: 'system', content: systemPrompt }, ...history],
      });

      // First successful agent-tier call confirms the model is present.
      if (effectiveTier === 'agent' && agentModelStatus !== 'ready') {
        setAgentModelStatus('ready');
      }

      const reply = response.content || 'No response content.';
      const finalText = modeNotice ? `${modeNotice}\n\n${reply}` : reply;
      setThreads((prev) => appendMessage(prev, targetThreadKey, { sender: 'ai', text: finalText }));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const detail = err instanceof Error ? err.message : String(err);
      const message = code === 'MODEL_MISSING'
        ? `Orion needs the ${effectiveTier === 'agent' ? ORION_AGENT_MODEL : 'chat'} model pulled locally. Pull it via Ollama and retry.`
        : `Orion is offline — start Ollama locally and ensure the model is pulled. (${detail})`;
      setThreads((prev) => appendMessage(prev, targetThreadKey, { sender: 'ai', text: message }));
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <motion.aside
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className={cn(
        'flex w-80 flex-shrink-0 flex-col border-l',
        lightMode ? 'bg-white border-gray-200' : 'bg-[#121416] border-[#2a2e39]',
        className
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center gap-2 border-b px-3 py-2.5',
          lightMode ? 'border-gray-200' : 'border-[#2a2e39]'
        )}
      >
        <Sparkles className={cn('h-4 w-4 text-[#ff3700]')} />
        <span className={cn('text-sm font-semibold', lightMode ? 'text-gray-900' : 'text-[#d1d4dc]')}>
          Orion
        </span>

        {/* Thread breadcrumb — shows the currently-active memory scope and
            lets the user pin to the Global thread while a session is live.
            The session thread option only appears when a symbol+date session
            is active; otherwise Global is the only choice. */}
        <div className="relative ml-2">
          <button
            type="button"
            onClick={() => setThreadMenuOpen((v) => !v)}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              lightMode
                ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                : 'bg-[#1e222d] text-[#d1d4dc] hover:bg-[#2a2e39]'
            )}
            title="Switch Orion memory scope"
          >
            <span className="truncate max-w-[110px]">{threadLabel(activeThreadKey)}</span>
            <ChevronDown className="h-3 w-3 flex-shrink-0" />
          </button>
          {threadMenuOpen && (
            <div
              className={cn(
                'absolute left-0 top-full z-50 mt-1 w-40 rounded border py-1 text-[11px] shadow-lg',
                lightMode ? 'border-gray-200 bg-white' : 'border-[#2a2e39] bg-[#1e222d]'
              )}
            >
              {sessionThreadKey !== GLOBAL_THREAD_KEY && (
                <button
                  type="button"
                  onClick={() => {
                    setPinnedGlobal(false);
                    setThreadMenuOpen(false);
                  }}
                  className={cn(
                    'block w-full px-3 py-1.5 text-left transition-colors',
                    !pinnedGlobal
                      ? 'text-[#ff3700]'
                      : lightMode
                        ? 'text-gray-700 hover:bg-gray-100'
                        : 'text-[#d1d4dc] hover:bg-[#2a2e39]'
                  )}
                >
                  {threadLabel(sessionThreadKey)}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setPinnedGlobal(true);
                  setThreadMenuOpen(false);
                }}
                className={cn(
                  'block w-full px-3 py-1.5 text-left transition-colors',
                  pinnedGlobal || sessionThreadKey === GLOBAL_THREAD_KEY
                    ? 'text-[#ff3700]'
                    : lightMode
                      ? 'text-gray-700 hover:bg-gray-100'
                      : 'text-[#d1d4dc] hover:bg-[#2a2e39]'
                )}
              >
                Global
              </button>
            </div>
          )}
        </div>

        {/* Agent-mode chip. Visible when the last routed turn was agent-tier
            OR the 8B brain is warming/ready, so the user can see when Orion
            is thinking with the heavier tool-calling model. */}
        {(lastIntent === 'agent' || agentModelStatus === 'pulling' || agentModelStatus === 'ready') && (
          <span
            className={cn(
              'ml-auto flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              agentModelStatus === 'ready'
                ? 'bg-[#ff3700]/15 text-[#ff3700]'
                : lightMode
                  ? 'bg-gray-100 text-gray-600'
                  : 'bg-[#2a2e39] text-[#787b86]'
            )}
            title={
              agentModelStatus === 'ready'
                ? `Agent brain (${ORION_AGENT_MODEL}) warm — advanced task planning enabled`
                : agentModelStatus === 'pulling'
                  ? `Downloading agent brain (${ORION_AGENT_MODEL}) — ${agentPullPercent}%`
                  : `Agent brain (${ORION_AGENT_MODEL}) not yet loaded`
            }
          >
            <Zap className="h-3 w-3" />
            {agentModelStatus === 'pulling'
              ? `agent ${agentPullPercent}%`
              : agentModelStatus === 'ready'
                ? 'agent'
                : 'agent…'}
          </span>
        )}
        <span
          className={cn(
            'text-[10px] font-medium',
            lastIntent === 'agent' || agentModelStatus === 'pulling' || agentModelStatus === 'ready'
              ? 'ml-2'
              : 'ml-auto',
            lightMode ? 'text-gray-500' : 'text-[#787b86]'
          )}
        >
          {setupStage === 'ready' ? (isTyping ? 'thinking…' : 'online') : 'offline'}
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className={cn(
                'max-w-[90%] rounded-lg px-3 py-2 text-[13px] leading-relaxed',
                msg.sender === 'user'
                  ? 'ml-auto bg-[#ff3700] text-white'
                  : lightMode
                    ? 'mr-auto bg-gray-100 text-gray-900'
                    : 'mr-auto bg-[#2a2e39] text-[#d1d4dc]'
              )}
            >
              {msg.text}
            </motion.div>
          ))}
        </div>

        {/* Setup overlay */}
        {setupStage !== 'ready' && (
          <div
            className={cn(
              'absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center',
              lightMode ? 'bg-white/95 text-gray-900' : 'bg-[#121416]/95 text-[#d1d4dc]'
            )}
          >
            <Sparkles className={cn('h-6 w-6', setupStage === 'error' ? 'text-[#ef5350]' : 'text-[#ff3700]')} />
            {setupStage === 'error' ? (
              <div className="text-[13px] font-medium leading-tight">
                {errorText || 'Orion cannot reach the local Ollama service.'}
              </div>
            ) : setupStage === 'downloading-ollama' || setupStage === 'starting-ollama' || setupStage === 'pulling-model' ? (
              <CyclingOrionStatus />
            ) : (
              <div className="text-[13px] font-medium leading-tight">
                Initializing Orion…
              </div>
            )}
            {(setupStage === 'downloading-ollama' || setupStage === 'starting-ollama' || setupStage === 'pulling-model') && (
              <div className="w-full max-w-[200px]">
                <div className={cn('h-1.5 w-full rounded-full', lightMode ? 'bg-gray-200' : 'bg-[#2a2e39]')}>
                  <div
                    className="h-full rounded-full bg-[#ff3700] transition-all duration-200"
                    style={{ width: `${setupStage === 'pulling-model' ? pullProgress : downloadProgress}%` }}
                  />
                </div>
                <div className={cn('mt-1 text-[10px] tabular-nums', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>
                  {setupStage === 'pulling-model' ? pullProgress : downloadProgress}%
                </div>
              </div>
            )}
            {setupStage === 'error' && (
              <button
                type="button"
                onClick={() => setRetryCount((c) => c + 1)}
                className="rounded bg-[#2962ff] px-3 py-1.5 text-[11px] font-medium text-white hover:bg-[#2962ff]/90"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {isTyping && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                'mr-auto w-fit rounded-lg px-3 py-2 text-[13px]',
                lightMode ? 'bg-gray-100 text-gray-900' : 'bg-[#2a2e39] text-[#d1d4dc]'
              )}
            >
              <span className="inline-flex gap-1">
                <span className="animate-bounce">.</span>
                <span className="animate-bounce [animation-delay:0.1s]">.</span>
                <span className="animate-bounce [animation-delay:0.2s]">.</span>
              </span>
            </motion.div>
          )}
      </div>

      {/* Input */}
      <div
        className={cn(
          'flex items-center gap-2 border-t px-3 py-2.5',
          lightMode ? 'border-gray-200 bg-white' : 'border-[#2a2e39] bg-[#121416]'
        )}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            setupStage === 'ready'
              ? 'Ask Orion about your trades…'
              : 'Initializing Orion…'
          }
          disabled={isTyping || setupStage !== 'ready'}
          className={cn(
            'flex-1 rounded border px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:ring-1 focus:ring-[#ff3700]',
            lightMode
              ? 'border-gray-300 bg-white text-gray-900 placeholder:text-gray-400'
              : 'border-[#363a45] bg-[#1e222d] text-[#d1d4dc] placeholder:text-[#787b86]'
          )}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || isTyping || setupStage !== 'ready'}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded transition-colors',
            input.trim() && !isTyping
              ? 'bg-[#ff3700] text-white hover:bg-[#ff3700]/90'
              : lightMode
                ? 'bg-gray-200 text-gray-400'
                : 'bg-[#2a2e39] text-[#787b86]'
          )}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </motion.aside>
  );
}
