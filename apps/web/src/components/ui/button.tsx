import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ButtonHTMLAttributes } from 'react';

const buttonVariants = cva('button', {
  variants: { variant: { default: 'button-primary', outline: 'button-outline',
    ghost: 'button-ghost', destructive: 'button-danger' },
    size: { default: '', sm: 'button-sm', icon: 'button-icon' } },
  defaultVariants: { variant: 'default', size: 'default' },
});
interface Props extends ButtonHTMLAttributes<HTMLButtonElement>,
  VariantProps<typeof buttonVariants> { asChild?: boolean }
export function Button({ className, variant, size, asChild, ...props }: Props) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={twMerge(clsx(buttonVariants({ variant, size }), className))}
    {...props} />;
}
