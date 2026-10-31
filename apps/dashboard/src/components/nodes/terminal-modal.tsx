'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import { Modal } from '@/components/ui/modal';

interface TerminalModalProps {
  open: boolean;
  onClose: () => void;
  node: { id: string; name: string; hostname: string; ipAddress: string } | null;
}

export function TerminalModal({ open, onClose, node }: TerminalModalProps): React.ReactElement | null {
  const termRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- xterm types loaded dynamically
  const xtermRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- addon-fit types loaded dynamically
  const fitRef = useRef<any>(null);
  const sessionIdRef = useRef<string | null>(null);
  const cleanedUp = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'closed'>('connecting');

  // Batched input: collect keystrokes and flush every ~16ms
  const inputBufferRef = useRef<string>('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushInput = useCallback(() => {
    flushTimerRef.current = null;
    const data = inputBufferRef.current;
    if (!data || !sessionIdRef.current) return;
    inputBufferRef.current = '';

    void fetch('/api/terminal/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionIdRef.current, data }),
    }).catch(() => {
      // ignore — session may have ended
    });
  }, []);

  const cleanup = useCallback(() => {
    if (cleanedUp.current) return;
    cleanedUp.current = true;

    // Cancel any pending input flush
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    // Abort the stream fetch
    abortRef.current?.abort();
    abortRef.current = null;

    // Close server-side session
    if (sessionIdRef.current) {
      void fetch('/api/terminal/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdRef.current }),
      }).catch(() => { /* ignore */ });
      sessionIdRef.current = null;
    }

    // Dispose xterm
    try { xtermRef.current?.dispose(); } catch { /* ignore */ }
    xtermRef.current = null;
    fitRef.current = null;
  }, []);

  useEffect(() => {
    if (!open || !node || !termRef.current) return;

    cleanedUp.current = false;
    setStatus('connecting');

    let cancelled = false;

    void (async () => {
      // Dynamic import to avoid SSR issues
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      // Inject xterm CSS if not already present
      if (!document.getElementById('xterm-css')) {
        const style = document.createElement('style');
        style.id = 'xterm-css';
        style.textContent = `
          .xterm { position: relative; user-select: none; }
          .xterm.focus, .xterm:focus { outline: none; }
          .xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
          .xterm .xterm-helper-textarea { padding: 0; border: 0; margin: 0; position: absolute; opacity: 0; left: -9999em; top: 0; width: 0; height: 0; z-index: -5; white-space: nowrap; overflow: hidden; resize: none; }
          .xterm .composition-view { display: none; position: absolute; white-space: nowrap; z-index: 1; }
          .xterm .xterm-viewport { background-color: transparent !important; overflow-y: scroll; cursor: default; position: absolute; right: 0; left: 0; top: 0; bottom: 0; scrollbar-width: thin; scrollbar-color: #5a5a7a transparent; }
          .xterm .xterm-screen { position: relative; }
          .xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
          .xterm .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute; }
          .xterm .xterm-decoration-top-layer { z-index: 7; position: relative; }
        `;
        document.head.appendChild(style);
      }

      if (cancelled || cleanedUp.current) return;

      const term = new Terminal({
        cursorBlink: true,
        scrollback: 1000,
        fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
        fontSize: 13,
        theme: {
          background: '#06060d',
          foreground: '#e0e0ec',
          cursor: '#00e5ff',
          cursorAccent: '#06060d',
          selectionBackground: '#00e5ff33',
          black: '#06060d',
          red: '#ff1744',
          green: '#00ff41',
          yellow: '#ffb300',
          blue: '#00b0ff',
          magenta: '#ff006e',
          cyan: '#00e5ff',
          white: '#e0e0ec',
          brightBlack: '#5a5a7a',
          brightRed: '#ff5252',
          brightGreen: '#69f0ae',
          brightYellow: '#ffd740',
          brightBlue: '#40c4ff',
          brightMagenta: '#ff4081',
          brightCyan: '#18ffff',
          brightWhite: '#ffffff',
        },
      });

      const fit = new FitAddon();
      term.loadAddon(fit);

      xtermRef.current = term;
      fitRef.current = fit;

      if (termRef.current) {
        term.open(termRef.current);
        requestAnimationFrame(() => {
          if (!cleanedUp.current) fit.fit();
        });
      }

      if (cancelled || cleanedUp.current) return;

      // Determine initial dimensions
      const dims = fit.proposeDimensions();
      const cols = dims?.cols ?? 120;
      const rows = dims?.rows ?? 30;

      // Use hostname for SSH, fall back to IP
      const sshHost = node.hostname || node.ipAddress;

      term.write(`\x1b[38;2;138;138;171mConnecting to ${sshHost} as ${sshHost === node.hostname ? node.hostname : node.ipAddress}...\x1b[0m\r\n`);

      // ── Step 1: Open SSH session on server side ──
      let sessionId: string;
      try {
        const openRes = await fetch('/api/terminal/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: sshHost, cols, rows }),
        });

        if (!openRes.ok) {
          const err = (await openRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${openRes.status}`);
        }

        const openData = (await openRes.json()) as { sessionId: string };
        sessionId = openData.sessionId;
        sessionIdRef.current = sessionId;
      } catch (err) {
        if (cancelled || cleanedUp.current) return;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        term.write(`\r\n\x1b[31mFailed to open session: ${msg}\x1b[0m\r\n`);
        setStatus('error');
        return;
      }

      if (cancelled || cleanedUp.current) return;
      setStatus('connected');

      // ── Step 2: Start streaming output & launch TUI ──
      const abortCtrl = new AbortController();
      abortRef.current = abortCtrl;

      void (async () => {
        try {
          const streamRes = await fetch(
            `/api/terminal/stream?sessionId=${encodeURIComponent(sessionId)}`,
            { signal: abortCtrl.signal },
          );

          if (!streamRes.ok || !streamRes.body) {
            if (!cancelled && !cleanedUp.current) {
              term.write('\r\n\x1b[31mFailed to connect output stream\x1b[0m\r\n');
              setStatus('error');
            }
            return;
          }

          const reader = streamRes.body.getReader();

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (cancelled || cleanedUp.current) break;
            if (value) {
              term.write(value);
            }
          }
        } catch (err) {
          // AbortError is expected on cleanup
          if (err instanceof DOMException && err.name === 'AbortError') return;
        }

        if (!cancelled && !cleanedUp.current) {
          setStatus('closed');
          term.write('\r\n\x1b[38;2;138;138;171m── Session ended ──\x1b[0m\r\n');
        }
      })();

      // ── Step 3: Wire up input (batched at ~60fps) ──
      term.onData((data) => {
        if (cleanedUp.current || !sessionIdRef.current) return;
        inputBufferRef.current += data;
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(flushInput, 16);
        }
      });

      // ── Step 4: Handle resize ──
      term.onResize(({ cols: c, rows: r }) => {
        if (cleanedUp.current || !sessionIdRef.current) return;
        void fetch('/api/terminal/resize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionIdRef.current, cols: c, rows: r }),
        }).catch(() => { /* ignore */ });
      });
    })();

    // Window resize handler
    const handleResize = (): void => {
      if (fitRef.current && !cleanedUp.current) {
        fitRef.current.fit();
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', handleResize);
      cleanup();
    };
  }, [open, node, cleanup, flushInput]);

  const handleClose = useCallback(() => {
    cleanup();
    onClose();
  }, [cleanup, onClose]);

  if (!node) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Terminal: ${node.name}`}
      description="Interactive SSH session"
      icon={<TerminalIcon className="h-5 w-5 text-primary" />}
      className="max-w-5xl"
    >
      <div className="relative">
        {/* Status indicator */}
        <div className="absolute top-0 right-0 z-10 flex items-center gap-1.5 px-2 py-1">
          <div
            className={`h-1.5 w-1.5 rounded-full ${
              status === 'connected'
                ? 'bg-success'
                : status === 'connecting'
                  ? 'bg-warning animate-pulse'
                  : status === 'error'
                    ? 'bg-danger'
                    : 'bg-text-muted'
            }`}
          />
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            {status}
          </span>
        </div>

        {/* Terminal container */}
        <div
          ref={termRef}
          className="h-[65vh] w-full rounded border border-border/50 bg-[#06060d] p-1 overflow-hidden"
        />
      </div>
    </Modal>
  );
}
