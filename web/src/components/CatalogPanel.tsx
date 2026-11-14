import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import type { PublicChannel, TaskState } from '../types';

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

  const removeManual = async (id: string) => {
    await api.updateModels(channel.id, { removeManual: [id] });
    await onRefresh();
  };

  const running = task?.running === true;
  const catalogAt = channel.state?.catalogAt;

  return (
    <section className="catalog-panel">
      <div className="content-head">
        <h3>{t('catalog.title')}</h3>
        <div className="catalog-actions">
          <button type="button" onClick={() => void selectAll()}>{t('catalog.selectAll')}</button>
          <button type="button" onClick={() => void selectNone()}>{t('catalog.selectNone')}</button>
          <button type="button" disabled={running} onClick={() => void refresh()}>
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
      <div className="catalog-add">
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
        <button type="button" onClick={() => void addManual()}>{t('catalog.addManual')}</button>
      </div>
      {channel.models.length === 0 ? (
        <p className="empty">{t('catalog.empty')}</p>
      ) : (
        <div className="chips">
          {channel.models.map((m) => (
            <label key={m.id} className={`chip ${m.selected ? 'selected' : ''} ${m.source}`}>
              <input
                type="checkbox"
                checked={m.selected}
                onChange={(e) => void toggle(m.id, e.target.checked)}
              />
              <span className="chip-name">{m.id}</span>
              {m.contextHint && <span className="chip-hint">{m.contextHint}</span>}
              {m.source === 'manual' && (
                <button type="button" className="chip-x" onClick={() => void removeManual(m.id)}>×</button>
              )}
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
