import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api';
import type { KeyInput, PublicChannel, PublicKey } from '../types';
import EmptyState from './EmptyState';
import { CopyIcon, EyeIcon, EyeOffIcon, TrashIcon } from './icons';

interface Row {
  id?: string;
  label: string;
  key: string; // 编辑缓冲：已有行空串起步（掩码绝不回填），留空 = 不修改
  maskHint: string; // 已有行的掩码形态，仅用于 placeholder 展示
  enabled: boolean;
  concurrency: number;
}

/** 由 API 行构造编辑行：key 编辑框一律空串起步，掩码只进 placeholder，绝不回填提交 */
function toRows(keys: PublicKey[]): Row[] {
  return keys.map((k) => ({
    id: k.id,
    label: k.label,
    key: '',
    maskHint: k.key,
    enabled: k.enabled,
    concurrency: k.concurrency,
  }));
}

interface Props {
  channel: PublicChannel;
  onError: (msg: string) => void;
}

export default function KeyPanel({ channel, onError }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(toRows(channel.keys));
  const [saving, setSaving] = useState(false);
  // M6 §13.2：揭示态缓存（keyId -> 明文）；复制成功反馈
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({});
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const update = (idx: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const toggleReveal = async (keyId: string) => {
    if (revealedKeys[keyId] !== undefined) {
      setRevealedKeys((m) => {
        const { [keyId]: _drop, ...rest } = m;
        return rest;
      });
      return;
    }
    try {
      const { key } = await api.getKeyPlaintext(channel.id, keyId);
      setRevealedKeys((m) => ({ ...m, [keyId]: key }));
    } catch {
      onError(t('key.revealFailed'));
    }
  };

  const copyKey = async (keyId: string) => {
    try {
      const plain = revealedKeys[keyId] ?? (await api.getKeyPlaintext(channel.id, keyId)).key;
      await navigator.clipboard.writeText(plain);
      setCopiedKeyId(keyId);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedKeyId(null), 1500);
    } catch {
      onError(t('key.copyFailed'));
    }
  };

  const addRow = () => {
    setRows((rs) => [...rs, { label: '', key: '', maskHint: '', enabled: true, concurrency: 1 }]);
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
      const keys: KeyInput[] = rows.map((r) => {
        // 揭示态保存以缓存的明文为准；掩码态编辑框为空 → 不携带 key 字段（后端视为未修改）
        const kv = r.id && revealedKeys[r.id] !== undefined ? revealedKeys[r.id]! : r.key;
        return {
          id: r.id,
          label: r.label,
          enabled: r.enabled,
          concurrency: r.concurrency,
          ...(kv ? { key: kv } : {}),
        };
      });
      await api.replaceKeys(channel.id, keys);
      const { channel: fresh } = await api.listChannels().then((res) => ({
        channel: res.channels.find((c) => c.id === channel.id)!,
      }));
      setRows(toRows(fresh.keys));
      setRevealedKeys({});
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
        <EmptyState text={t('key.empty')} />
      ) : (
        <div className="table-wrap">
        <table className="key-table">
          <thead>
            <tr>
              <th>{t('key.label')}</th>
              <th>{t('key.key')}</th>
              <th>{t('key.enabled')}</th>
              <th>{t('key.concurrency')}</th>
              <th className="col-ops" />
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
                  <div className="key-cell">
                    <input
                      value={r.id && revealedKeys[r.id] !== undefined ? revealedKeys[r.id]! : r.key}
                      onChange={(e) => {
                        const v = e.target.value;
                        update(idx, { key: v });
                        if (r.id && revealedKeys[r.id] !== undefined) {
                          setRevealedKeys((m) => ({ ...m, [r.id!]: v }));
                        }
                      }}
                      placeholder={
                        r.id
                          ? `${r.maskHint || ''}${r.maskHint ? ' · ' : ''}${t('key.keepHint')}`
                          : 'sk-...'
                      }
                      className="mono"
                      autoComplete="off"
                    />
                    {r.id && (
                      <span className="key-cell-tools">
                        <button
                          type="button"
                          className="icon-btn"
                          title={revealedKeys[r.id] !== undefined ? t('key.hide') : t('key.reveal')}
                          aria-label={revealedKeys[r.id] !== undefined ? t('key.hide') : t('key.reveal')}
                          onClick={() => void toggleReveal(r.id!)}
                        >
                          {revealedKeys[r.id] !== undefined ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title={t('key.copy')}
                          aria-label={t('key.copy')}
                          onClick={() => void copyKey(r.id!)}
                        >
                          <CopyIcon />
                        </button>
                        {copiedKeyId === r.id && (
                          <span className="copy-feedback">{t('common.copied')}</span>
                        )}
                      </span>
                    )}
                  </div>
                </td>
                <td className="check-cell">
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
                <td className="col-ops">
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={t('key.delete')}
                    aria-label={t('key.delete')}
                    onClick={() => removeRow(idx)}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="actions">
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
          {t('key.save')}
        </button>
      </div>
    </section>
  );
}
