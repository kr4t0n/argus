import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-tertiary disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // The "default" (primary) variant is intentionally inverted —
        // a high-contrast filled button that pops against the page.
        // In dark theme that's a near-white button with dark text;
        // in light theme it's a near-black button with white text.
        // dark: prefixes do the inversion in one step.
        default:
          'bg-neutral-900 text-white hover:bg-black dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white',
        outline:
          'border border-default bg-transparent text-fg-primary hover:bg-surface-2/60',
        ghost: 'bg-transparent text-fg-primary hover:bg-surface-2/60',
        subtle: 'bg-surface-2/60 text-fg-primary hover:bg-surface-2',
        danger: 'bg-red-500/90 text-white hover:bg-red-500',
      },
      size: {
        sm: 'h-7 px-2.5',
        md: 'h-9 px-3.5',
        lg: 'h-10 px-4',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
