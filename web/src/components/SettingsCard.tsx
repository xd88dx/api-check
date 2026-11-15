import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ApiError } from '../api';
import type { GistStatus } from '../types';

interface Props {
  authRequired: boolean | null;
}

type SyncAction = 'push' | 'pull' | 'sync' | null;

/** M8 §15.3：列表页「设置」卡——Gist 配置 + 未设密码裸奔提示（双语） */
export default function SettingsCard({ authRequired }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GistStatus | null>(null);
  const [gistId, setGistId] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<SyncAction | 'load' | 'save' | null>(null);
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

  // 挂载时自动拉取一次 Gist 配置态
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    setBusy('save');
    setMsg(null);
    try {
      await api.putGist({ token: token || undefined, gistId });
      await load();
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const run = async (action: Exclude<SyncAction, null>): Promise<void> => {
    setBusy(action);
    setMsg(null);
    try {
      const r = await api[`gist${action[0]!.toUpperCase()}${action.slice(1)}` as 'gistPush']();
      setMsg(
        action === 'push'
          ? `${t('gist.okPush')} ${r.gistId ?? ''}`
          : action === 'pull'
            ? t('gist.okPull')
            : r.action,
      );
      await load();
    } catch (e) {
      setMsg((e as ApiError).message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const syncedAtStr = status?.syncedAt ? new Date(status.syncedAt).toLocaleString() : '';

  return (
    <section className="content">
      <div className="content-head">
        <h2>{t('settings.title')}</h2>
        <button type="button" onClick={() => void load()}>{t('settings.refresh')}</button>
      </div>

      {/* authRequired=null（未加载）时不显示，避免闪烁 */}
      {authRequired === false && (
        <div className="warning-banner" role="alert">
          {t('settings.noPasswordWarn')}
        </div>
      )}

      <section className="key-panel">
        <div className="content-head">
          <h3>{t('gist.title')}</h3>
        </div>
        <p className="gist-hint">{t('gist.hint')}</p>

        <div className="form-row">
          <label>{t('gist.token')}</label>
          <input
            type="password"
            value={token}
            placeholder={status?.tokenMasked ? `${t('gist.tokenKept')}：${status.tokenMasked}` : t('gist.tokenPlaceholder')}
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

        <div className="gist-status">
          {status?.lastResult || t('gist.never')}
          {syncedAtStr ? ` · ${syncedAtStr}` : ''}
        </div>
        {msg && <div className="form-error">{msg}</div>}

        <div className="gist-actions">
          <button type="button" className="primary" disabled={busy !== null} onClick={() => void save()}>
            {t('gist.save')}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void run('push')}>
            {t('gist.push')}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void run('pull')}>
            {t('gist.pull')}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void run('sync')}>
            {t('gist.sync')}
          </button>
        </div>
      </section>
    </section>
  );
}
