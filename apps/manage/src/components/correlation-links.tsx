import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, Link2 } from 'lucide-react';
import { api } from '../lib/client';
import type { Meta } from '../types';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT = /^[a-f0-9]{32}$/i;
const PROJECT = /^[a-z][a-z0-9-]{3,62}$/;

export function isCorrelationKey(key: string): boolean {
  return /(?:^|[._-])correlation[_-]?id$|correlationId$/i.test(key);
}

export function correlationExplorerUrl(id: string, project = 'photointel'): string | null {
  if (!UUID.test(id) || !PROJECT.test(project)) return null;
  const query = 'SEARCH("' + id + '")';
  return (
    'https://console.cloud.google.com/logs/query;query=' +
    encodeURIComponent(query) +
    ';duration=P7D?project=' +
    encodeURIComponent(project)
  );
}

export function correlationSentryUrl(id: string, org: string | undefined): string | null {
  if (!UUID.test(id) || !org || !ORG.test(org)) return null;
  return 'https://' + org + '.sentry.io/issues/?query=' +
    encodeURIComponent('tags[correlation_id]:' + id);
}

export function correlationCloudflareUrl(accountId: string | undefined): string | null {
  if (!accountId || !ACCOUNT.test(accountId)) return null;
  // Cloudflare does not document a reliable URL query parameter for an ad-hoc
  // search. Link directly to Observability and offer a filtered Manage link.
  return 'https://dash.cloudflare.com/' + accountId + '/workers/observability';
}

export function correlationManageUrl(id: string, source: 'cloudflare' | 'gcp'): string {
  return '/?tab=logs&source=' + source + '&correlation=' + encodeURIComponent(id);
}

function ProviderLinks({ id }: { id: string }) {
  const { data: meta, isPending } = useQuery({
    queryKey: ['meta'],
    queryFn: () => api<Meta>('/meta'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const sentry = correlationSentryUrl(id, meta?.sentry_org);
  const gcp = correlationExplorerUrl(id, meta?.project);
  const cloudflare = correlationCloudflareUrl(meta?.cloudflare_account_id);
  const links = [
    { title: 'Sentry · eventos com esta tag', url: sentry },
    { title: 'Google Cloud · Logs Explorer', url: gcp },
    { title: 'Cloudflare · Observability', url: cloudflare },
    { title: 'Cloudflare · busca filtrada no Manage', url: correlationManageUrl(id, 'cloudflare') },
    { title: 'GCP · busca filtrada no Manage', url: correlationManageUrl(id, 'gcp') },
  ];
  return (
    <>
      <div className="px-3 py-2">
        <p className="text-xs font-semibold text-slate-100">Investigar correlation ID</p>
        <p className="mt-1 select-all break-all font-mono text-[11px] text-slate-400">{id}</p>
      </div>
      <DropdownMenu.Separator className="my-1 h-px bg-slate-700/70" />
      {isPending && <p className="px-3 py-2 text-xs text-slate-400">Carregando integrações…</p>}
      {links.filter((link) => link.url).map((link) => (
        <DropdownMenu.Item key={link.title} asChild>
          <a
            href={link.url!}
            target={link.url!.startsWith('/') ? '_self' : '_blank'}
            rel="noopener noreferrer"
            className="flex min-h-10 items-center justify-between gap-3 rounded-md px-3 py-2 text-xs text-slate-200 outline-none hover:bg-slate-800 focus:bg-slate-800"
          >
            <span>{link.title}</span>
            <ExternalLink size={13} className="shrink-0" />
          </a>
        </DropdownMenu.Item>
      ))}
      <DropdownMenu.Item
        className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs text-slate-200 outline-none hover:bg-slate-800 focus:bg-slate-800"
        onSelect={() => void navigator.clipboard?.writeText(id)}
      >
        <Copy size={13} />
        Copiar correlation ID
      </DropdownMenu.Item>
      <p className="px-3 pb-2 text-[11px] leading-4 text-slate-500">
        Sentry pesquisa a tag correlation_id. Cloudflare abre o painel nativo;
        a busca com ID pré-preenchido fica no Manage.
      </p>
    </>
  );
}

/** A popover with safe, provider-specific investigation links for a verified UUID. */
export function CorrelationPopover({ id }: { id: string }) {
  if (!UUID.test(id)) return <>{id}</>;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="correlation-trigger inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 font-mono text-sky-300 underline decoration-dotted underline-offset-2 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2"
          aria-label={'Investigar correlation ID ' + id}
        >
          <span className="min-w-0 break-all">{id}</span>
          <Link2 size={13} className="shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          collisionPadding={12}
          side="bottom"
          align="start"
          className="correlation-popover z-[100] w-[min(340px,calc(100vw-24px))] max-h-[min(75dvh,480px)] overflow-y-auto rounded-xl border border-slate-700 bg-[#191b1f] p-1 shadow-2xl"
        >
          <ProviderLinks id={id} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
