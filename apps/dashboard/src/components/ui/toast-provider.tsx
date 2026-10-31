'use client'

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  title: string
  message?: string
  severity: ToastSeverity
  createdAt: number
}

interface ToastContextValue {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id' | 'createdAt'>) => void
  removeToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

let toastCounter = 0

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const addToast = useCallback(
    (toast: Omit<Toast, 'id' | 'createdAt'>) => {
      const id = `toast-${++toastCounter}`
      const newToast: Toast = { ...toast, id, createdAt: Date.now() }
      setToasts((prev) => [...prev.slice(-9), newToast]) // Keep max 10

      // Auto-dismiss after 6s (errors stay 10s)
      const timeout = toast.severity === 'error' ? 10_000 : 6_000
      setTimeout(() => removeToast(id), timeout)
    },
    [removeToast],
  )

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}

// ── Severity styling ──
const severityStyles: Record<ToastSeverity, { bar: string; border: string; text: string; glow: string; Icon: typeof Info }> = {
  info: { bar: 'bg-primary', border: 'border-primary/40', text: 'text-primary', glow: 'shadow-[0_0_20px_var(--color-glow)]', Icon: Info },
  success: { bar: 'bg-success', border: 'border-success/40', text: 'text-success', glow: 'shadow-[0_0_20px_var(--color-glow-success)]', Icon: CheckCircle2 },
  warning: { bar: 'bg-warning', border: 'border-warning/40', text: 'text-warning', glow: 'shadow-[0_0_20px_var(--color-glow-warning)]', Icon: AlertTriangle },
  error: { bar: 'bg-danger', border: 'border-danger/40', text: 'text-danger', glow: 'shadow-[0_0_20px_var(--color-glow-danger)]', Icon: XCircle },
}

function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }): React.ReactElement | null {
  if (toasts.length === 0) return null

  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-(--z-toast) flex max-w-sm flex-col gap-2">
      {toasts.map((toast) => {
        const style = severityStyles[toast.severity]
        const Icon = style.Icon
        return (
          <div
            key={toast.id}
            className={`relative overflow-hidden rounded-panel border ${style.border} ${style.glow} bg-surface/95 py-3 pl-4 pr-3 text-text backdrop-blur-sm animate-toast-in`}
          >
            <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${style.bar}`} />
            <div className="flex items-start gap-2.5">
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.text}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className={`text-xs font-bold uppercase leading-tight tracking-wider ${style.text}`}>{toast.title}</p>
                {toast.message && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-text-muted">{toast.message}</p>
                )}
              </div>
              <button
                onClick={() => onRemove(toast.id)}
                aria-label="Dismiss notification"
                className="ml-2 shrink-0 text-text-muted transition-colors hover:text-text"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <span
              aria-hidden="true"
              className={`absolute bottom-0 left-0 h-px w-full origin-left opacity-60 ${style.bar}`}
              style={{ animation: `toast-progress ${toast.severity === 'error' ? 10 : 6}s linear forwards` }}
            />
          </div>
        )
      })}
    </div>
  )
}
