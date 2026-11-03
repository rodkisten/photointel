import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

// ==========================================
// Button
// ==========================================

const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:pointer-events-none disabled:opacity-40 active:scale-[.98]',
  {
    variants: {
      variant: {
        default: 'bg-white text-black hover:bg-slate-200',
        secondary: 'bg-slate-800 text-slate-100 hover:bg-slate-700',
        outline: 'border border-slate-700 bg-transparent text-slate-100 hover:bg-slate-800',
        ghost: 'text-slate-300 hover:bg-slate-800/80 hover:text-white',
        destructive: 'bg-red-950 text-red-200 hover:bg-red-900',
      },
      size: {
        default: 'h-10 px-4 text-sm',
        xsm: 'h-7 px-1 text-[10px]',
        sm: 'h-9 px-3 text-xs',
        icon: 'h-10 w-10',
        lg: 'h-11 px-5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, variant, size, className, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = 'Button';

// ==========================================
// Card
// ==========================================

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-xl border border-slate-800 bg-slate-950 shadow-lg shadow-black/20', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

// ==========================================
// Badge
// ==========================================

const badgeColors = {
  neutral: 'bg-white/10 text-slate-300',
  success: 'bg-emerald-500/10 text-emerald-400',
  danger: 'bg-red-500/10 text-red-400',
  warning: 'bg-amber-500/10 text-amber-400',
  info: 'bg-sky-500/10 text-sky-400',
} as const;

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof badgeColors;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ tone = 'neutral', className, children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide',
          badgeColors[tone],
          className,
        )}
        {...props}
      >
        {children}
      </span>
    );
  },
);
Badge.displayName = 'Badge';

// ==========================================
// Inputs & Forms
// ==========================================

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white outline-none transition-colors placeholder:text-slate-500 focus-visible:border-slate-500 md:text-sm',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-white outline-none transition-colors focus-visible:border-slate-500 md:text-sm',
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[80px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 font-mono text-[13px] leading-6 text-slate-200 outline-none transition-colors focus-visible:border-slate-500',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

// ==========================================
// Section Layout
// ==========================================

export interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}

export const Section = React.forwardRef<HTMLElement, SectionProps>(
  ({ title, detail, action, children, className, ...props }, ref) => {
    return (
      <section ref={ref} className={cn('space-y-3', className)} {...props}>
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight text-slate-100">{title}</h2>
            {detail && <p className="text-xs text-slate-400">{detail}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {children}
      </section>
    );
  },
);
Section.displayName = 'Section';
