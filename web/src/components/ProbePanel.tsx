import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import type { PublicChannel, PublicProbeResult, TaskState, Cls } from '../types';

interface Props {
  channel: PublicChannel;
  onError: (msg: string) => void;
  onRefresh: () => Promise<void>;
}

const CLS_ORDER = ['openai', 'responses', 'anthropic', 'gemini'];

const CLS_COLORS: Record<Cls, string> = {
  ok: 'ok',
  unsupported: 'bad',
  auth: 'bad',
  rate_limited: 'warn',
  timeout: 'muted',
  error: 'bad',
};

function formatLatency(ms: number, t: (k: string) => string): string {
  return ms < 1000 ? `${ms} ${t('probe.ms')}` : `${(ms / 1000).toFixed(1)} ${t('probe.sec')}`;
}

export default function ProbePanel({ channel, onError, onRefresh }: Props) {
  const { t } = useTranslation();
  const [task, setTask] = useState<TaskState | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const { task: tsk } = await api.getTask(channel.id);
      setTask(tsk);
      if (tsk?.running) {
        timer.current = setTimeout(() => void poll(), 800);
      } else if (tsk && !tsk.running) {
        if (tsk.error) setLastError(tsk.error);
        await onRefresh();
      }
    } catch {
      /* ignore */
    }
  }, [channel.id, onRefresh]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const run = async () => {
    setLastError(null);
    try {
      const { task: tsk } = await api.startProbe(channel.id);
      setTask(tsk);
      await poll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onError(t('error.taskConflict'));
      } else {
        onError(t('probe.failed') + (err instanceof Error ? err.message : ''));
      }
    }
  };

  const probe = channel.state?.probe;
  const running = task?.running === true;

  return (
    <section className="probe-panel">
      <div className="content-head">
        <h3>{t('probe.title')}</h3>
        <button type="button" disabled={running} onClick={() => void run()}>
          {running ? t('probe.running') : t('probe.run')}
        </button>
      </div>
      {lastError && (
        <p className="error">
          {lastError === 'no key configured'
            ? t('probe.noKey')
            : `${t('probe.failed')}${lastError}`}
        </p>
      )}
      {CLS_ORDER.map((proto) => {
        const r: PublicProbeResult | undefined = probe?.[proto];
        if (!r) return null;
        const color = CLS_COLORS[r.cls];
        return (
          <div key={proto} className="probe-row">
            <span className="probe-proto">{proto}</span>
            <span className={`cls-badge cls-${color}`}>{t(`cls.${r.cls}`)}</span>
            <code className="probe-url" title={r.rawSnippet}>{r.url}</code>
            <span className="probe-http">{r.httpStatus ?? '—'}</span>
            <span className="probe-latency">{formatLatency(r.latencyMs, t)}</span>
          </div>
        );
      })}
      {!probe && !running && <p className="empty">{t('probe.noResult')}</p>}
    </section>
  );
}
