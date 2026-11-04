import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';
import { useT } from '../lib/i18n.ts';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <button
        className="absolute right-2 top-2 hidden rounded-md bg-raised p-1.5 text-dim hover:text-ink group-hover:block cursor-default"
        title={t('Copy')}
        onClick={() => {
          void navigator.clipboard.writeText(textOf(children));
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

/** Web images load; a local path never becomes a file:// load (the files a turn shares appear below its answer). */
function SafeImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  if (typeof src === 'string' && /^(https:\/\/|data:image\/)/i.test(src)) return <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" />;
  return alt ? <span className="text-faint">[{alt}]</span> : null;
}

export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`prose-cooprompt ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={{ pre: CodeBlock, img: SafeImage }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
