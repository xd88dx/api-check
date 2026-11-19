import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import type { PublicChannel, TaskState } from '../types';
import EmptyState from './EmptyState';
import { CopyIcon, PlusIcon, XIcon } from './icons';

interface Props {
  channel: PublicChannel;
  onError: (msg: string) => void;
  onRefresh: () => Promise<void>;
}

function formatAgo(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('catalog.justNow');
  if (min < 60) return `${min} ${t('catalog.minutes')} ${t('catalog.ago')}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${t('catalog.hours')} ${t('catalog.ago')}`;
  const d = Math.floor(hr / 24);
  return `${d} ${t('catalog.days')} ${t('catalog.ago')}`;
}

export default function CatalogPanel({ channel, onError, onRefresh }: Props) {
  const { t } = useTranslation();
  const [task, setTask] = useState<TaskState | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [manualName, setManualName] = useState('');
  const [filter, setFilter] = useState(''); // §12.3：客户端关键字过滤（大小写不敏感子串）
  // M6 §13.4：chip 复制反馈（自动消失）
  const [copiedModelId, setCopiedModelId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const copyModelId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedModelId(id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedModelId(null), 1500);
    } catch {
      onError(t('catalog.copyFailed'));
    }
  };

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

  // M5 G6 加固：挂载时若已有运行中任务恢复轮询
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { task: tsk } = await api.getTask(channel.id);
        if (cancelled) return;
        if (tsk?.running) {
          setTask(tsk);
          timer.current = setTimeout(() => void poll(), 800);
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

  const refresh = async () => {
    setLastError(null);
    try {
      const { task: tsk } = await api.startCatalog(channel.id);
      setTask(tsk);
      await poll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) onError(t('error.taskConflict'));
      else onError(t('catalog.failed') + (err instanceof Error ? err.message : ''));
    }
  };

  const toggle = async (id: string, selected: boolean) => {
    const next = channel.models.map((m) => (m.id === id ? { ...m, selected } : m));
    await api.updateModels(channel.id, { selected: next.filter((m) => m.selected).map((m) => m.id) });
    await onRefresh();
  };

  const selectAll = async () => {
    await api.updateModels(channel.id, { selected: channel.models.map((m) => m.id) });
    await onRefresh();
  };

  const selectNone = async () => {
    await api.updateModels(channel.id, { selected: [] });
    await onRefresh();
  };

  const addManual = async () => {
    const name = manualName.trim();
    if (!name) return;
    setManualName('');
    await api.updateModels(channel.id, { addManual: [name] });
    await onRefresh();
  };

  const removeModel = async (id: string) => {
    await api.updateModels(channel.id, { removeModels: [id] });
    await onRefresh();
  };

  const running = task?.running === true;
  const catalogAt = channel.state?.catalogAt;
  // 过滤只影响展示，不影响勾选状态/手动添加/重取（§12.3）
  const kw = filter.trim().toLowerCase();
  const visibleModels = kw
    ? channel.models.filter((m) => m.id.toLowerCase().includes(kw))
    : channel.models;

  return (
    <section className="catalog-panel">
      <div className="content-head">
        <h3>{t('catalog.title')}</h3>
        <div className="catalog-actions">
          <button type="button" className="ghost" onClick={() => void selectAll()}>{t('catalog.selectAll')}</button>
          <button type="button" className="ghost" onClick={() => void selectNone()}>{t('catalog.selectNone')}</button>
          <button type="button" className="primary" disabled={running} onClick={() => void refresh()}>
            {running && <span className="spinner" aria-hidden="true" />}
            {running ? t('catalog.refreshing') : t('catalog.refresh')}
          </button>
        </div>
      </div>
      {lastError && (
        <p className="error">
          {lastError.includes('empty_catalog')
            ? t('catalog.errorEmpty')
            : `${t('catalog.failed')}${lastError}`}
        </p>
      )}
      {catalogAt && (
        <p className="catalog-ts">{t('catalog.timestamp')}{formatAgo(catalogAt, t)}</p>
      )}
      {/* M6 §13.3：手动添加组在左、过滤框在右，同一行 */}
      <div className="catalog-add">
        <div className="field-wrap catalog-filter-wrap">
          <input
            className="catalog-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('catalog.filterPlaceholder')}
          />
          {filter && (
            <button
              type="button"
              className="field-btn field-clear"
              title={t('common.clear')}
              aria-label={t('common.clear')}
              onClick={() => setFilter('')}
            >
              <XIcon size={13} />
            </button>
          )}
        </div>
        <div className="field-wrap catalog-add-manual">
          <input
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            placeholder={t('catalog.addManualPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addManual();
              }
            }}
          />
          <button
            type="button"
            className="field-btn field-add"
            title={t('catalog.addManual')}
            aria-label={t('catalog.addManual')}
            disabled={!manualName.trim()}
            onClick={() => void addManual()}
          >
            <PlusIcon size={14} />
          </button>
        </div>
      </div>
      {channel.models.length === 0 ? (
        <EmptyState text={t('catalog.empty')} />
      ) : visibleModels.length === 0 ? (
        <EmptyState text={t('catalog.noMatch')} />
      ) : (
        <div className="chips">
          {visibleModels.map((m) => (
            <label
              key={m.id}
              className={`chip ${m.selected ? 'selected' : ''} ${m.source} ${
                m.source === 'manual' || m.stale ? 'chip-missing' : ''
              }`}
            >
              <input
                type="checkbox"
                checked={m.selected}
                onChange={(e) => void toggle(m.id, e.target.checked)}
              />
              <span className="chip-name">{m.id}</span>
              <button
                type="button"
                className="chip-copy"
                title={t('catalog.copyModel')}
                aria-label={t('catalog.copyModel')}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void copyModelId(m.id);
                }}
              >
                <CopyIcon size={12} />
              </button>
              {copiedModelId === m.id && <span className="chip-copied">{t('common.copied')}</span>}
              {m.contextHint && <span className="chip-hint">{m.contextHint}</span>}
              {(m.source === 'manual' || m.stale) && (
                <button
                  type="button"
                  className="chip-x"
                  title={t('catalog.removeModel')}
                  aria-label={t('catalog.removeModel')}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void removeModel(m.id);
                  }}
                >
                  ×
                </button>
              )}
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
