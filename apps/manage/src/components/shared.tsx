import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  CloudCog,
  Code2,
  Copy,
  ExternalLink,
  GitBranch,
  History,
  LoaderCircle,
  Logs,
  Menu,
  Play,
  RefreshCcw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings2,
  Shield,
  Terminal,
  Workflow,
  X,
} from 'lucide-react';
import { Badge, Button, Card, Input, Section, Select, Textarea } from '../components/ui';
import { api, send } from '../lib/client';
import { sentryIssueSearch } from '../lib/sentry';
import { findDuplicateConfigKeys, planConfigChange } from '../config-reconcile';
import type { ConfigPlan } from '../config-reconcile';
import { cn, date, human, state } from '../lib/utils';
import type { Meta, Run, WF, Job, CloudLog, CfLog, Issue } from '../types';
export const External = ({ href, children }: { href?: string; children: React.ReactNode }) =>
  href && href.startsWith('https://') ? (
    <a
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      className="inline-flex items-center gap-1.5 text-sm text-slate-300 underline-offset-4 hover:text-white hover:underline"
    >
      {children}
      <ArrowUpRight size={13} />
    </a>
  ) : null;
export function Spinner() {
  return <LoaderCircle size={17} className="animate-spin text-slate-500" />;
}
export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <Card className="p-7 text-center">
      <CircleAlert className="mx-auto text-slate-600" size={25} />
      <p className="mt-3 text-sm font-medium">{title}</p>
      {detail && <p className="mt-1.5 text-xs text-slate-500">{detail}</p>}
    </Card>
  );
}
export function IssueBanner({ error }: { error: unknown }) {
  const e = error as { message?: string; code?: string; correlationId?: string; sentryEventId?: string };
  const sentryUrl = sentryIssueSearch(e.correlationId);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-red-900/50 bg-red-950/25 p-3 text-sm text-red-200"
    >
      <AlertCircle size={17} className="mt-0.5 shrink-0" />
      <div>
        {e.message || 'Serviço temporariamente indisponível'}
        {e.code && <p className="mt-1 text-xs opacity-65">{e.code}</p>}
        {e.correlationId && <p className="mt-1 break-all text-xs opacity-70">ID: {e.correlationId}</p>}
        {sentryUrl && e.sentryEventId && (
          <a
            href={sentryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-xs underline"
          >
            Ver erro no Sentry
          </a>
        )}
      </div>
    </div>
  );
}
