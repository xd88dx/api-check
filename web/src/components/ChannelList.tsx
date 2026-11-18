import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PublicChannel } from '../types';
import EmptyState from './EmptyState';
import { GripIcon, TrashIcon } from './icons';

interface Props {
  channels: PublicChannel[] | null;
  loading: boolean;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (ch: PublicChannel) => void;
  onReorder: (ids: string[]) => void;
}

export default function ChannelList({
  channels,
  loading,
  onAdd,
  onEdit,
  onDelete,
  onReorder,
}: Props) {
  const { t } = useTranslation();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragEndedAt = useRef(0);

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId || !channels) return;
    const ids = channels.map((c) => c.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    onReorder(ids);
  };
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
              <th className="drag-cell" />
              <th>{t('channel.name')}</th>
              <th>{t('channel.enabled')}</th>
              <th>{t('channel.keysCount')}</th>
              <th className="col-ops" />
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => (
              <tr
                key={c.id}
                draggable
                tabIndex={0}
                className={`${dragId === c.id ? 'dragging' : ''} ${
                  overId === c.id && dragId !== c.id ? 'drop-target' : ''
                }`}
                onDragStart={(e) => {
                  setDragId(c.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (overId !== c.id) setOverId(c.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(c.id);
                  setDragId(null);
                  setOverId(null);
                }}
                onDragEnd={() => {
                  dragEndedAt.current = Date.now();
                  setDragId(null);
                  setOverId(null);
                }}
                onClick={() => {
                  if (Date.now() - dragEndedAt.current < 200) return;
                  onEdit(c.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onEdit(c.id);
                  }
                }}
              >
                <td
                  className="drag-cell"
                  title={t('channel.drag')}
                  onClick={(e) => e.stopPropagation()}
                >
                  <GripIcon />
                </td>
                <td>
                  <span className="row-name">{c.name}</span>
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
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(c);
                    }}
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
