import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Send, Sparkles } from 'lucide-react';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { cn } from '../../lib/utils';
import { generateOrionContextPrompt, type LiveContext } from '../../lib/orionParser';
import type { ActiveSessionTrade, ClosedTrade, PerformanceLog, Position } from '../../types';

const ORION_MODEL = 'llama3.2';

interface OrionChatSidepanelProps {
  className?: string;
  performanceLog: PerformanceLog;
  lightMode?: boolean;
  symbol: string;
  replayDate: string;
  sessionActive: boolean;
  currentPrice: number;
  balance: number;
  equity: number;
  openPositions: Position[];
  activeSessionTrades: ActiveSessionTrade[];
  tradeHistory: ClosedTrade[];
}

interface ChatMessage {
  sender: 'ai' | 'user';
  text: string;
}

export function OrionChatSidepanel({
  className,
  performanceLog,
  lightMode = false,
  symbol,
  replayDate,
  sessionActive,
  currentPrice,
  balance,
  equity,
  openPositions,
  activeSessionTrades,
  tradeHistory,
}: OrionChatSidepanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      sender: 'ai',
      text: 'Systems online. I am Orion, your private risk supervisor. Ask me anything about your execution footprint.',
    },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [setupStage, setSetupStage] = useState<'checking-ollama' | 'ollama-missing' | 'downloading-ollama' | 'starting-ollama' | 'checking-model' | 'pulling-model' | 'ready' | 'error'>('checking-ollama');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadMessage, setDownloadMessage] = useState('');
  const [pullStatus, setPullStatus] = useState('');
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
      setPullStatus('Initializing Orion\'s analytical weights... Please wait.');
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
              if (update.status) setPullStatus(update.status);
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
      setDownloadMessage('Initializing core AI infrastructure onto your machine... please wait.');
      setDownloadProgress(0);
      let unlisten: (() => void) | undefined;
      try {
        unlisten = await tauriListen<{ stage: string; percent: number; message: string }>(
          'ollama-download-progress',
          (event) => {
            if (cancelled) return;
            const p = event.payload;
            if (p.stage === 'downloading' || p.stage === 'extracting') {
              setDownloadMessage(p.message);
              setDownloadProgress(p.percent);
            } else if (p.stage === 'complete') {
              setDownloadProgress(100);
              setDownloadMessage(p.message);
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
    setMessages(nextMessages);
    setInput('');
    setIsTyping(true);

    try {
      const liveContext: LiveContext = {
        symbol,
        replayDate,
        sessionActive,
        currentPrice,
        balance,
        equity,
        openPositions,
        activeSessionTrades,
        tradeHistory,
      };
      const telemetry = generateOrionContextPrompt(performanceLog, liveContext);
      const systemPrompt = [
        'You are Orion, an observant, offline AI trading coach embedded in OpenRewind. You watch the user\'s replay unfold in real time.',
        'Use the telemetry to answer accurately about what is happening right now and what the user just did.',
        'If the user asks about their last trade, the trade they just did, or why it lost/won, use the exact values from the line that begins with "Latest closed trade overall:". Do not use a different trade or guess.',
        'Be concise: 2-4 short sentences unless the user asks for detail. Use plain English only. Never use markdown, LaTeX, code blocks, bullet points, or asterisks.',
        'Do not provide regulated investment advice; focus on execution quality, risk management, and what the user just did on the chart.',
        '',
        telemetry,
      ].join('\n');

      const history = nextMessages.map((m) => ({
        role: m.sender === 'ai' ? ('assistant' as const) : ('user' as const),
        content: m.text,
      }));

      const response = await tauriFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ORION_MODEL,
          messages: [{ role: 'system', content: systemPrompt }, ...history],
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama responded ${response.status}`);
      }

      const data = await response.json();
      const reply = typeof data.message?.content === 'string' ? data.message.content : 'No response content.';
      setMessages((prev) => [...prev, { sender: 'ai', text: reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          sender: 'ai',
          text: `Orion is offline — start Ollama locally and ensure \`${ORION_MODEL}\` is pulled. (${err instanceof Error ? err.message : String(err)})`,
        },
      ]);
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
        <Sparkles className={cn('h-4 w-4', lightMode ? 'text-[#2962ff]' : 'text-[#2962ff]')} />
        <span className={cn('text-sm font-semibold', lightMode ? 'text-gray-900' : 'text-[#d1d4dc]')}>
          Orion
        </span>
        {isTyping && (
          <span className={cn('ml-auto text-[10px] font-medium', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>
            {setupStage === 'ready' ? (isTyping ? 'thinking…' : 'online') : 'offline'}
          </span>
        )}
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
                  ? 'ml-auto bg-[#2962ff] text-white'
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
            <Sparkles className={cn('h-6 w-6', setupStage === 'error' ? 'text-[#ef5350]' : 'text-[#2962ff]')} />
            <div className="text-[13px] font-medium leading-tight">
              {setupStage === 'error'
                ? errorText || 'Orion cannot reach the local Ollama service.'
                : downloadMessage || pullStatus || 'Initializing Orion...'}
            </div>
            {(setupStage === 'downloading-ollama' || setupStage === 'starting-ollama' || setupStage === 'pulling-model') && (
              <div className="w-full max-w-[200px]">
                <div className={cn('h-1.5 w-full rounded-full', lightMode ? 'bg-gray-200' : 'bg-[#2a2e39]')}>
                  <div
                    className="h-full rounded-full bg-[#2962ff] transition-all duration-200"
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
            'flex-1 rounded border px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:ring-1 focus:ring-[#2962ff]',
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
              ? 'bg-[#2962ff] text-white hover:bg-[#2962ff]/90'
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
