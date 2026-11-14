import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import type { PublicChannel } from './types';
import ChannelList from './components/ChannelList';
import ChannelEdit from './components/ChannelEdit';
import LangSwitcher from './components/LangSwitcher';
import ConfirmDialog from './components/ConfirmDialog';

type View = { mode: 'list' } | { mode: 'edit'; id: string | null };

export default function App() {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<PublicChannel[] | null>(null);
  const [view, setView] = useState<View>({ mode: 'list' });
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PublicChannel | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { channels: list } = await api.listChannels();
      setChannels(list);
      setError(null);
    } catch {
      setError(t('error.load'));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteChannel(pendingDelete.id);
      setPendingDelete(null);
      await refresh();
    } catch {
      setError(t('error.save'));
    }
  };

  const editingChannel =
    view.mode === 'edit' && view.id
      ? channels?.find((c) => c.id === view.id) ?? null
      : null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>{t('app.title')}</h1>
        <LangSwitcher />
      </header>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {view.mode === 'list' ? (
        <ChannelList
          channels={channels}
          loading={channels === null}
          onAdd={() => setView({ mode: 'edit', id: null })}
          onEdit={(id) => setView({ mode: 'edit', id })}
          onDelete={(ch) => setPendingDelete(ch)}
        />
      ) : (
        <ChannelEdit
          channel={editingChannel}
          onSaved={async (id) => {
            await refresh();
            setView({ mode: 'edit', id });
          }}
          onRefresh={refresh}
          onBack={() => setView({ mode: 'list' })}
          onError={(msg) => setError(msg)}
        />
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('channel.deleteConfirm', { name: pendingDelete?.name ?? '' })}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
