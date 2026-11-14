import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import type { KeyInput, PublicChannel } from '../types';

interface Row {
  id?: string;
  label: string;
  key: string; // 已有密钥留空 = 不改；新增行必填
  enabled: boolean;
  concurrency: number;
}

interface Props {
  channel: PublicChannel;
  onError: (msg: string) => void;
}

export default function KeyPanel({ channel, onError }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(channel.keys);
  const [saving, setSaving] = useState(false);

  const update = (idx: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setRows((rs) => [...rs, { label: '', key: '', enabled: true, concurrency: 1 }]);
  };

  const removeRow = (idx: number) => {
    setRows((rs) => rs.filter((_, i) => i !== idx));
  };

  const save = async () => {
    for (const r of rows) {
      if (!r.id && !r.key) {
        onError(t('key.newKeyEmpty'));
        return;
      }
    }
    setSaving(true);
    try {
      const keys: KeyInput[] = rows.map((r) => ({
        id: r.id,
        label: r.label,
        enabled: r.enabled,
        concurrency: r.concurrency,
        ...(r.key ? { key: r.key } : {}),
      }));
      await api.replaceKeys(channel.id, keys);
      const { channel: fresh } = await api.listChannels().then((res) => ({
        channel: res.channels.find((c) => c.id === channel.id)!,
      }));
      setRows(fresh.keys);
    } catch (err) {
      if (err instanceof ApiError && err.body.issues?.length) {
        const i = err.body.issues[0];
        onError(`${t('error.validation')} ${i.path}: ${i.message}`);
      } else {
        onError(t('error.save'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="key-panel">
      <div className="content-head">
        <h3>{t('key.title')}</h3>
        <div>
          <button type="button" className="ghost" onClick={addRow}>
            {t('key.add')}
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{t('key.empty')}</p>
      ) : (
        <table className="key-table">
          <thead>
            <tr>
              <th>{t('key.label')}</th>
              <th>{t('key.key')}</th>
              <th>{t('key.enabled')}</th>
              <th>{t('key.concurrency')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.id ?? `new-${idx}`}>
                <td>
                  <input
                    value={r.label}
                    onChange={(e) => update(idx, { label: e.target.value })}
                    placeholder={t('key.labelPlaceholder')}
                  />
                </td>
                <td>
                  <input
                    value={r.key}
                    onChange={(e) => update(idx, { key: e.target.value })}
                    placeholder={
                      r.id
                        ? `${r.key === '' ? t('key.keepHint') : ''}`
                        : 'sk-...'
                    }
                    className="mono"
                    autoComplete="off"
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => update(idx, { enabled: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={r.concurrency}
                    onChange={(e) =>
                      update(idx, { concurrency: Number(e.target.value) || 1 })
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => removeRow(idx)}
                  >
                    {t('key.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
          {t('key.save')}
        </button>
      </div>
    </section>
  );
}
