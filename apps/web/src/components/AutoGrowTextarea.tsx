import { useLayoutEffect, useRef } from 'react';
import { Textarea, type TextareaProps } from '@fluentui/react-components';

/**
 * A text box that grows with what is typed, so nothing is hidden behind a scroll bar. It starts `minRows` tall and stops growing at
 * `maxHeight` (then scrolls). Same props as Fluent's Textarea.
 */
export function AutoGrowTextarea({ value, minRows = 3, maxHeight = 480, ...rest }: TextareaProps & { value: string; minRows?: number; maxHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);
  return <Textarea {...rest} ref={ref} value={value} rows={minRows} resize="none" style={{ width: '100%', ...rest.style }} />;
}
