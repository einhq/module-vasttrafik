import { Skeleton } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { VtDeparture, VtDepartures, VtDisruption, VtDisruptions } from '../../lib/api.ts';
import { whenDue } from '../components/fresh.ts';
import { Badge, Quiet } from '../components/parts.tsx';
import './cards.css';

/** Asked again as soon as the server's answer is due, which it says; this often when it has none. */
const POLL_MS = 20_000;

/** The time now, ticking every few seconds so the minutes count down between answers. */
const useNow = (everyMs = 5_000): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
};

/** When it leaves: minutes from now, or the stop's clock, with the planned time struck out when that has moved. */
const When = ({ departure, now, clock }: { departure: VtDeparture; now: number; clock: boolean }) => {
  const expected = departure.estimated ?? departure.planned;
  const moved = expected.slice(11, 16) !== departure.planned.slice(11, 16);
  if (clock) {
    return (
      <span className='vt-time'>
        {moved && <span className='vt-planned'>{departure.planned.slice(11, 16)}</span>}
        {expected.slice(11, 16)}
      </span>
    );
  }
  const minutes = Math.floor((Date.parse(expected) - now) / 60_000);
  return <span className='vt-time'>{minutes <= 0 ? 'now' : `${minutes} min`}</span>;
};

/** Disruptions are asked for again as soon as the server's answer is due; this often when it has none. */
const DISRUPTIONS_POLL_MS = 60_000;

/** A disruption's mark: a warning, its titles on hover. */
const Mark = ({ about }: { about: VtDisruption[] }) => (
  <span className='vt-mark' title={about.map((one) => one.title).join('\n')}>
    <TablerIcon name='alert-triangle' size='0.9em' stroke={2} />
  </span>
);

/**
 * `/cards/vasttrafik/departures`: the next departures from a stop (`stop`), of some `lines` and
 * `platforms` when given, at most `limit`, each with its line's badge, where it goes, its platform,
 * and the minutes until it leaves as Västtrafik now expects it, or the time when `time` is `clock`.
 * A cancelled one is struck out, and a line that Västtrafik says is disrupted, or the stop, has a
 * warning mark. Asked again as soon as the server's answer is due, as old as Västtrafik's settings
 * say; the minutes count down between.
 */
export default function DeparturesCard() {
  const [params] = useSearchParams();
  const stop = params.get('stop') ?? '';
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 6) || 6, 1), 20);
  const clock = params.get('time') === 'clock';
  const command = [
    `vt-departures ${shq(stop)} --limit ${limit}`,
    ...params.getAll('lines').map((line) => `--line ${shq(line)}`),
    ...params.getAll('platforms').map((platform) => `--platform ${shq(platform)}`),
  ].join(' ');
  const answer = usePolledCommand<VtDepartures[]>(command, stop !== '', POLL_MS, (answer) => whenDue(answer[0]?.freshMs));
  const now = useNow();

  const board = answer.data?.[0];
  const lineGids = [...new Set(board?.departures.map((departure) => departure.line.gid).filter((gid) => gid !== undefined))].sort();
  const disrupted = usePolledCommand<VtDisruptions>(
    `vt-disruptions --stop ${shq(stop)}${lineGids.length ? ` --line ${shq(lineGids.join(','))}` : ''}`,
    board !== undefined,
    DISRUPTIONS_POLL_MS,
    (answer) => whenDue(answer.freshMs),
  ).data?.disruptions ?? [];
  const onLine = (departure: VtDeparture) => disrupted.filter((one) => one.lines.some((line) => line.gid === departure.line.gid));
  const atStop = disrupted.filter((one) => one.lines.length === 0);

  if (!board) {
    if (!answer.error) return <Skeleton height='70%' radius='md' />;
    return <Quiet icon='bus-off'>{answer.error.message.replace(/^vt-departures: /, '')}</Quiet>;
  }
  const coming = board.departures.filter((departure) => Date.parse(departure.estimated ?? departure.planned) > now - 60_000);

  return (
    <div className='vt-board'>
      <div className='vt-stop'>
        {board.stop.name}
        {atStop.length > 0 && <Mark about={atStop} />}
      </div>
      {coming.length === 0 && <Quiet icon='moon'>Nothing leaves within the next hours</Quiet>}
      {coming.map((departure) => {
        const marks = departure.line.gid ? onLine(departure) : [];
        return (
          <div
            key={`${departure.line.designation} ${departure.direction} ${departure.planned}`}
            className={departure.cancelled ? 'vt-row vt-cancelled' : 'vt-row'}
          >
            <Badge line={departure.line} />
            <span className='vt-direction'>
              {marks.length > 0 && <Mark about={marks} />}
              {departure.direction}
              {departure.platform && <span className='vt-platform'>{departure.platform}</span>}
            </span>
            {departure.cancelled ? <span className='vt-time'>cancelled</span> : <When departure={departure} now={now} clock={clock} />}
          </div>
        );
      })}
    </div>
  );
}
