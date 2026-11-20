import { Skeleton } from '@mantine/core';
import { type GeoBounds, MapMarkers, MapTracks, MapView, TablerIcon } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { VtPositions, VtTracks } from '../../lib/api.ts';
import { whenDue } from '../components/fresh.ts';
import { darkerColour } from '../components/look.ts';
import { FADE_S, trails } from '../components/trails.ts';
import './cards.css';

/**
 * Asked again as soon as the server's answer is this old, which it keeps five seconds; this often
 * when it has none. Vehicles move every two or three seconds.
 */
const POLL_MS = 5_000;

/** The tracks are asked again this often, so a line coming into the card is drawn within a minute. */
const TRACKS_POLL_MS = 60_000;

/** How strongly a line's track is drawn where no vehicle of it has passed for ten minutes. */
const TRACK_OPACITY = 0.2;

/** How much of its own height and width the card asks about beyond each edge, so a vehicle appears out of sight and drives in. */
const BEYOND = 0.25;

/** The degrees the asked box is rounded out to, so a card a few pixels larger asks the same as its neighbour. */
const STEP = 0.002;

/** `bounds` grown by BEYOND on every side and rounded out to STEP, as `--bbox` takes it. */
const asked = (bounds: GeoBounds): string => {
  const [height, width] = [bounds.north - bounds.south, bounds.east - bounds.west];
  const down = (value: number) => (Math.floor(value / STEP) * STEP).toFixed(3);
  const up = (value: number) => (Math.ceil(value / STEP) * STEP).toFixed(3);
  return [down(bounds.south - height * BEYOND), down(bounds.west - width * BEYOND), up(bounds.north + height * BEYOND), up(bounds.east + width * BEYOND)].join(',');
};

/**
 * `/cards/vasttrafik/map`: the map around some stops (`stops`), `margin` metres on every side,
 * with the vehicles on it, of some `lines` when given, where they are now: each a dot under a tag
 * in its line's colours, as on the departures card, gliding from one answer to the next; the stops
 * are pins. The vehicles are those of the whole card and a quarter of it beyond each edge, so they
 * drive in from its edges, asked again as soon as the server's answer is five seconds old. Unless
 * `tracks` is `false`, the lines' tracks run faintly under the vehicles in their colours, asked again
 * every minute, and behind each vehicle the stretch it drove in the last ten minutes is drawn
 * strongly, fading as it ages.
 */
export default function MapCard() {
  const [params] = useSearchParams();
  const stops = params.getAll('stops');
  const margin = Number(params.get('margin') ?? 1000) || 1000;
  const showTracks = params.get('tracks') !== 'false';
  // What the map shows, once it is drawn; until then the vehicles are those in the stops' box.
  const [view, setView] = useState<string>();
  const onMoveEnd = useCallback((bounds: GeoBounds) => setView(asked(bounds)), []);
  const lines = params.getAll('lines').map((line) => ` --line ${shq(line)}`).join('');
  const box = view ? ` --bbox=${view}` : '';
  const answer = usePolledCommand<VtPositions>(
    `vt-positions --around ${shq(stops.join(','))} --margin ${margin}${box}${lines}`,
    stops.length > 0,
    POLL_MS,
    (answer) => whenDue(answer.freshMs),
  );
  const tracked = usePolledCommand<VtTracks>(`vt-tracks${box}${lines}`, view !== undefined && showTracks, TRACKS_POLL_MS);

  const around = answer.data?.around;
  // The map is moved to the stops' box when that changes, not at every answer.
  const bounds = useMemo(() => around, [around?.south, around?.west, around?.north, around?.east]);
  const markers = useMemo(() => {
    if (!answer.data) return [];
    return [
      ...answer.data.stops.filter((stop) => stop.lat !== undefined && stop.lng !== undefined).map((stop) => ({
        id: `stop ${stop.gid}`,
        lat: stop.lat!,
        lng: stop.lng!,
        label: stop.label,
      })),
      ...answer.data.vehicles.map((vehicle) => ({
        id: vehicle.ref,
        lat: vehicle.lat,
        lng: vehicle.lng,
        tag: {
          text: vehicle.line.designation,
          background: vehicle.line.background,
          color: vehicle.line.foreground,
          border: vehicle.line.border,
          dot: darkerColour(vehicle.line),
        },
        label: `${vehicle.line.designation} ${vehicle.direction}`,
      })),
    ];
  }, [answer.data]);
  const tracks = useMemo(() => {
    if (!showTracks || !tracked.data) return [];
    const lines = tracked.data.tracks.flatMap((track) =>
      track.paths.map((path, n) => ({
        id: `${track.line.designation} ${track.direction} ${n}`,
        points: path.map(([lat, lng]) => ({ lat, lng })),
        color: darkerColour(track.line),
        label: `${track.line.designation} ${track.direction}`,
        opacity: TRACK_OPACITY,
      }))
    );
    // The trails go over the faint tracks, the youngest on top.
    const behind = trails(answer.data?.vehicles ?? [], tracked.data.tracks).sort((a, b) => b.age - a.age).map((piece) => ({
      id: `trail ${piece.id}`,
      points: piece.points.map(([lat, lng]) => ({ lat, lng })),
      color: darkerColour(piece.vehicle.line),
      label: `${piece.vehicle.line.designation} ${piece.vehicle.direction}`,
      opacity: 1 - (1 - TRACK_OPACITY) * piece.age / FADE_S,
    }));
    return [...lines, ...behind];
  }, [showTracks, tracked.data, answer.data]);

  if (!answer.data) {
    if (!answer.error) return <Skeleton height='100%' radius='md' />;
    return (
      <div className='vt-quiet'>
        <TablerIcon name='map-off' size={26} stroke={1.5} />
        <span>{answer.error.message.replace(/^vt-positions: /, '')}</span>
      </div>
    );
  }
  return (
    <MapView bounds={bounds} onMoveEnd={onMoveEnd} layerSwitcher={false} details={false} style={{ height: '100%', width: '100%' }}>
      <MapTracks tracks={tracks} />
      <MapMarkers markers={markers} glide={POLL_MS} />
    </MapView>
  );
}
