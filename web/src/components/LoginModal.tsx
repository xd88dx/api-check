import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { login, notifyLoginSuccess } from '../api';

interface Props {
  open: boolean;
  /** 登录成功后由 App 关闭弹窗（重放由 api 内部 loginWaiter 完成） */
  onSuccess?: () => void;
}

/** M8 §15.1：登录 modal（密码即凭据，无 session/token）；成功后重放请求 */
export default function LoginModal({ open, onSuccess }: Props) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr(false);
    try {
      const ok = await login(password);
      if (ok) {
        setPassword('');
        notifyLoginSuccess();
        onSuccess?.();
      } else {
        setErr(true);
      }
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>{t('login.title')}</h3>
        <p>{t('login.hint')}</p>
        <input
          type="password"
          value={password}
          placeholder={t('login.placeholder')}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        {err && <div className="form-error">{t('login.wrong')}</div>}
        <div className="modal-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
            {t('login.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
