import { Dialog as FluentDialog, type DialogProps } from '@fluentui/react-components';

/**
 * Fluent's Dialog, except that a click on the dimmed page behind it does nothing. Fluent closes a modal dialog on that click, so a
 * stray click lost everything typed into a form (bug report "New Bug Report Issue"). Escape, Cancel and Close still close it.
 * Every dialog in the app uses this one: import Dialog from here, not from Fluent.
 */
export function Dialog({ onOpenChange, ...props }: DialogProps) {
  return (
    <FluentDialog
      {...props}
      onOpenChange={(event, data) => {
        if (data.type === 'backdropClick') return;
        onOpenChange?.(event, data);
      }}
    />
  );
}
