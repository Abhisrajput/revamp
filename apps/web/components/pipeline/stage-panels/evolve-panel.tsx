'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Play, TrendingUp, MessageSquare, Send, FileCode,
  BarChart3, Rocket, RefreshCw, Loader2, Trash2, User, Bot,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StageOutput } from '@/components/pipeline/stage-output';
import { RefinableMarkdown } from '@/components/pipeline/refinable-markdown';
import { TerminalLog } from '@/components/pipeline/terminal-log';
import { usePipelineStore, canExecuteStage } from '@/lib/stores/pipeline-store';
import { useEvolveChat } from '@/lib/hooks/use-evolve-chat';
import { cn } from '@/lib/utils';
import type { StagePanelProps } from './types';

export default function EvolvePanel({
  stage,
  stageIndex,
  streamingText,
  onExecute,
  isExecuting,
  onRefineRequest,
  pipelineRunId,
}: StagePanelProps) {
  const logs = usePipelineStore((s) => s.logs);
  const stages = usePipelineStore((s) => s.stages);
  const [activeTab, setActiveTab] = useState<'roadmap' | 'chat' | 'output'>('roadmap');
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canExecute = (stage.status === 'pending' || stage.status === 'failed') && !isExecuting && canExecuteStage(stages, stageIndex);

  // Chat via LLM hook
  const { messages: chatHistory, sendMessage, isStreaming: isChatStreaming, clearHistory } = useEvolveChat(pipelineRunId);

  const handleSendChat = useCallback(() => {
    if (!chatInput.trim()) return;
    sendMessage(chatInput.trim());
    setChatInput('');
  }, [chatInput, sendMessage]);

  // Auto-scroll to bottom on new messages or streaming updates
  useEffect(() => {
    if (chatHistory.length > 0) {
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }, [chatHistory.length, chatHistory[chatHistory.length - 1]?.content]);

  const formatTimestamp = (ts: string) => {
    try {
      const date = new Date(ts);
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  const kpiCards = [
    { label: 'Code Coverage', value: '—', icon: BarChart3, color: 'text-blue-500' },
    { label: 'Modernization %', value: '—', icon: TrendingUp, color: 'text-green-500' },
    { label: 'Technical Debt', value: '—', icon: RefreshCw, color: 'text-orange-500' },
    { label: 'Deployment Ready', value: '—', icon: Rocket, color: 'text-purple-500' },
  ];

  return (
    <div className="space-y-4">
      {/* Pre-execution */}
      {!hasOutput && !isRunning && (
        <>
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Evolve & Operate
                </h3>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Continuous modernization with KPI tracking, iterative refinement through chat,
                and operational readiness planning. Your living modernization cockpit.
              </p>
            </CardContent>
          </Card>

          {/* KPI Preview */}
          <div className="grid grid-cols-4 gap-3">
            {kpiCards.map(({ label, value, icon: Icon, color }) => (
              <Card key={label} className="bg-slate-50 dark:bg-slate-900">
                <CardContent className="p-3 text-center">
                  <Icon className={cn('w-5 h-5 mx-auto mb-1', color)} />
                  <p className="text-lg font-bold text-slate-900 dark:text-slate-50">{value}</p>
                  <p className="text-[10px] text-slate-500">{label}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {canExecute && (
            <div className="flex justify-center pt-2">
              <Button size="lg" onClick={onExecute} className="gap-2">
                <Play className="w-4 h-4" />
                Generate Modernization Roadmap
              </Button>
            </div>
          )}
        </>
      )}

      {/* During execution */}
      {isRunning && (
        <>
          {streamingText && <StageOutput output={streamingText} isStreaming />}
          {logs.length > 0 && <TerminalLog logs={logs} title="Evolve Activity" />}
        </>
      )}

      {/* After execution */}
      {stage.output && !isRunning && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
            {[
              { key: 'roadmap', label: 'Roadmap', icon: TrendingUp },
              { key: 'chat', label: 'Chat', icon: MessageSquare },
              { key: 'output', label: 'Full Output', icon: FileCode },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key as any)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
                  activeTab === key
                    ? 'border-primary-600 text-primary-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
                {key === 'chat' && chatHistory.length > 0 && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1">
                    {chatHistory.length}
                  </Badge>
                )}
              </button>
            ))}
          </div>

          {/* Roadmap */}
          {activeTab === 'roadmap' && (
            <RefinableMarkdown
              text={stage.output}
              onSectionRefined={(updated) => {
                usePipelineStore.getState().setStageOutput(stageIndex, updated);
              }}
              onRefineRequest={onRefineRequest}
            />
          )}

          {/* Chat */}
          {activeTab === 'chat' && (
            <Card className="bg-slate-50 dark:bg-slate-900">
              <CardContent className="p-0">
                {/* Chat Header with clear button */}
                {chatHistory.length > 0 && (
                  <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-700">
                    <span className="text-xs text-slate-500">
                      {chatHistory.filter((m) => m.role === 'user').length} messages
                    </span>
                    <button
                      onClick={clearHistory}
                      disabled={isChatStreaming}
                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-3 h-3" />
                      Clear
                    </button>
                  </div>
                )}

                {/* Messages */}
                <div className="h-[380px] overflow-y-auto p-4 space-y-4">
                  {chatHistory.length === 0 ? (
                    <div className="text-center py-12">
                      <MessageSquare className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                      <p className="text-sm text-slate-500">
                        Start a conversation to refine your modernization plan
                      </p>
                      <div className="flex flex-wrap gap-2 justify-center mt-3">
                        {[
                          'Prioritize security improvements',
                          'Add monitoring strategy',
                          'Optimize for cost',
                          'Suggest phased rollout plan',
                        ].map((suggestion) => (
                          <button
                            key={suggestion}
                            onClick={() => setChatInput(suggestion)}
                            className="text-xs px-2.5 py-1.5 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-primary-300 hover:text-primary-600 transition-colors"
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    chatHistory.map((msg) => (
                      <div
                        key={msg.id}
                        className={cn(
                          'flex gap-2.5',
                          msg.role === 'user' ? 'justify-end' : 'justify-start',
                        )}
                      >
                        {/* Avatar for assistant */}
                        {msg.role === 'assistant' && (
                          <div className="w-6 h-6 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center shrink-0 mt-0.5">
                            <Bot className="w-3.5 h-3.5 text-primary-600 dark:text-primary-400" />
                          </div>
                        )}
                        <div className="flex flex-col max-w-[80%]">
                          <div className={cn(
                            'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                            msg.role === 'user'
                              ? 'bg-primary-600 text-white rounded-br-sm'
                              : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-bl-sm',
                          )}>
                            {msg.content || (
                              isChatStreaming && msg.role === 'assistant' ? (
                                <span className="flex items-center gap-1.5 text-slate-400">
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  Thinking...
                                </span>
                              ) : null
                            )}
                          </div>
                          {/* Timestamp */}
                          <span className={cn(
                            'text-[10px] text-slate-400 mt-0.5 px-1',
                            msg.role === 'user' ? 'text-right' : 'text-left',
                          )}>
                            {formatTimestamp(msg.timestamp)}
                          </span>
                        </div>
                        {/* Avatar for user */}
                        {msg.role === 'user' && (
                          <div className="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center shrink-0 mt-0.5">
                            <User className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                          </div>
                        )}
                      </div>
                    ))
                  )}

                  {/* Streaming indicator when assistant is responding */}
                  {isChatStreaming && chatHistory.length > 0 && chatHistory[chatHistory.length - 1]?.content && (
                    <div className="flex items-center gap-2 pl-8">
                      <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                      <span className="text-[10px] text-slate-400">Streaming...</span>
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>

                {/* Input */}
                <div className="border-t border-slate-200 dark:border-slate-700 p-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendChat();
                        }
                      }}
                      placeholder="Ask about the modernization plan..."
                      disabled={isChatStreaming}
                      className="flex-1 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50"
                    />
                    <Button
                      size="sm"
                      onClick={handleSendChat}
                      disabled={!chatInput.trim() || isChatStreaming}
                    >
                      {isChatStreaming ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1 px-1">
                    Press Enter to send
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Full Output */}
          {activeTab === 'output' && (
            <StageOutput output={stage.output} isStreaming={false} />
          )}
        </>
      )}
    </div>
  );
}
