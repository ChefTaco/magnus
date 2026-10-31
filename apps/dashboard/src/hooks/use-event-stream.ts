'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { useToast, type ToastSeverity } from '@/components/ui/toast-provider'
import { eventFeed } from '@/lib/event-feed'

/**
 * Connects to the fleet event bus SSE endpoint and surfaces
 * important events as toast notifications. Every event also lands in the
 * shared event feed (header LED, live ticker).
 */
export function useEventStream({ enabled = true }: { enabled?: boolean } = {}) {
  const [connected, setConnected] = useState(false)
  const { addToast } = useToast()
  const addToastRef = useRef(addToast)
  addToastRef.current = addToast
  const eventSourceRef = useRef<EventSource | null>(null)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    if (!enabled) return

    const url = '/api/proxy/events/stream'
    const es = new EventSource(url)
    eventSourceRef.current = es

    es.onopen = () => {
      setConnected(true)
      eventFeed.setConnected(true)
    }

    // Listen for named events from the event bus
    const channels = [
      'deploy:status',
      'node:status',
      'command:status',
      'alert:fired',
    ]

    for (const channel of channels) {
      es.addEventListener(channel, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          const toast = eventToToast(channel, data)
          if (toast) addToastRef.current(toast)
          eventFeed.push(toast ? { ...toast, channel } : {
            title: String(data.type ?? channel).replaceAll('.', ' '),
            message: typeof data.nodeName === 'string' ? data.nodeName : undefined,
            severity: 'info',
            channel,
          })
        } catch {
          // Ignore parse errors
        }
      })
    }

    es.onerror = () => {
      setConnected(false)
      eventFeed.setConnected(false)
      es.close()
      void fetch('/api/auth/me', { cache: 'no-store' })
        .then((response) => {
          if (eventSourceRef.current !== es) return
          if (response.status === 401) {
            window.location.replace('/login')
            return
          }
          retryTimeoutRef.current = setTimeout(connect, 5000)
        })
        .catch(() => {
          if (eventSourceRef.current !== es) return
          retryTimeoutRef.current = setTimeout(connect, 5000)
        })
    }

    return es
  }, [enabled])

  useEffect(() => {
    const es = connect()
    return () => {
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
      es?.close()
      eventSourceRef.current?.close()
      eventFeed.setConnected(false)
      eventSourceRef.current = null
    }
  }, [connect])

  return { connected }
}

/** Map event bus events to toast notifications. */
function eventToToast(
  _channel: string,
  data: Record<string, unknown>,
): { title: string; message?: string; severity: ToastSeverity } | null {
  const type = (data.type as string) ?? ''
  const nodeName = (data.nodeName as string) ?? 'Unknown'

  switch (type) {
    case 'deploy.started':
      return { title: `Deploying to ${nodeName}`, severity: 'info' }
    case 'deploy.completed':
      return { title: `Deploy complete: ${nodeName}`, severity: 'success' }
    case 'deploy.failed':
      return {
        title: `Deploy failed: ${nodeName}`,
        message: (data.message as string) ?? undefined,
        severity: 'error',
      }
    case 'upgrade.started':
      return { title: `Upgrading ${nodeName}`, severity: 'info' }
    case 'upgrade.completed':
      return { title: `Upgrade complete: ${nodeName}`, message: `v${data.version}`, severity: 'success' }
    case 'upgrade.failed':
      return {
        title: `Upgrade failed: ${nodeName}`,
        message: (data.message as string) ?? undefined,
        severity: 'error',
      }
    case 'node.recovered':
      return {
        title: `${nodeName} back online`,
        message: `Recovered from ${data.previousStatus}`,
        severity: 'success',
      }
    case 'command.completed':
      return { title: 'Command completed', message: `${data.command}`, severity: 'success' }
    case 'command.failed':
      return { title: 'Command failed', message: `${data.command} (exit ${data.exitCode})`, severity: 'error' }
    case 'health.alert':
      return {
        title: `Alert: ${(data.metric as string)?.replaceAll('_', ' ').toUpperCase()} on ${nodeName}`,
        message: `${(data.value as number)?.toFixed(1)}% (threshold: ${data.threshold}%)`,
        severity: (data.severity as ToastSeverity) ?? 'warning',
      }
    default:
      // Don't show unrecognized events as toasts
      return null
  }
}
