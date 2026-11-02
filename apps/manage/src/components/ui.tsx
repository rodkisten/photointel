import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';
const variants = cva(
  'inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:pointer-events-none disabled:opacity-40 active:scale-[.98]',
  {
    variants: {
      variant: {
        default: 'bg-white text-black hover:bg-slate-200',
        secondary: 'bg-[#26282c] text-slate-100 hover:bg-[#303237]',
        outline: 'border border-[#373a40] bg-transparent text-slate-100 hover:bg-[#24262a]',
        ghost: 'text-slate-300 hover:bg-[#202227] hover:text-white',
        destructive: 'bg-red-950 text-red-200 hover:bg-red-900',
      },
      size: { default: 'h-10 px-4 text-sm', sm: 'h-9 px-3 text-xs', icon: 'h-10 w-10', lg: 'h-11 px-5' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
export function Button({
  asChild = false,
  variant,
  size,
  className,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(variants({ variant, size }), className)} {...props} />;
}
export const Card = ({ className, ...p }: React.ComponentProps<'div'>) => (
  <div
    className={cn('rounded-xl border border-[#282a2e] bg-[#141517] shadow-[0_6px_18px_#0002]', className)}
    {...p}
  />
);
export const Badge = ({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'info';
  children: React.ReactNode;
}) => {
  const colors = {
    neutral: 'bg-white/10 text-slate-300',
    success: 'bg-emerald-500/10 text-emerald-300',
    danger: 'bg-red-500/10 text-red-300',
    warning: 'bg-amber-500/10 text-amber-300',
    info: 'bg-sky-500/10 text-sky-300',
  };
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wide',
        colors[tone],
      )}
    >
      {children}
    </span>
  );
};
export const Input = ({ className, ...props }: React.ComponentProps<'input'>) => (
  <input
    className={cn(
      'h-10 w-full min-w-0 rounded-lg border border-[#35383e] bg-[#191b1e] px-3 text-base text-white outline-none transition-colors placeholder:text-slate-500 focus:border-slate-500 md:text-sm',
      className,
    )}
    {...props}
  />
);
export const Select = ({ className, ...props }: React.ComponentProps<'select'>) => (
  <select
    className={cn(
      'h-10 w-full min-w-0 rounded-lg border border-[#35383e] bg-[#191b1e] px-3 text-base text-white outline-none focus:border-slate-500 md:text-sm',
      className,
    )}
    {...props}
  />
);
export const Textarea = ({ className, ...props }: React.ComponentProps<'textarea'>) => (
  <textarea
    className={cn(
      'w-full rounded-lg border border-[#35383e] bg-[#101112] px-3 py-3 font-mono text-[13px] leading-6 text-slate-200 outline-none focus:border-slate-500',
      className,
    )}
    {...props}
  />
);
export function Section({
  title,
  detail,
  action,
  children,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {detail && <p className="mt-0.5 text-xs text-slate-500">{detail}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
