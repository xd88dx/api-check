import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import type { PublicChannel, CellResult, TaskState, Cls } from '../types';
import EmptyState from './EmptyState';

interface Props {
  channel: PublicChannel;
  defaultRepeat: number; // M5：testDefaults.repeat
  defaultIntervalMs: number; // M6 §13.5：testDefaults.intervalMs
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

export default function MatrixPanel({ channel, defaultRepeat, defaultIntervalMs, onError, onRefresh }: Props) {
  const { t } = useTranslation();
  const [task, setTask] = useState<TaskState | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [repeat, setRepeat] = useState(defaultRepeat);
  const [intervalMs, setIntervalMs] = useState(defaultIntervalMs);
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

  // M5 G6 加固：挂载时若已有运行中任务恢复轮询（整页刷新、hash 持久化兜底）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { task: tsk } = await api.getTask(channel.id);
        if (cancelled) return;
        if (tsk?.running) {
          setTask(tsk);
          timer.current = setTimeout(() => void poll(), 500);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [channel.id, poll]);

  const selectedModels = channel.models.filter((m) => m.selected);
  const enabledKeys = channel.keys.filter((k) => k.enabled);
  const results = channel.state?.results;
  const running = task?.running === true;

  const run = async () => {
    setLastError(null);
    try {
      const r = Math.min(10, Math.max(1, Math.round(repeat) || 1));
      const iv = Math.max(0, Math.round(intervalMs) || 0);
      setRepeat(r);
      setIntervalMs(iv);
      const { task: tsk } = await api.startTest(channel.id, { repeat: r, intervalMs: iv });
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

  const exportChannel = async () => {
    const payload = await api.exportChannel(channel.id);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `api-check-export-${channel.name}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
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
            className="ghost"
            onClick={() => setDiffOpen((v) => !v)}
            disabled={running || selectedModels.length === 0}
          >
            {t('matrix.selectAvailable')}
          </button>
          <button type="button" className="ghost" onClick={() => void exportChannel()} disabled={running}>
            {t('matrix.export')}
          </button>
          {running ? (
            <button type="button" className="danger" onClick={() => void stop()}>
              {t('matrix.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => void run()}
              disabled={selectedModels.length === 0 || enabledKeys.length === 0}
            >
              {t('matrix.run')}
            </button>
          )}
        </div>
      </div>

      {running && task && (
        <div className="matrix-progress">
          <span>{t('matrix.progress', { n: progress.idx + 1, total: progress.total })}</span>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress.total ? (progress.idx / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}
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
      {selectedModels.length === 0 ? (
        <EmptyState text={t('matrix.noModel')} />
      ) : enabledKeys.length === 0 ? (
        <EmptyState text={t('matrix.noKey')} />
      ) : null}
      <div className="matrix-controls">
        <label className="matrix-repeat">
          <span>{t('matrix.repeat')}</span>
          <input
            type="number"
            min={1}
            max={10}
            value={repeat}
            onChange={(e) => setRepeat(Number(e.target.value) || 1)}
            disabled={running}
          />
          <span className="matrix-repeat-hint">{t('matrix.repeatHint')}</span>
        </label>
        <label className="matrix-repeat">
          <span>{t('matrix.interval')}</span>
          <input
            type="number"
            min={0}
            step={100}
            value={intervalMs}
            onChange={(e) => setIntervalMs(Math.max(0, Number(e.target.value) || 0))}
            disabled={running}
          />
          <span className="matrix-repeat-hint">{t('matrix.intervalHint')}</span>
        </label>
      </div>

      <div className="matrix-legend">
        <span className="matrix-legend-label">{t('matrix.legend')}</span>
        {(['ok', 'rate_limited', 'timeout', 'unsupported', 'error'] as Cls[]).map((c) => (
          <span key={c} className={`cls-badge cls-${CLS_COLORS[c]}`}>
            {t(`matrix.cls.${c}`)}
          </span>
        ))}
      </div>

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
            <button type="button" className="primary" disabled={diff.toUncheck.length === 0} onClick={() => void applyAvailable()}>
              {t('matrix.apply')}
            </button>
            <button type="button" className="link" onClick={() => setDiffOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {selectedModels.length > 0 && enabledKeys.length > 0 && (
        <div className="table-scroll">
        <table className="matrix-table">
          <thead>
            <tr>
              <th>{t('matrix.model')}</th>
              {enabledKeys.map((k) => (
                <th key={k.id}>{t('matrix.keyCol', { label: k.label })}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selectedModels.map((m) => (
              <tr key={m.id}>
                <th className="matrix-model" title={m.id}>{m.id}</th>
                {enabledKeys.map((k) => {
                  const cell = results?.[m.id]?.[k.id];
                  const isCurrent = task?.current?.modelId === m.id && task?.current?.keyId === k.id;
                  const repeats = cell?.repeats;
                  // M7 §14：色块按最终 cls；有重试经历附标注（成功=重试 K 次后成功，全败=重试 N 次均失败）
                  const color = cell ? CLS_COLORS[cell.cls] : '';
                  const success = cell ? cell.cls === 'ok' || cell.cls === 'rate_limited' : false;
                  const retryNote = repeats && repeats.length > 1
                    ? success
                      ? t('matrix.retrySuccess', { n: repeats.length - 1 })
                      : t('matrix.retryAllFail', { n: repeats.length })
                    : null;
                  const tooltip = repeats && repeats.length > 1
                    ? repeats.map((r, i) => `#${i + 1} ${t(`matrix.cls.${r.cls}`)} · ${formatLatency(r.latencyMs, t)}${r.httpStatus !== null ? ` · ${r.httpStatus}` : ''}`).join('\n')
                    : cell?.rawSnippet;
                  return (
                    <td
                      key={k.id}
                      className={`matrix-cell ${color ? `cell-${color}` : ''} ${isCurrent ? 'matrix-cell-current' : ''}`}
                      title={tooltip}
                    >
                      {cell ? (
                        <span className="matrix-cell-inner">
                          <span className={`cls-badge cls-${color}`}>
                            {t(`matrix.cls.${cell.cls}`)}
                          </span>
                          <span className="matrix-cell-meta">
                            {formatLatency(cell.latencyMs, t)}
                            {cell.httpStatus !== null && cell.cls !== 'ok' ? ` · ${cell.httpStatus}` : ''}
                            {retryNote ? ` · ${retryNote}` : ''}
                          </span>
                        </span>
                      ) : isCurrent ? (
                        <span className="matrix-running">…</span>
                      ) : null}
                                          </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {channel.state?.lastTestAt && <p className="catalog-ts">{t('matrix.lastTestAt')}{formatTimestamp(channel.state.lastTestAt, t)}</p>}
    </section>
  );
}
