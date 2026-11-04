import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Loader2, X } from 'lucide-react';
import type { PublicUser } from '@cooprompt/protocol';
import { colorFor, initials } from '../lib/format.ts';
import { useT } from '../lib/i18n.ts';

type Variant = 'primary' | 'ghost' | 'subtle' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-50',
  ghost: 'text-dim hover:text-ink hover:bg-raised disabled:opacity-40',
  subtle: 'bg-raised text-ink hover:bg-raised-hover border border-line disabled:opacity-50',
  danger: 'bg-[#4a2624] text-[#f2b5b0] hover:bg-[#5a2d2a] border border-[#6b3431] disabled:opacity-50',
};

export function Button({ variant = 'subtle', size = 'md', busy, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  const sizing = size === 'sm' ? 'h-7 px-2.5 text-[12.5px] gap-1.5' : 'h-9 px-3.5 text-[13.5px] gap-2';
  return (
    <button {...props} disabled={props.disabled || busy} className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors cursor-default ${sizing} ${VARIANTS[variant]} ${className}`}>
      {busy && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function IconButton({ title, className = '', children, active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { title: string; active?: boolean }) {
  return (
    <button
      {...props}
      title={title}
      aria-label={title}
      className={`inline-flex size-8 items-center justify-center rounded-lg transition-colors cursor-default ${active ? 'bg-raised text-ink' : 'text-dim hover:bg-raised hover:text-ink'} disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`h-9 w-full rounded-lg border border-line bg-inset px-3 text-[13.5px] text-ink placeholder:text-faint outline-none focus:border-accent/70 ${className}`} />;
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13.5px] text-ink placeholder:text-faint outline-none focus:border-accent/70 ${className}`} />;
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`h-9 rounded-lg border border-line bg-inset px-2.5 text-[13.5px] text-ink outline-none focus:border-accent/70 ${className}`}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12.5px] font-medium text-dim">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-faint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-[13px] text-dim cursor-default">
      <span className={`relative inline-block h-5 w-9 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line'}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      {label}
    </button>
  );
}

export function Avatar({ user, size = 26, online }: { user: Pick<PublicUser, 'id' | 'name' | 'avatarUrl'>; size?: number; online?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} title={user.name}>
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt={user.name} className="size-full rounded-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        <span className="flex size-full items-center justify-center rounded-full font-semibold text-white" style={{ background: colorFor(user.id), fontSize: size * 0.4 }}>
          {initials(user.name)}
        </span>
      )}
      {online !== undefined && <span className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-app ${online ? 'bg-ok' : 'bg-faint'}`} />}
    </span>
  );
}

/** The cooperative prompt mark, shared with the application icon. */
export function Logo({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" className={`block shrink-0 ${className}`}>
      <rect x="64" y="64" width="896" height="896" rx="220" fill="#1b2838" />
      <path d="M270 374h195c55 0 98 43 98 98v93c0 55-43 98-98 98h-47l-90 66v-66h-58c-55 0-98-43-98-98v-93c0-55 43-98 98-98z" fill="#dceef7" />
      <path d="M505 289h244c55 0 98 43 98 98v93c0 55-43 98-98 98h-51l-85 63v-63H505c-55 0-98-43-98-98v-93c0-55 43-98 98-98z" fill="#66c0f4" />
      <path d="m493 383 53 47-53 47m91 0h100" fill="none" stroke="#1b2838" strokeWidth="35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'team'; children: ReactNode }) {
  const tones = {
    neutral: 'bg-raised text-dim border-line',
    accent: 'bg-accent/15 text-accent border-accent/30',
    ok: 'bg-ok/15 text-[#9ad19f] border-ok/30',
    warn: 'bg-warn/15 text-[#e1bd99] border-warn/30',
    bad: 'bg-bad/15 text-[#f0a3a3] border-bad/30',
    team: 'bg-team/15 text-team border-team/35',
  };
  return <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={`size-4 animate-spin text-dim ${className}`} />;
}

export function Modal({ title, onClose, children, width = 520, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-6" onMouseDown={onClose}>
      <div className="flex max-h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl" style={{ width }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton title={t('Close')} onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <p className="text-[14px] font-medium text-dim">{title}</p>
      {children && <div className="max-w-md text-[13px] text-faint">{children}</div>}
    </div>
  );
}
