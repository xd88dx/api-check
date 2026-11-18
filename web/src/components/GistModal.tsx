import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../api';
import type { GistStatus } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Busy = 'load' | 'save' | 'push' | 'pull' | null;

export default function GistModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GistStatus | null>(null);
  const [gistId, setGistId] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy('load');
    try {
      const s = await api.getGist();
      setStatus(s);
      setGistId(s.gistId);
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = async (): Promise<void> => {
    setBusy('save');
    setMsg(null);
    try {
      await api.putGist({ token: token || undefined, gistId });
      setToken('');
      await load();
      setMsg(t('gist.saved'));
    } catch (e) {
      setMsg(String((e as ApiError).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const run = async (action: 'push' | 'pull'): Promise<void> => {
    setBusy(action);
    setMsg(null);
    try {
      if (action === 'push') {
        const r = await api.gistPush();
        setMsg(`${t('gist.okPush')} ${r.gistId ?? ''}`);
      } else {
        await api.gistPull();
        setMsg(t('gist.okPull'));
      }
      await load();
    } catch (e) {
      setMsg(String((e as ApiError).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal gist-modal">
        <h3>{t('gist.title')}</h3>
        <p className="gist-hint">{t('gist.hint')}</p>

        <div className="form-row">
          <label>{t('gist.token')}</label>
          <input
            type="password"
            value={token}
            placeholder={
              status?.tokenMasked
                ? `${t('gist.tokenKept')}:${status.tokenMasked}`
                : t('gist.tokenPlaceholder')
            }
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label>{t('gist.gistId')}</label>
          <input
            type="text"
            value={gistId}
            placeholder={t('gist.gistIdPlaceholder')}
            onChange={(e) => setGistId(e.target.value)}
          />
        </div>

        <div className="gist-status">{status?.lastResult || t('gist.never')}</div>
        {msg && <div className="form-error">{msg}</div>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void save()}>
            {t('gist.save')}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void run('pull')}>
            {t('gist.pull')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() => void run('push')}
          >
            {t('gist.push')}
          </button>
        </div>
      </div>
    </div>
  );
}