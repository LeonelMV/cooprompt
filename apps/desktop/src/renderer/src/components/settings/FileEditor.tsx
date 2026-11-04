import { useEffect, useState } from 'react';
import { call } from '../../lib/api.ts';
import { useT } from '../../lib/i18n.ts';
import { useStore } from '../../lib/store.ts';
import { Button, Modal, Spinner } from '../ui.tsx';

export function FileEditor({ path, title, template = '', onClose }: { path: string; title: string; template?: string; onClose: () => void }) {
  const t = useT();
  const toast = useStore((state) => state.toast);
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call('catalog.read', path)
      .then((value) => setContent(value || template))
      .catch((error) => {
        toast('error', error.message);
        onClose();
      });
  }, [path, template, toast, onClose]);
  const save = async () => {
    setBusy(true);
    try {
      await call('catalog.write', { path, content: content ?? '' });
      toast('info', t('Saved'));
      onClose();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={860}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <p className="mb-2 break-all font-mono text-[11.5px] text-faint">{path}</p>
      {content === null ? (
        <Spinner />
      ) : (
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          spellCheck={false}
          className="h-[460px] w-full resize-none rounded-lg border border-line bg-side p-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none"
        />
      )}
    </Modal>
  );
}
