import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import type { PublicChannel, CellResult, TaskState, Cls } from '../types';

interface Props {
  channel: PublicChannel;
  onError: (msg: string) => void;
  onRefresh: () => Promise<void>;
}

const CLS_COLORS: Record<Cls, string> = {
  ok: 'ok',
  unsupported: 'bad',
  auth: 'bad',
  rate_limited: 'warn',
  timeout: 'muted',
  error: 'bad',
};

function formatLatency(ms: number, t: (k: string) => string): string {
  return ms < 1000 ? `${ms} ${t('matrix.ms')}` : `${(ms / 1000).toFixed(1)} ${t('matrix.sec')}`;
}

function formatTimestamp(iso: string, t: (k: string) => string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (t('matrix.dateOrder') === 'MDY') {
    return `${mo}/${day}/${y} ${hh}:${mm}`;
  }
  return `${y}-${mo}-${day} ${hh}:${mm}`;
}

export default function MatrixPanel({ channel, onError, onRefresh }: Props) {
  const { t } = useTranslation();
  const [task, setTask] = useState<TaskState | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const { task: tsk } = await api.getTask(channel.id);
      setTask(tsk);
      if (tsk?.running) {
        timer.current = setTimeout(() => void poll(), 500);
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

  const selectedModels = channel.models.filter((m) => m.selected);
  const enabledKeys = channel.keys.filter((k) => k.enabled);
  const results = channel.state?.results;
  const running = task?.running === true;

  const run = async () => {
    setLastError(null);
    try {
      const { task: tsk } = await api.startTest(channel.id);
      setTask(tsk);
      await poll();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409 && err.body.error === 'probe_first') onError(t('matrix.probeFirst'));
        else if (err.status === 409) onError(t('error.taskConflict'));
        else onError(t('matrix.failed') + (err.body.error ?? ''));
      } else {
        onError(t('matrix.failed') + (err instanceof Error ? err.message : ''));
      }
    }
  };

  const stop = async () => {
    try {
      await api.stopTest();
    } catch {
      /* ignore */
    }
  };

  // 「只选可用」diff：按最近一次矩阵结果，ok/rate_limited 模型保留，其余取消勾选
  const diff = useMemo(() => {
    const keep = new Set<string>();
    for (const m of selectedModels) {
      const row = results?.[m.id];
      if (!row) continue;
      if (Object.values(row).some((c: CellResult) => c.cls === 'ok' || c.cls === 'rate_limited')) {
        keep.add(m.id);
      }
    }
    const toUncheck = selectedModels.filter((m) => !keep.has(m.id)).map((m) => m.id);
    return { keep: Array.from(keep), toUncheck };
  }, [selectedModels, results]);

  const applyAvailable = async () => {
    setDiffOpen(false);
    await api.updateModels(channel.id, { selected: diff.keep });
    await onRefresh();
  };

  const exportChannel = () => {
    const a = document.createElement('a');
    a.href = api.exportChannel(channel.id);
    a.download = `api-check-export-${channel.name}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const progress = useMemo(() => {
    const total = task?.total ?? 0;
    const idx = task?.current?.index ?? (task?.running ? 0 : total);
    return { idx, total };
  }, [task]);

  return (
    <section className="matrix-panel">
      <div className="content-head">
        <h3>{t('matrix.title')}</h3>
        <div className="catalog-actions">
          <button
            type="button"
            onClick={() => setDiffOpen((v) => !v)}
            disabled={running || selectedModels.length === 0}
          >
            {t('matrix.selectAvailable')}
          </button>
          <button type="button" onClick={exportChannel} disabled={running}>
            {t('matrix.export')}
          </button>
          {running ? (
            <button type="button" className="danger" onClick={() => void stop()}>
              {t('matrix.stop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={selectedModels.length === 0 || enabledKeys.length === 0}
            >
              {t('matrix.run')}
            </button>
          )}
        </div>
      </div>

      {lastError && (
        <p className="error">
          {lastError === 'probe_first'
            ? t('matrix.probeFirst')
            : lastError === 'no_enabled_keys'
              ? t('matrix.noKey')
              : lastError === 'no_selected_models'
                ? t('matrix.noModel')
                : `${t('matrix.failed')}${lastError}`}
        </p>
      )}
      {selectedModels.length === 0 && <p className="empty">{t('matrix.noModel')}</p>}
      {enabledKeys.length === 0 && <p className="empty">{t('matrix.noKey')}</p>}

      {running && task && (
        <p className="matrix-progress">
          {t('matrix.progress', { n: progress.idx + 1, total: progress.total })}
        </p>
      )}

      {diffOpen && (
        <div className="matrix-diff">
          {diff.toUncheck.length > 0 ? (
            <ul>
              <li>{t('matrix.diffUncheck')}：{diff.toUncheck.join(', ')}</li>
              <li>{t('matrix.diffKeep')}：{diff.keep.length > 0 ? diff.keep.join(', ') : t('matrix.diffNone')}</li>
            </ul>
          ) : (
            <p>{t('matrix.diffAllOk')}</p>
          )}
          <div className="actions">
            <button type="button" disabled={diff.toUncheck.length === 0} onClick={() => void applyAvailable()}>
              {t('matrix.apply')}
            </button>
            <button type="button" className="link" onClick={() => setDiffOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {selectedModels.length > 0 && enabledKeys.length > 0 && (
        <table className="matrix-table">
          <thead>
            <tr>
              <th>{t('matrix.model')}</th>
              {enabledKeys.map((k) => (
                <th key={k.id}>{k.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selectedModels.map((m) => (
              <tr key={m.id}>
                <th className="matrix-model">{m.id}</th>
                {enabledKeys.map((k) => {
                  const cell = results?.[m.id]?.[k.id];
                  const isCurrent = task?.current?.modelId === m.id && task?.current?.keyId === k.id;
                  return (
                    <td
                      key={k.id}
                      className={isCurrent ? 'matrix-cell-current' : ''}
                      title={cell?.rawSnippet}
                    >
                      {cell ? (
                        <span className={`cls-badge cls-${CLS_COLORS[cell.cls]}`}>
                          {t(`matrix.cls.${cell.cls}`)}
                        </span>
                      ) : isCurrent ? (
                        <span className="matrix-running">…</span>
                      ) : null}
                      {cell && (
                        <span className="matrix-cell-meta">
                          <span>{formatLatency(cell.latencyMs, t)}</span>
                          {cell.httpStatus !== null && cell.cls !== 'ok' && <span>{cell.httpStatus}</span>}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {channel.state?.lastTestAt && <p className="catalog-ts">{t('matrix.lastTestAt')}{formatTimestamp(channel.state.lastTestAt, t)}</p>}
    </section>
  );
}
