import { useTranslation } from 'react-i18next';
import type { PublicChannel } from '../types';

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
        <p>{t('common.loading')}</p>
      ) : channels && channels.length > 0 ? (
        <table className="channel-table">
          <thead>
            <tr>
              <th>{t('channel.name')}</th>
              <th>{t('channel.baseUrl')}</th>
              <th>{t('channel.enabled')}</th>
              <th>{t('channel.keysCount')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td>
                  <button type="button" className="link" onClick={() => onEdit(c.id)}>
                    {c.name}
                  </button>
                </td>
                <td className="mono">{c.baseUrl}</td>
                <td>{c.enabled ? t('common.yes') : t('common.no')}</td>
                <td>{c.keys.length}</td>
                <td>
                  <button type="button" onClick={() => onDelete(c)} className="danger">
                    {t('channel.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">{t('channel.empty')}</p>
      )}
    </main>
  );
}
