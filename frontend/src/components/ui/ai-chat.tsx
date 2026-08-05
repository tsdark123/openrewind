import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Sparkles, Zap, Trash2, RefreshCw, Download, AlertCircle, PlayCircle } from 'lucide-react';
import { CoreSpinLoader } from './core-spin-loader';
import { cn } from '../../lib/utils';
import { classifyOrionIntent, type OrionIntent } from '../../lib/orion/router';
import { orionChat } from '../../lib/orion/client';
import { orionController } from '../../lib/orion/controller';
import {
  useOrionStartup,
  retryOrionStartup,
  pullSelectedModelWithConsent,
  installOllamaWithConsent,
  continueDeterministicOrion,
} from '../../lib/orion/startupState';
import { parseChartCommand, executeChartCommand, parseChartCommandWithLLM, type PlannerContext } from '../../lib/orion/planner';
import { commonSenseReply, suggestCommand } from '../../lib/orion/commonSense';
import {
  DEFAULT_GREETING,
  GLOBAL_THREAD_KEY,
  appendMessage,
  getThreadMessages,
  loadOrionThreads,
  setThreadMessages,
  writeOrionThreads,
  type ChatMessage,
  type OrionThreads,
} from '../../lib/orionThreads';
import { buildWorldState, renderWorldStateForPrompt } from '../../lib/orion/worldState';
import type { AppAction, AppState, PerformanceLog } from '../../types';
import type { ChartHandle } from '../Chart';

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
  apiBase: string;
  // Local Data directory for Orion candle/session calls. Managed mode omits it.
  dataDir?: string;
  availableTickers: string[];
  onSwitchSymbol: (symbol: string, date?: string) => void | Promise<void>;
  send: (payload: Record<string, unknown>) => void;
  dispatch: (action: AppAction) => void;
}

