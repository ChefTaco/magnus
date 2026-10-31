'use client';

import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

type LoginStep = 'credentials' | 'mfa';

export default function LoginPage(): React.ReactElement {
  const router = useRouter();
  const [hiveEnabled, setHiveEnabled] = useState(false);
  useEffect(() => { void fetch('/api/auth/hive/configured').then(r => r.json()).then(v => setHiveEnabled(v.configured === true)).catch(() => undefined); }, []);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // MFA state
  const [step, setStep] = useState<LoginStep>('credentials');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const mfaInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
        requiresMfa?: boolean;
        mfaToken?: string;
      };

      if (data.requiresMfa && data.mfaToken) {
        setMfaToken(data.mfaToken);
        setStep('mfa');
        setLoading(false);
        setTimeout(() => mfaInputRef.current?.focus(), 100);
        return;
      }

      if (!res.ok) {
        setError(data.error ?? 'Login failed');
        setLoading(false);
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setError('Connection error');
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken, mfaCode }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'Invalid code');
        setLoading(false);
        setMfaCode('');
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setError('Connection error');
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      {/* Scanline overlay is inherited from the body — this page sits underneath */}
      <div className="w-full max-w-sm">
        {/* Logo / Title */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-wider text-primary"
              style={{ textShadow: '0 0 20px rgba(0, 229, 255, 0.4), 0 0 40px rgba(0, 229, 255, 0.2)' }}>
            MAGNUS
          </h1>
          <p className="mt-2 text-sm text-text-muted">Fleet Management System</p>
        </div>

        {hiveEnabled && <a href="/api/auth/hive/start" className="mb-4 block rounded border border-primary p-3 text-center text-primary">Sign in with Hive</a>}
        {step === 'credentials' ? (
          /* ── Credentials Form ── */
          <form onSubmit={handleSubmit}
                className="rounded-lg border border-border bg-surface p-6 shadow-lg"
                style={{ boxShadow: '0 0 30px rgba(0, 229, 255, 0.05)' }}>

            {error && (
              <div className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="username" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-text-muted">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
                className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30"
                placeholder="Enter username"
              />
            </div>

            <div className="mb-6">
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-text-muted">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-text placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30"
                placeholder="Enter password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded bg-primary px-4 py-2 text-sm font-semibold text-bg transition-all hover:bg-primary-hover hover:shadow-[0_0_15px_rgba(0,229,255,0.3)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>
        ) : (
          /* ── MFA Challenge Form ── */
          <form onSubmit={handleMfaSubmit}
                className="rounded-lg border border-border bg-surface p-6 shadow-lg"
                style={{ boxShadow: '0 0 30px rgba(0, 229, 255, 0.05)' }}>

            <div className="mb-4 text-center">
              <div className="mb-2 text-2xl">🔐</div>
              <p className="text-sm text-text-muted">
                Enter the 6-digit code from your authenticator app
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="mb-6">
              <label htmlFor="mfaCode" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-text-muted">
                Authentication Code
              </label>
              <input
                ref={mfaInputRef}
                id="mfaCode"
                type="text"
                inputMode="numeric"
                pattern="[a-zA-Z0-9]*"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={12}
                className="w-full rounded border border-border bg-bg px-3 py-2 text-center text-lg font-mono tracking-[0.5em] text-text placeholder-text-muted/50 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30"
                placeholder="000000"
              />
              <p className="mt-2 text-xs text-text-muted/60 text-center">
                Or enter a backup code
              </p>
            </div>

            <button
              type="submit"
              disabled={loading || mfaCode.length < 6}
              className="w-full rounded bg-primary px-4 py-2 text-sm font-semibold text-bg transition-all hover:bg-primary-hover hover:shadow-[0_0_15px_rgba(0,229,255,0.3)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>

            <button
              type="button"
              onClick={() => { setStep('credentials'); setMfaToken(''); setMfaCode(''); setError(''); }}
              className="mt-3 w-full rounded border border-border px-4 py-2 text-sm text-text-muted transition-colors hover:border-primary/30 hover:text-text"
            >
              Back to Login
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-xs text-text-muted/50">
          Secure access required
        </p>
      </div>
    </div>
  );
}
