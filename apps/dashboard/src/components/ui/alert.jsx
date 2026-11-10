import * as React from 'react';
import { cn } from '@/lib/utils';

const Alert = React.forwardRef(({ className, variant = 'default', ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(
      'relative w-full rounded-lg border px-4 py-3 text-sm',
      variant === 'destructive'
        ? 'border-destructive/50 bg-destructive/10 text-destructive'
        : 'border-amber-300 bg-amber-50 text-amber-900',
      className,
    )}
    {...props}
  />
));
Alert.displayName = 'Alert';

export { Alert };
