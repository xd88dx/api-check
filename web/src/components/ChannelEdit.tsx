import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import type { PublicChannel } from '../types';
import KeyPanel from './KeyPanel';
import ProbePanel from './ProbePanel';
import CatalogPanel from './CatalogPanel';
import MatrixPanel from './MatrixPanel';

interface Props {
  channel: PublicChannel | null; // null = 新建
  defaultRepeat: number; // M5：testDefaults.repeat，矩阵测试次数预填
  defaultIntervalMs: number; // M6 §13.5：testDefaults.intervalMs，矩阵间隔预填
  onSaved: (id: string) => void | Promise<void>;
  onBack: () => void;
  onError: (msg: string) => void;
  onRefresh: () => Promise<void>;
}

function firstIssueMessage(err: unknown): string | null {
  if (err instanceof ApiError && err.body.issues && err.body.issues.length > 0) {
    const i = err.body.issues[0];
    return `${i.path}: ${i.message}`;
  }
  return null;
}

export default function ChannelEdit({ channel, defaultRepeat, defaultIntervalMs, onSaved, onBack, onError, onRefresh }: Props) {
  const { t } = useTranslation();
  const isNew = channel === null;
  const [name, setName] = useState(channel?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(channel?.baseUrl ?? '');
  const [insecure, setInsecure] = useState(channel?.insecure ?? false);
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const { channel: created } = await api.createChannel({
          name,
          baseUrl,
          insecure,
        });
        await onSaved(created.id);
      } else {
        await api.updateChannel(channel.id, { name, baseUrl, insecure, enabled });
        await onSaved(channel.id);
      }
      setFieldError(null);
    } catch (err) {
      const issue = firstIssueMessage(err);
      onError(issue ? `${t('error.validation')} ${issue}` : t('error.save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="content">
      <div className="content-head">
        <h2>{isNew ? t('channel.new') : t('channel.edit')}</h2>
        <button type="button" className="link" onClick={onBack}>
          {t('channel.back')}
        </button>
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          <span>{t('channel.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('channel.namePlaceholder')}
            required
          />
        </label>
        <label>
          <span>{t('channel.baseUrl')}</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={t('channel.baseUrlPlaceholder')}
            required
            className="mono"
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={insecure}
            onChange={(e) => setInsecure(e.target.checked)}
          />
          <span>{t('channel.insecure')}</span>
        </label>
        {insecure && <p className="warn">{t('channel.insecureHint')}</p>}
        {!isNew && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>{t('channel.enabled')}</span>
          </label>
        )}
        <div className="actions">
          <button type="submit" className="primary" disabled={saving}>
            {t('channel.save')}
          </button>
        </div>
        {fieldError && <p className="error">{fieldError}</p>}
      </form>
      {!isNew && channel && (
        <>
          {/* M5 §12.4 顺序：密钥 → 目录 → 探测 → 矩阵 */}
          <KeyPanel channel={channel} onError={onError} />
          <CatalogPanel channel={channel} onError={onError} onRefresh={onRefresh} />
          <ProbePanel channel={channel} onError={onError} onRefresh={onRefresh} />
          <MatrixPanel
            channel={channel}
            defaultRepeat={defaultRepeat}
            defaultIntervalMs={defaultIntervalMs}
            onError={onError}
            onRefresh={onRefresh}
          />
        </>
      )}
    </main>
  );
}