export function OrionChatSidepanel({
  className,
  performanceLog,
  lightMode = false,
  appState,
  chartRef,
  apiBase,
  dataDir,
  availableTickers,
  onSwitchSymbol,
  send,
  dispatch,
}: OrionChatSidepanelProps) {
  // Extract the fields we still read locally (thread scoping, breadcrumb).
  // Anything else flows through buildWorldState during handleSend so we
  // never re-derive scattered context from stale scalar props.
  const { symbol, replayDate } = appState;
  // Single chat thread. Threads are persisted to
  // `app_data_dir/data/orion_threads.json` via the Tauri IPC helpers.
  const [threads, setThreads] = useState<OrionThreads>({});
  const [threadsLoaded, setThreadsLoaded] = useState(false);

  const threadKey = GLOBAL_THREAD_KEY;

  const messages = useMemo<ChatMessage[]>(
    () => getThreadMessages(threads, threadKey),
    [threads]
  );

  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Authoritative-run ownership. A monotonically increasing runId and the
  // AbortController for the in-flight request. Only the latest runId may
  // append messages, clear isTyping, or update pending-controller ownership.
  const runIdRef = useRef(0);
  const latestRunIdRef = useRef(0);
  const pendingControllerRef = useRef<{ runId: number; controller: AbortController } | null>(null);

  const isAuthoritative = (runId: number) => latestRunIdRef.current === runId;

  const releasePending = (runId: number) => {
    if (pendingControllerRef.current?.runId === runId) {
      pendingControllerRef.current = null;
    }
  };

  const clearTypingIfAuthoritative = (runId: number) => {
    if (isAuthoritative(runId)) {
      setIsTyping(false);
    }
  };

  // Abort any in-flight request when the component unmounts so a page close
  // or sidepanel unmount doesn't leave a hung model call running.
  useEffect(() => {
    return () => {
      pendingControllerRef.current?.controller.abort();
      orionController.cancel();
    };
  }, []);

  // Live app-state ref for async helpers (intervals/waiters) that cannot see
  // the latest render-propped state inside closures.
  const appStateRef = useRef(appState);
  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

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

  const startup = useOrionStartup();
  // Latest classifier decision for the pending user turn — surfaced in the
  // header chip so the user can see when Orion is thinking in agent mode.
  const [lastIntent, setLastIntent] = useState<OrionIntent>('chat');

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const handleResetChat = () => {
    setThreads((prev) => setThreadMessages(prev, threadKey, [DEFAULT_GREETING]));
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Start a new authoritative run. Only this run may mutate the UI.
    const runId = ++runIdRef.current;
    latestRunIdRef.current = runId;

    // Cancel the previous in-flight model call and any agent task. The old
    // run will see it is no longer authoritative and silently clean up.
    pendingControllerRef.current?.controller.abort();
    orionController.cancel();

    const controller = new AbortController();
    pendingControllerRef.current = { runId, controller };

    const userMessage: ChatMessage = { sender: 'user', text: trimmed };
    const nextMessages = [...messages, userMessage];
    setThreads((prev) => setThreadMessages(prev, threadKey, nextMessages));
    setInput('');
    setIsTyping(true);

    // Helpers that enforce that only the authoritative run touches UI state.
    const ownedAppend = (text: string) => {
      if (isAuthoritative(runId)) {
        setThreads((prev) => appendMessage(prev, threadKey, { sender: 'ai', text }));
      }
    };

    const ownedAppendError = (text: string) => {
      ownedAppend(text);
    };

    const cleanup = (clearSpinner = true) => {
      releasePending(runId);
      if (clearSpinner) {
        clearTypingIfAuthoritative(runId);
      }
    };

    // If the run is no longer authoritative (a newer message superseded it)
    // or the request was already aborted, stop before doing any work.
    const guardContinue = () => isAuthoritative(runId) && !controller.signal.aborted;

    // Chart-control planner: extracts entities (symbol/date/times/speed/
    // direction) from the message, looks at the live chart state, and runs the
    // minimum engine commands to fulfill the request. Works offline.
    let cmd = parseChartCommand(trimmed, availableTickers, undefined, appState.replayDate);
    console.log('[orion-trace] parsed command:', JSON.parse(JSON.stringify(cmd)));

    // Let the local LLM make sense of typos / filler when the offline parser
    // is unsure and Orion is online.
    if (cmd.intent === 'unknown' && startup.stage === 'ready') {
      try {
        const world = buildWorldState(appState, chartRef, performanceLog);
        const smart = await parseChartCommandWithLLM(trimmed, availableTickers, world, controller.signal);
        if (smart && smart.intent !== 'unknown') {
          cmd = smart;
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ABORTED') {
          cleanup();
          return;
        }
        console.warn('[Orion] LLM chart parse failed:', err);
      }
    }

    if (!guardContinue()) {
      cleanup();
      return;
    }

    if (cmd.intent !== 'unknown') {
      if (availableTickers.length === 0) {
        ownedAppendError("The OpenRewind chart engine is not connected, so I can't control the chart right now.");
        cleanup();
        return;
      }

      const plannerCtx: PlannerContext = {
        appState,
        getState: () => appStateRef.current,
        chartRef,
        performanceLog,
        apiBase,
        dataDir,
        availableTickers,
        send,
        dispatch,
        onSwitchSymbol,
        onMessage: ownedAppend,
      };
      try {
        const result = await executeChartCommand(cmd, plannerCtx);
        console.log('[orion-trace] executeChartCommand result:', result);
        ownedAppend(result.message);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code;
        if (code !== 'ABORTED') {
          ownedAppendError(`Orion couldn't run that: ${detail}`);
        }
      } finally {
        cleanup();
      }
      return;
    }

    if (startup.stage !== 'ready') {
      const common = commonSenseReply(trimmed, false);
      if (common) {
        ownedAppend(common);
      } else {
        const suggestion = suggestCommand(trimmed);
        const text = suggestion
          ? `"${trimmed}" is not recognized as a request. Did you mean "${suggestion}"?`
          : `"${trimmed}" is not recognized as a request. Try 'help' to see available commands.`;
        ownedAppendError(text);
      }
      cleanup();
      return;
    }

    // Route the turn. The agent tool-calling brain is used when the user
    // asks Orion to perform a task; otherwise chat. The model is the same
    // certified model in both cases, so there is no separate agent download.
    const decision = classifyOrionIntent(trimmed);
    if (isAuthoritative(runId)) {
      setLastIntent(decision.intent);
    }

    const wantsAgent = decision.intent === 'agent';
    const effectiveTier: 'chat' | 'agent' = decision.intent;
    let modeNotice: string | null = null;

    // If the user wants action, hand the turn to the automation driver.
    // The controller posts its own replies to the active thread, so we just
    // need to refresh the UI after it finishes.
    if (wantsAgent && startup.stage === 'ready') {
      // Give a cancelled previous task a moment to clean up; then run.
      let result: Awaited<ReturnType<typeof orionController.runAgentTask>> | null = null;
      for (let wait = 0; wait <= 300; wait += 50) {
        if (!guardContinue()) {
          cleanup();
          return;
        }
        if (orionController.status === 'idle') {
          result = await orionController.runAgentTask(trimmed);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!result) {
        if (isAuthoritative(runId)) {
          ownedAppendError('Orion is still finishing the previous task. Press Esc to cancel it first.');
        }
        cleanup();
        return;
      }
      try {
        if (isAuthoritative(runId)) {
          if (!result.ok) {
            if (result.reason !== 'cancelled') {
              ownedAppendError(`Orion task could not start: ${result.reason ?? 'unknown'}.`);
            }
          } else {
            const latest = await loadOrionThreads();
            if (isAuthoritative(runId)) {
              setThreads(latest);
            }
          }
        }
      } catch (err) {
        if (isAuthoritative(runId)) {
          const detail = err instanceof Error ? err.message : String(err);
          ownedAppendError(`Orion task failed: ${detail}`);
        }
      } finally {
        cleanup();
      }
      return;
    }

    try {
      // Build the canonical world snapshot at send-time so the prompt cannot
      // reference stale state from a previous render (e.g. mid-symbol switch).
      const world = buildWorldState(appState, chartRef, performanceLog);
      const telemetry = renderWorldStateForPrompt(world);
      const threadScope = threadKey === GLOBAL_THREAD_KEY
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
        signal: controller.signal,
      });

      // First successful agent-tier call confirms the model is present.
      // The startup state already verified this, so no local state is needed.

      const reply = response.content || 'No response content.';
      const finalText = modeNotice ? `${modeNotice}\n\n${reply}` : reply;
      ownedAppend(finalText);
    } catch (err) {
      if (isAuthoritative(runId)) {
        const code = (err as { code?: string })?.code;
        const detail = err instanceof Error ? err.message : String(err);
        let text: string;
        if (code === 'MODEL_MISSING') {
          text = `Orion needs the ${startup.activeModelName} model pulled locally. Pull it via Ollama and retry.`;
        } else if (code === 'TIMEOUT') {
          text = 'The local model did not respond in time. Please try again.';
        } else if (code === 'ABORTED') {
          text = ''; // Superseded runs are silent.
        } else {
          text = `Orion is offline — start Ollama locally and ensure the model is pulled. (${detail})`;
        }
        if (text) {
          setThreads((prev) => appendMessage(prev, threadKey, { sender: 'ai', text }));
        }
      }
    } finally {
      cleanup();
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
        <Sparkles className={cn('h-4 w-4 text-[#3b6fff]')} />
        <span className={cn('text-sm font-semibold', lightMode ? 'text-gray-900' : 'text-[#d1d4dc]')}>
          Orion
        </span>

        {/* Reset chat history */}
        <button
          type="button"
          onClick={handleResetChat}
          title="Reset chat"
          className={cn(
            'ml-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
            lightMode
              ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              : 'bg-[#1e222d] text-[#d1d4dc] hover:bg-[#2a2e39]'
          )}
        >
          <Trash2 className="h-3 w-3" />
          Reset
        </button>

        {/* Active model / status chip */}
        {lastIntent === 'agent' && startup.stage === 'ready' && (
          <span className="ml-auto flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-[#3b6fff]/15 text-[#3b6fff]">
            <Zap className="h-3 w-3" />
            agent
          </span>
        )}
        <span
          className={cn(
            'text-[10px] font-medium',
            lastIntent === 'agent' ? 'ml-2' : 'ml-auto',
            lightMode ? 'text-gray-500' : 'text-[#787b86]'
          )}
        >
          {startup.stage === 'ready'
            ? (isTyping ? 'thinking…' : 'online')
            : startup.stage === 'checking_runtime' ||
                startup.stage === 'checking_model' ||
                startup.stage === 'pulling_model' ||
                startup.stage === 'warming_model'
              ? startup.status || 'warming…'
              : startup.stage === 'deterministic_only'
                ? 'deterministic'
                : 'offline'} · {startup.activeModelName}
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
                  ? 'ml-auto bg-[#3b6fff] text-white'
                  : lightMode
                    ? 'mr-auto bg-gray-100 text-gray-900'
                    : 'mr-auto bg-[#2a2e39] text-[#d1d4dc]'
              )}
            >
              {msg.text}
            </motion.div>
          ))}
        </div>

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
          placeholder="Ask Orion or say 'switch to NFLX'…"
          disabled={isTyping}
          className={cn(
            'flex-1 rounded border px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:ring-1 focus:ring-[#3b6fff]',
            lightMode
              ? 'border-gray-300 bg-white text-gray-900 placeholder:text-gray-400'
              : 'border-[#363a45] bg-[#1e222d] text-[#d1d4dc] placeholder:text-[#787b86]'
          )}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || isTyping || startup.stage !== 'ready'}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded transition-colors',
            input.trim() && !isTyping
              ? 'bg-[#3b6fff] text-white hover:bg-[#3b6fff]/90'
              : lightMode
                ? 'bg-gray-200 text-gray-400'
                : 'bg-[#2a2e39] text-[#787b86]'
          )}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      <AnimatePresence>
        {startup.stage !== 'ready' && startup.stage !== 'deterministic_only' && (
          <motion.div
            key="boot"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: 'easeInOut' }}
            className={cn(
              'absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 p-6',
              lightMode ? 'bg-white/95' : 'bg-[#121416]/95'
            )}
          >
            {startup.stage === 'runtime_missing' ||
            startup.stage === 'model_missing' ||
            startup.stage === 'warmup_failed' ||
            startup.stage === 'download_failed' ? (
              <div className="flex flex-col items-center gap-3 max-w-[90%] text-center">
                <AlertCircle className="h-6 w-6 text-[#3b6fff]" />
                <div className={cn('text-xs font-mono uppercase tracking-widest', lightMode ? 'text-gray-900' : 'text-[#d1d4dc]')}>
                  {startup.stage === 'runtime_missing' ? 'Ollama runtime missing' : `${startup.activeModelName} not ready`}
                </div>
                <div className={cn('text-[10px] font-mono leading-relaxed max-w-[260px]', lightMode ? 'text-gray-600' : 'text-[#787b86]')}>
                  {startup.error || startup.status || 'Orion could not start.'}
                </div>
                {startup.stage === 'model_missing' && startup.canPull && (
                  <div className="text-[10px] font-mono leading-relaxed max-w-[260px] text-[#3b6fff]">
                    This is a large local download (~5.6 GB for qwen3:8b).
                  </div>
                )}
                {startup.stage === 'runtime_missing' && startup.canInstallOllama && (
                  <div className="text-[10px] font-mono leading-relaxed max-w-[260px] text-[#3b6fff]">
                    Ollama is a large local download and install.
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
                  {startup.canRetry && (
                    <button
                      type="button"
                      onClick={() => retryOrionStartup()}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        lightMode
                          ? 'border-gray-300 text-gray-700 hover:bg-gray-100'
                          : 'border-[#2a2e39] text-[#d1d4dc] hover:bg-[#1a1a1a]'
                      )}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry
                    </button>
                  )}
                  {startup.canPull && (
                    <button
                      type="button"
                      onClick={() => pullSelectedModelWithConsent()}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        lightMode
                          ? 'border-[#3b6fff] text-[#3b6fff] hover:bg-[#3b6fff]/10'
                          : 'border-[#3b6fff] text-[#3b6fff] hover:bg-[#3b6fff]/10'
                      )}
                    >
                      <Download className="h-3 w-3" />
                      Pull {startup.activeModelName}
                    </button>
                  )}
                  {startup.canInstallOllama && (
                    <button
                      type="button"
                      onClick={() => installOllamaWithConsent()}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        lightMode
                          ? 'border-[#3b6fff] text-[#3b6fff] hover:bg-[#3b6fff]/10'
                          : 'border-[#3b6fff] text-[#3b6fff] hover:bg-[#3b6fff]/10'
                      )}
                    >
                      <Download className="h-3 w-3" />
                      Install Ollama
                    </button>
                  )}
                  {startup.canContinueDeterministic && (
                    <button
                      type="button"
                      onClick={() => continueDeterministicOrion()}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        lightMode
                          ? 'border-gray-300 text-gray-700 hover:bg-gray-100'
                          : 'border-[#2a2e39] text-[#d1d4dc] hover:bg-[#1a1a1a]'
                      )}
                    >
                      <PlayCircle className="h-3 w-3" />
                      Continue without
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <CoreSpinLoader />
                <div className={cn('text-[10px] font-mono text-center max-w-[260px]', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>
                  {startup.status || 'Starting Orion...'}
                </div>
                {startup.progress >= 0 && (
                  <div className={cn('text-[10px] font-mono', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>
                    {startup.progress}%
                  </div>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}
