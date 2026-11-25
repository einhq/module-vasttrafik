import { type GeoBounds, MapMarkers, MapTracks, useMapExtent, useMapLayerNote, useMapViewport } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { VtPositions, VtTracks } from '../../lib/api.ts';
import { whenDue } from '../components/fresh.ts';
import { darkerColour, shortName } from '../components/look.ts';
import { type Courses, frame, measure, steer } from '../components/trails.ts';

/** Asked again as soon as the server's answer is due, which it says; this often when it has none. */
const POLL_MS = 5_000;

/** How often the vehicles and their trails are drawn where they have driven to; each marker glides there over that time. */
const FRAME_MS = 200;

/** The tracks are asked again this often, so a line coming into view has its track within a minute. */
const TRACKS_POLL_MS = 60_000;

/** How strongly a vehicle's track ahead of it is drawn where the vehicle is, fading out from there. */
const AHEAD_OPACITY = 0.4;

/** A stop's tag: dark writing on white, as a stop's sign, unlike the lines' own colours. */
const STOP_TAG = { background: '#ffffff', color: '#1f2937', border: '#1f2937', dot: '#1f2937' };

/** How much of its own height and width the map asks about beyond each edge, so a vehicle appears out of sight and drives in. */
const BEYOND = 0.25;

/** The degrees the asked box is rounded out to, so a map a few pixels larger asks the same as its neighbour. */
const STEP = 0.002;

/**
 * The closest a map without stops is zoomed out and still asks for the vehicles in view: a city's
 * centre. Further out the box holds more vehicles than one answer gives, and costs as much.
 */
const MIN_ZOOM = 12;

/** `bounds` grown by BEYOND on every side and rounded out to STEP, as `--bbox` takes it. */
const asked = (bounds: GeoBounds): string => {
  const [height, width] = [bounds.north - bounds.south, bounds.east - bounds.west];
  const down = (value: number) => (Math.floor(value / STEP) * STEP).toFixed(3);
  const up = (value: number) => (Math.ceil(value / STEP) * STEP).toFixed(3);
  return [down(bounds.south - height * BEYOND), down(bounds.west - width * BEYOND), up(bounds.north + height * BEYOND), up(bounds.east + width * BEYOND)].join(',');
};

/**
 * `/map-layers/vasttrafik/vehicles`: Västtrafik's trams, buses and boats on the map around it,
 * where they are now, of some `lines` when given: each a dot under a tag in its line's colours, as
 * on the departures card, driving from where it is drawn to where each answer puts it, along its
 * line's track when it is on it, and straight when it is not. The vehicles are those of the whole
 * view and a quarter of it beyond each edge, so they drive in from its edges, asked again as soon
 * as the server's answer is due; a map zoomed out further than a city's centre asks for none, and
 * says so under the layer's switch. With `stops`, each is a dot under a white tag with its name,
 * short, drawn under the vehicles, and the box `margin` metres around them is what a map told to
 * fit its layers shows. On their lines' tracks, asked again every minute, a vehicle never drives
 * backwards: one Västtrafik puts back waits until it has passed that spot. Unless `trails` is
 * `false`, behind each vehicle the stretch it drove in the last minute is drawn in its line's
 * colour, fading as it ages, and the next stretch of its track ahead of it dimmed, both from where
 * it is drawn at the moment, so that it draws its own trail.
 */
export default function VehiclesLayer() {
  const [params] = useSearchParams();
  const stops = params.getAll('stops');
  const margin = Number(params.get('margin') ?? 1000) || 1000;
  const trails = params.get('trails') !== 'false';
  const viewport = useMapViewport();
  const view = viewport ? asked(viewport.bounds) : undefined;
  const close = stops.length > 0 || (viewport !== null && viewport.zoom >= MIN_ZOOM);
  const lines = params.getAll('lines').map((line) => ` --line ${shq(line)}`).join('');
  const box = view ? ` --bbox=${view}` : '';
  const area = stops.length > 0 ? `--around ${shq(stops.join(','))} --margin ${margin}${box}` : box.trim();
  const answer = usePolledCommand<VtPositions>(
    `vt-positions ${area}${lines}`,
    close && area !== '',
    POLL_MS,
    (answer) => whenDue(answer.freshMs),
  );
  const tracked = usePolledCommand<VtTracks>(`vt-tracks${box}${lines}`, close && view !== undefined, TRACKS_POLL_MS);
  const courses = useRef<Courses>(new Map());
  const stretches = useMemo(() => measure(tracked.data?.tracks ?? []), [tracked.data]);
  // Each answer, and only an answer, sets where every vehicle drives next, from where it is drawn now.
  useMemo(() => answer.data && steer(courses.current, answer.data.vehicles, stretches, Date.now(), answer.data.periodMs), [answer.data]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!close) return;
    const timer = setInterval(() => setNow(Date.now()), FRAME_MS);
    return () => clearInterval(timer);
  }, [close]);

  useMapExtent(answer.data?.around);
  useMapLayerNote(!close ? 'Zoom in to see the vehicles.' : answer.error ? answer.error.message.replace(/^vt-positions: /, '') : undefined);

  const shown = close ? answer.data : undefined;
  const drawn = useMemo(() => frame(courses.current, stretches, now), [now, answer.data, stretches]);
  const markers = useMemo(() => {
    if (!shown) return [];
    return [
      ...shown.stops.filter((stop) => stop.lat !== undefined && stop.lng !== undefined).map((stop) => ({
        id: `stop ${stop.gid}`,
        lat: stop.lat!,
        lng: stop.lng!,
        tag: { text: shortName(stop.name), ...STOP_TAG },
        below: true,
        label: stop.label,
      })),
      ...drawn.vehicles.map((vehicle) => ({
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
  }, [shown, drawn]);
  // The way ahead goes under the trails; each fades out away from its vehicle.
  const tracks = useMemo(() => {
    if (!trails || !shown) return [];
    return [...drawn.pieces].sort((a, b) => Number(b.ahead) - Number(a.ahead)).map((piece) => ({
      id: piece.id,
      points: piece.points.map(([lat, lng]) => ({ lat, lng })),
      color: darkerColour(piece.vehicle.line),
      label: `${piece.vehicle.line.designation} ${piece.vehicle.direction}`,
      opacity: piece.ahead ? AHEAD_OPACITY : 1,
      fade: piece.ahead ? 'end' as const : 'start' as const,
    }));
  }, [trails, shown, drawn]);

  return (
    <>
      <MapTracks tracks={tracks} />
      <MapMarkers markers={markers} glide={FRAME_MS} />
    </>
  );
}
