import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, onUnauthorized } from './api';
import type { PublicChannel, TestDefaults } from './types';
import ChannelList from './components/ChannelList';
import ChannelEdit from './components/ChannelEdit';
import LangSwitcher from './components/LangSwitcher';
import ConfirmDialog from './components/ConfirmDialog';
import LoginModal from './components/LoginModal';

type View = { mode: 'list' } | { mode: 'edit'; id: string | null };

/** M5 §12.6：视图持久化到 location.hash（#/list、#/channel/<id>、#/channel/new） */
function viewFromHash(): View {
  try {
    const m = /^#\/channel\/([^/]+)$/.exec(window.location.hash);
    if (m) {
      const id = decodeURIComponent(m[1]);
      return { mode: 'edit', id: id === 'new' ? null : id };
    }
  } catch {
    // hash 异常时回落列表
  }
  return { mode: 'list' };
}

function hashFromView(v: View): string {
  if (v.mode === 'edit') {
    return v.id ? `#/channel/${encodeURIComponent(v.id)}` : '#/channel/new';
  }
  return '#/list';
}

export default function App() {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<PublicChannel[] | null>(null);
  const [testDefaults, setTestDefaults] = useState<TestDefaults | null>(null);
  const [view, setView] = useState<View>(viewFromHash);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PublicChannel | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  // M8 §15.1：401 → 弹登录框；登录成功后 api 内部唤醒 loginWaiter 重放原请求
  useEffect(() => {
    onUnauthorized(() => setLoginOpen(true));
    return () => onUnauthorized(null);
  }, []);

  // 视图变化写入 hash（replaceState：不产生多余历史记录、不触发滚动）
  useEffect(() => {
    try {
      window.history.replaceState(null, '', hashFromView(view));
    } catch {
      // 忽略（如 file:// 等受限环境）
    }
  }, [view]);

  const refresh = useCallback(async () => {
    try {
      const { channels: list, testDefaults: td } = await api.listChannels();
      setChannels(list);
      setTestDefaults(td);
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
      ) : channels === null ? (
        // hash 恢复编辑视图时等数据就绪再挂载编辑页，避免按「新建」初始化后不回填
        <p className="loading-hint">{t('common.loading')}</p>
      ) : (
        <ChannelEdit
          channel={editingChannel}
          defaultRepeat={testDefaults?.repeat ?? 1}
          defaultIntervalMs={testDefaults?.intervalMs ?? 1000}
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
      <LoginModal open={loginOpen} onSuccess={() => setLoginOpen(false)} />
    </div>
  );
}
