'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import { Bot, Clock3, GitBranch, Loader2, Share2, User } from 'lucide-react';
import type { SharedAiConversation } from '@/types/contracts';
import { proxyTargetHeaders } from '@/lib/proxy-target';

export default function SharedConversationPage(): React.ReactElement {
  const params = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const [data, setData] = useState<SharedAiConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const target = useMemo(() => searchParams.get('target') ?? '', [searchParams]);

  useEffect(() => {
    let mounted = true;
    if (!target) {
      setError('This shared link is missing its control-node target. Ask the sender to regenerate it.');
      setLoading(false);
      return;
    }

    fetch(`/api/proxy/assistant/shares/${params.token}`, {
      headers: proxyTargetHeaders(target),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(response.status === 404 ? 'This shared conversation was not found or has expired.' : 'Unable to load the shared conversation.');
        }
        return response.json() as Promise<{ data?: SharedAiConversation }>;
      })
      .then((payload) => {
        if (mounted) {
          setData(payload.data ?? null);
          setError(null);
        }
      })
      .catch((err) => {
        if (mounted) setError(err instanceof Error ? err.message : 'Unable to load the shared conversation.');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [params.token, target]);

  return (
    <div className="min-h-screen bg-bg px-4 py-10 text-text">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 rounded-2xl border border-border bg-surface/80 p-6 shadow-2xl shadow-black/30">
          <div className="mb-3 flex items-center gap-2 text-sm uppercase tracking-[0.3em] text-primary">
            <Share2 className="h-4 w-4" />
            Shared Magnus conversation
          </div>
          {loading ? (
            <div className="flex items-center gap-3 py-12 text-text-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading shared conversation…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>
          ) : data ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold text-text">{data.conversation.title}</h1>
                <span className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs uppercase tracking-wider text-primary">
                  {data.conversation.type}
                </span>
                {data.conversation.parentId && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-hover px-3 py-1 text-xs text-text">
                    <GitBranch className="h-3.5 w-3.5" /> Branch
                  </span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-text-muted">
                <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> Expires {new Date(data.expiresAt).toLocaleString()}</span>
                <span>{data.conversation.messageCount ?? data.messages.length} message{(data.conversation.messageCount ?? data.messages.length) === 1 ? '' : 's'}</span>
              </div>
            </>
          ) : null}
        </div>

        {data && (
          <div className="space-y-4">
            {data.messages.map((message) => {
              const isUser = message.role === 'user';
              return (
                <div key={message.id} className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary'}`}>
                    {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                  </div>
                  <div className={`max-w-[85%] rounded-2xl border px-4 py-3 ${isUser ? 'border-success/20 bg-success/5' : 'border-border bg-surface/80'}`}>
                    <div className="prose prose-invert prose-p:my-2 prose-pre:bg-bg prose-code:text-primary max-w-none text-sm">
                      <ReactMarkdown>{message.content}</ReactMarkdown>
                    </div>
                    {message.thinking && (
                      <details className="mt-3 rounded-xl border border-border bg-bg/80 p-3 text-xs text-text">
                        <summary className="cursor-pointer text-text-muted">Reasoning trace</summary>
                        <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text">{message.thinking}</pre>
                      </details>
                    )}
                    <div className="mt-3 text-[11px] text-text-muted">{new Date(message.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
