import { useTranslation } from 'react-i18next';
import type { PublicChannel } from '../types';
import EmptyState from './EmptyState';
import { TrashIcon } from './icons';

interface Props {
  channels: PublicChannel[] | null;
  loading: boolean;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (ch: PublicChannel) => void;
}

export default function ChannelList({
  channels,
  loading,
  onAdd,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  return (
    <main className="content">
      <div className="content-head">
        <h2>{t('channel.title')}</h2>
        <button type="button" className="primary" onClick={onAdd}>
          {t('channel.add')}
        </button>
      </div>
      {loading ? (
        <div className="skeleton-list" aria-label={t('common.loading')} role="status">
          {[0, 1, 2].map((i) => (
            <div className="skeleton-row" key={i}>
              <span className="skeleton skeleton-title" />
              <span className="skeleton skeleton-sub" />
              <span className="skeleton skeleton-pill" />
            </div>
          ))}
        </div>
      ) : channels && channels.length > 0 ? (
        <div className="table-wrap">
        <table className="channel-table">
          <thead>
            <tr>
              <th>{t('channel.name')}</th>
              <th>{t('channel.enabled')}</th>
              <th>{t('channel.keysCount')}</th>
              <th className="col-ops" />
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>
                  <button type="button" className="link row-name" onClick={() => onEdit(c.id)}>
                    {c.name}
                  </button>
                  <span className="row-sub mono">{c.baseUrl}</span>
                </td>
                <td>
                  <span className={`status-pill ${c.enabled ? 'on' : 'off'}`}>
                    {c.enabled ? t('channel.statusOn') : t('channel.statusOff')}
                  </span>
                </td>
                <td><span className="count-pill">{c.keys.length}</span></td>
                <td className="col-ops">
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={t('channel.delete')}
                    aria-label={t('channel.delete')}
                    onClick={() => onDelete(c)}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <EmptyState text={t('channel.empty')} />
      )}
    </main>
  );
}
