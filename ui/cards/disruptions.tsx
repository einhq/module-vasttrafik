import { Skeleton } from '@mantine/core';
import { usePolledCommand } from '@ein/ui/hooks';
import { formatDate, formatTime, shq } from '@ein/ui/lib';
import { useSearchParams } from 'react-router-dom';
import type { VtDisruption, VtDisruptions } from '../../lib/api.ts';
import { whenDue } from '../components/fresh.ts';
import { Badge, Quiet } from '../components/parts.tsx';
import './cards.css';

/** Asked again as soon as the server's answer is due, which it says; this often when it has none. */
const POLL_MS = 60_000;

/** `until 30 Nov`, or `until 14:30` for one that ends today; `starts 22 Nov 07:00` for one that has not begun. */
const span = (one: VtDisruption, now: number): string => {
  const day = (at: Date) => formatDate(at, { day: 'numeric', month: 'short' });
  const time = (at: Date) => formatTime(at, { hour: '2-digit', minute: '2-digit' });
  const start = new Date(one.start);
  if (start.getTime() > now) return `starts ${day(start)} ${time(start)}`;
  if (!one.end) return 'until further notice';
  const end = new Date(one.end);
  return `until ${end.toDateString() === new Date(now).toDateString() ? time(end) : day(end)}`;
};

/**
 * `/cards/vasttrafik/disruptions`: what Västtrafik says disrupts some stops (`stops`) or some
 * `lines` (by gid): each disruption's lines, its title, until when it lasts, and, when `details`
 * is on, what it says further. The worst first; `ahead` hours also takes those about to start.
 * Asked again as soon as the server's answer is due.
 */
export default function DisruptionsCard() {
  const [params] = useSearchParams();
  const stops = params.getAll('stops');
  const lines = params.getAll('lines');
  const ahead = Math.min(Math.max(Number(params.get('ahead') ?? 0) || 0, 0), 168);
  const details = params.get('details') !== 'false';
  const command = [
    'vt-disruptions',
    ...(stops.length ? [`--stop ${shq(stops.join(','))}`] : []),
    ...(lines.length ? [`--line ${shq(lines.join(','))}`] : []),
    ...(ahead ? [`--ahead ${ahead}`] : []),
  ].join(' ');
  const answer = usePolledCommand<VtDisruptions>(command, stops.length + lines.length > 0, POLL_MS, (answer) => whenDue(answer.freshMs));

  if (!answer.data) {
    if (!answer.error) return <Skeleton height='70%' radius='md' />;
    return <Quiet icon='alert-triangle'>{answer.error.message.replace(/^vt-disruptions: /, '')}</Quiet>;
  }
  const now = Date.now();
  if (answer.data.disruptions.length === 0) return <Quiet icon='circle-check'>Västtrafik reports no disruptions here</Quiet>;
  return (
    <div className='vt-board vt-disruptions'>
      {answer.data.disruptions.map((one) => (
        <div key={one.id} className={`vt-disruption vt-${one.severity}`}>
          {one.lines.length > 0 && (
            <div className='vt-lines'>
              {one.lines.map((line) => <Badge key={line.gid ?? line.designation} line={line} />)}
            </div>
          )}
          <div className='vt-title'>{one.title}</div>
          {details && one.description && <div className='vt-description'>{one.description}</div>}
          <div className='vt-span'>{span(one, now)}</div>
        </div>
      ))}
    </div>
  );
}
