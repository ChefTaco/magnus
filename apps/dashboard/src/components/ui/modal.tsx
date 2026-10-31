'use client';

import { useEffect, useRef, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  className,
}: ModalProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Keep a stable ref to onClose so the effect below doesn't re-run
  // (and steal focus from inputs) every time the parent re-renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handleEsc);

    // Focus trap: keep focus inside the dialog
    const dialog = dialogRef.current;
    const handleTab = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleTab);

    // Auto-focus the dialog when opened
    dialog?.focus();

    return () => {
      window.removeEventListener('keydown', handleEsc);
      window.removeEventListener('keydown', handleTab);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-3">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'relative z-10 w-full max-w-lg rounded border border-border bg-surface p-6 shadow-[0_0_30px_var(--color-glow)] outline-none',
              className,
            )}
          >
            {/* Top gradient accent line */}
            <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-primary/60 via-accent/40 to-transparent" />

            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                {icon && (
                  <div className="flex h-10 w-10 items-center justify-center rounded border border-primary/30 bg-primary/5">
                    {icon}
                  </div>
                )}
                <div>
                  <h2 id={titleId} className="text-sm font-bold uppercase tracking-wider">{title}</h2>
                  {description && (
                    <p className="text-[11px] text-text-muted">{description}</p>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close dialog"
                className="rounded p-1.5 text-text-muted hover:text-accent transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface FormFieldProps {
  label: string;
  required?: boolean;
  children: ReactNode;
}

export function FormField({ label, required, children }: FormFieldProps): React.ReactElement {
  return (
    <div>
      <label className="block text-[11px] font-bold uppercase tracking-wider mb-1.5">
        {label} {required && <span className="text-accent">*</span>}
      </label>
      {children}
    </div>
  );
}

export const inputClass =
  'w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 focus:shadow-[0_0_8px_var(--color-glow)] transition-all';

export const selectClass =
  'w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 focus:shadow-[0_0_8px_var(--color-glow)] transition-all';

export const textareaClass =
  'w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 focus:shadow-[0_0_8px_var(--color-glow)] transition-all resize-none';
