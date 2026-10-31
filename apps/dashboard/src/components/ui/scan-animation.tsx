'use client';

import { motion } from 'motion/react';
import { Loader2, CheckCircle2, XCircle, Radio } from 'lucide-react';

interface NodeScanStatus {
  nodeId: string;
  nodeName: string;
  status: 'scanning' | 'done' | 'error';
  error?: string;
}

interface ScanAnimationProps {
  title: string;
  description?: string;
  nodes: NodeScanStatus[];
  scanning: boolean;
}

export function ScanAnimation({
  title,
  description,
  nodes,
  scanning,
}: ScanAnimationProps): React.ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] }}
      className="rounded border border-primary/30 bg-surface p-6 relative overflow-hidden"
    >
      {/* Animated scanline overlay */}
      {scanning && (
        <motion.div
          className="absolute inset-0 pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <motion.div
            className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent"
            animate={{ top: ['0%', '100%'] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          />
        </motion.div>
      )}

      {/* Glow border effect */}
      <div
        className="absolute inset-0 rounded pointer-events-none"
        style={{
          boxShadow: scanning
            ? '0 0 20px var(--color-glow), inset 0 0 20px rgba(0,229,255,0.03)'
            : 'none',
          transition: 'box-shadow 0.5s ease',
        }}
      />

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          {scanning ? (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
            >
              <Radio className="h-5 w-5 text-primary" />
            </motion.div>
          ) : (
            <CheckCircle2 className="h-5 w-5 text-success" />
          )}
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider">
              {scanning ? title : 'Scan Complete'}
            </h3>
            {description && (
              <p className="text-[11px] text-text-muted">{description}</p>
            )}
          </div>
        </div>

        {/* Node status list */}
        {nodes.length > 0 && (
          <div className="space-y-2">
            {nodes.map((node, i) => (
              <motion.div
                key={node.nodeId}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05, duration: 0.3 }}
                className="flex items-center gap-3 text-xs"
              >
                {node.status === 'scanning' && (
                  <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />
                )}
                {node.status === 'done' && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                )}
                {node.status === 'error' && (
                  <XCircle className="h-3.5 w-3.5 text-danger" />
                )}
                <span className="text-text">{node.nodeName}</span>
                {node.status === 'error' && node.error && (
                  <span className="text-[10px] text-danger/70 truncate max-w-[200px]">
                    {node.error}
                  </span>
                )}
              </motion.div>
            ))}
          </div>
        )}

        {/* Empty state during scanning */}
        {nodes.length === 0 && scanning && (
          <p className="text-[11px] text-text-muted">Discovering nodes...</p>
        )}
      </div>
    </motion.div>
  );
}
