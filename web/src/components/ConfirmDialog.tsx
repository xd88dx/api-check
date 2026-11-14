import { useTranslation } from 'react-i18next';

interface Props {
  open: boolean;
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ open, title, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <p>{title}</p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
