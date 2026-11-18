import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, logout, onUnauthorized } from './api';
import type { PublicChannel, TestDefaults } from './types';
import ChannelList from './components/ChannelList';
import ChannelEdit from './components/ChannelEdit';
import LangSwitcher from './components/LangSwitcher';
import ConfirmDialog from './components/ConfirmDialog';
import LoginModal from './components/LoginModal';
import GistModal from './components/GistModal';
import { BrandIcon } from './components/icons';

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
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [gistOpen, setGistOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<unknown | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);

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
      const { channels: list, testDefaults: td, authRequired: ar } = await api.listChannels();
      setChannels(list);
      setTestDefaults(td);
      setAuthRequired(ar);
      setError(null);
    } catch {
      setError(t('error.load'));
    }
  }, [t]);

  // M8 §15.1：401 → 弹登录框；登录成功后 api 内部唤醒 loginWaiter 重放原请求。
  // 竞态修复：同一 effect 内先注册 onUnauthorized、后发首请求，顺序有保证；
  // 注册前窗口到达的 401 由 api 记待处理态、注册时立即触发
  useEffect(() => {
    onUnauthorized(() => setLoginOpen(true));
    void refresh();
    return () => onUnauthorized(null);
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

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

  const handleExport = async () => {
    try {
      const data = await api.exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `api-check_backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setNotice(t('backup.exportFailed'));
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as { config?: { channels?: unknown } };
      if (!Array.isArray(data?.config?.channels)) throw new Error('invalid backup');
      setPendingImport(data);
    } catch {
      setNotice(t('backup.importInvalid'));
    }
  };

  const handleImport = async () => {
    if (pendingImport === null) return;
    try {
      const r = await api.importBackup(pendingImport);
      setPendingImport(null);
      await refresh();
      setNotice(t('backup.imported', { n: r.imported, skipped: r.skipped }));
    } catch {
      setPendingImport(null);
      setNotice(t('backup.importFailed'));
    }
  };

  const handleReorder = async (ids: string[]) => {
    setChannels((cs) => {
      if (!cs) return cs;
      const byId = new Map(cs.map((c) => [c.id, c]));
      return ids.map((id) => byId.get(id)).filter((c): c is PublicChannel => Boolean(c));
    });
    try {
      await api.reorderChannels(ids);
    } catch {
      setError(t('channel.reorderFailed'));
      await refresh();
    }
  };

  const handleLogout = () => {
    logout();
    window.location.reload();
  };

  const editingChannel =
    view.mode === 'edit' && view.id
      ? channels?.find((c) => c.id === view.id) ?? null
      : null;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <h1 className="brand">
            <span className="brand-mark">
              <BrandIcon />
            </span>
            api-check
            <small>{t('app.title')}</small>
          </h1>
          <div className="hd-actions">
            <button type="button" onClick={() => void handleExport()}>
              {t('backup.export')}
            </button>
            <button type="button" onClick={() => importInput.current?.click()}>
              {t('backup.import')}
            </button>
            <button type="button" onClick={() => setGistOpen(true)}>
              {t('gist.open')}
            </button>
            {authRequired === true && (
              <button type="button" onClick={handleLogout}>
                {t('auth.logout')}
              </button>
            )}
            <LangSwitcher />
          </div>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
              e.target.value = '';
            }}
          />
        </div>
      </header>
      <div className="app">
      {authRequired === false && (
        <div className="warning-banner" role="alert">
          {t('settings.noPasswordWarn')}
        </div>
      )}
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
            onReorder={(ids) => void handleReorder(ids)}
          />
      ) : channels === null ? (
        // hash 恢复编辑视图时等数据就绪再挂载编辑页，避免按「新建」初始化后不回填
        <p className="loading-hint"><span className="spinner" aria-hidden="true" />{t('common.loading')}</p>
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
      <ConfirmDialog
        open={pendingImport !== null}
        title={t('backup.importConfirm')}
        onConfirm={() => void handleImport()}
        onCancel={() => setPendingImport(null)}
      />
      <GistModal open={gistOpen} onClose={() => setGistOpen(false)} />
      <LoginModal open={loginOpen} onSuccess={() => setLoginOpen(false)} />
      {notice && <div className="toast" role="status">{notice}</div>}
      </div>
    </>
  );
}
