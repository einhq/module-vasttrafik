import { TablerIcon } from '@ein/ui/components';
import type { ReactNode } from 'react';
import type { VtLine } from '../../lib/api.ts';

/** A line's badge in its own colours. */
export const Badge = ({ line }: { line: VtLine }) => (
  <span className='vt-badge' style={{ background: line.background, color: line.foreground, borderColor: line.border ?? line.background }}>
    {line.designation}
  </span>
);

/** A card with nothing to list, or an error, said under an icon. */
export const Quiet = ({ icon, children }: { icon: string; children: ReactNode }) => (
  <div className='vt-quiet'>
    <TablerIcon name={icon} size={26} stroke={1.5} />
    <span>{children}</span>
  </div>
);
