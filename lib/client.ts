/**
 * Västtrafik's open API, as the commands ask it: a bearer token bought with the key, and each
 * answer kept for a while in this process, so that every screen showing one stop costs one call.
 *
 * Nothing is asked until a command wants it, and an answer is kept for as long as it stays true
 * enough: the stop areas a day, a stop's lines six hours, the path a line runs in one direction a
 * day, and the region's disruptions, a stop's departures and the vehicles' positions as long as
 * their settings say, counted from when Västtrafik was asked. Commands asking for the same thing
 * while it is being fetched wait for that one call. Departures, positions and disruptions say how
 * long their answer stays fresh, so that a card asks again just as it is due. A refresh that fails
 * gives the answer it was to replace while that is not much older than it should be, since the
 * positions call fails or takes ten seconds now and then. Where each vehicle was is kept ten
 * minutes, a point every half minute, from the positions asked for meanwhile.
 *
 *   CFG_VASTTRAFIK_URL                  the API's address, https://ext-api.vasttrafik.se
 *   CFG_VASTTRAFIK_KEY                  the application's authentication key from
 *                                       developer.vasttrafik.se: its key and secret as base64, or
 *                                       `key:secret`; a secret, sent only to the system's own address
 *   CFG_VASTTRAFIK_DEPARTURES_SECONDS   how long a stop's departures are kept, 20 unless set
 *   CFG_VASTTRAFIK_POSITIONS_SECONDS    how long the vehicles in a box are kept, 5 unless set
 *   CFG_VASTTRAFIK_DISRUPTIONS_SECONDS  how long the region's disruptions are kept, 300 unless set
 */
import { collectUnknownFlags, type Command, parseArgs, reportUnknownFlags, serviceKey } from '@ein/client';
import type { HealthCheck } from '@ein/api';
import {
  VT_PERIODS,
  type VtDeparture,
  type VtDepartures,
  type VtDisruption,
  type VtDisruptions,
  type VtLine,
  type VtLines,
  type VtPositions,
  type VtStop,
  type VtTrack,
  type VtTracks,
  type VtVehicle,
} from '@vasttrafik/api';

const DEFAULT_URL = 'https://ext-api.vasttrafik.se';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** How long each kind of answer is kept, and how much older one may be when a refresh fails. */
const KEEP = {
  stops: { fresh: 24 * HOUR, stale: 7 * 24 * HOUR },
  lines: { fresh: 6 * HOUR, stale: 24 * HOUR },
  paths: { fresh: 24 * HOUR, stale: 7 * 24 * HOUR },
};

/** A refresh that fails gives the answer it was to replace while it is not older than this many periods. */
const STALE_PERIODS = 6;

/** How long `cmd`'s settings keep a `kind` of answer, held within what the setting takes. */
const keepOf = (cmd: Ctx, kind: keyof typeof VT_PERIODS): { fresh: number; stale: number } => {
  const period = VT_PERIODS[kind];
  const set = Number(cmd.env[period.key] || period.default);
  const fresh = (Number.isFinite(set) ? Math.min(Math.max(set, period.min), period.max) : period.default) * SECOND;
  return { fresh, stale: STALE_PERIODS * fresh };
};

/** How long one call may take; a positions call takes ten seconds now and then. */
const TIMEOUT_MS = 25 * SECOND;

/** What a command passes for Västtrafik's address and key. */
type Ctx = Pick<Command, 'sys' | 'env'>;

/** The API's base, without a trailing slash. */
const vtBase = (cmd: Ctx): string => (cmd.env.CFG_VASTTRAFIK_URL || DEFAULT_URL).replace(/\/+$/, '');

/** A refusal worth saying as it is: no key, an API not subscribed to, a stop that is not one. */
class VtError extends Error {}

type Kept = { at: number; stale: number; value?: unknown; pending?: Promise<unknown> };
const kept = new Map<string, Kept>();
const tokens = new Map<string, { token: string; until: number; pending?: Promise<string> }>();

/** Drops what is too old to give even when a refresh fails, so a stop asked once is not kept for good. */
const prune = (now: number) => {
  for (const [key, entry] of kept) if (!entry.pending && now - entry.at > entry.stale) kept.delete(key);
};

/**
 * `load`'s answer under `key`: the one kept while younger than `fresh`; else the call already
 * under way; else a new one, whose failure gives the kept answer while younger than `stale`.
 */
const cached = async <T>(key: string, keep: { fresh: number; stale: number }, load: () => Promise<T>): Promise<T> => {
  const now = Date.now();
  const entry = kept.get(key);
  if (entry?.value !== undefined && now - entry.at < keep.fresh) return entry.value as T;
  if (entry?.pending) return await entry.pending as T;
  prune(now);
  const pending = load();
  kept.set(key, { at: entry?.at ?? 0, stale: keep.stale, value: entry?.value, pending });
  try {
    const value = await pending;
    kept.set(key, { at: now, stale: keep.stale, value });
    return value;
  } catch (error) {
    if (entry?.value !== undefined && Date.now() - entry.at < keep.stale) {
      kept.set(key, { at: entry.at, stale: keep.stale, value: entry.value });
      return entry.value as T;
    }
    kept.delete(key);
    throw error;
  }
};

/** How long an answer Västtrafik was asked for at `at` stays fresh, in milliseconds: 0 once it is due. */
const freshFor = (at: string, keep: { fresh: number }): number => Math.max(0, keep.fresh - (Date.now() - Date.parse(at)));

/** The key as Basic credentials: Västtrafik's authentication key is `key:secret` in base64 already. */
const basic = (key: string): string => key.includes(':') ? btoa(key) : key;

/** A bearer token for `key`, kept until a minute before it runs out. */
const token = async (base: string, key: string, renew = false): Promise<string> => {
  const id = `${base} ${key}`;
  const held = tokens.get(id);
  if (held?.pending) return await held.pending;
  if (held && !renew && held.until > Date.now()) return held.token;
  const pending = (async () => {
    const response = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic(key)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new VtError(
        response.status === 400 || response.status === 401
          ? 'Västtrafik refuses the key: check CFG_VASTTRAFIK_KEY'
          : `Västtrafik's token: ${response.status} ${body.error_description ?? ''}`.trim(),
      );
    }
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in * SECOND : HOUR;
    return { token: body.access_token as string, until: Date.now() + lifetime - MINUTE };
  })();
  const shared = pending.then((t) => t.token);
  // Those waiting on it see the failure; with none waiting it must not go unhandled.
  shared.catch(() => {});
  tokens.set(id, { token: held?.token ?? '', until: 0, pending: shared });
  try {
    const got = await pending;
    tokens.set(id, got);
    return got.token;
  } catch (error) {
    tokens.delete(id);
    throw error;
  }
};

/** Which subscription a path needs, to say so when Västtrafik answers 403. */
const apiOf = (path: string): string => path.startsWith('/geo/') ? 'Geografi v3' : path.startsWith('/ts/') ? 'Störning v1' : 'Planera Resa v4';

/** GET `path` with `query`, as JSON; a token Västtrafik no longer takes is renewed once. */
const get = async <T>(cmd: Ctx, path: string, query: [string, string | number][] = []): Promise<T> => {
  const base = vtBase(cmd);
  const key = await serviceKey(cmd, 'CFG_VASTTRAFIK_KEY', 'CFG_VASTTRAFIK_URL');
  if (!key) throw new VtError('no Västtrafik key: an administrator sets CFG_VASTTRAFIK_KEY on Settings → System → Västtrafik');
  const search = new URLSearchParams(query.map(([name, value]) => [name, String(value)]));
  const url = `${base}${path}${query.length ? `?${search}` : ''}`;
  for (let attempt = 0;; attempt++) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${await token(base, key, attempt > 0)}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel();
      continue;
    }
    if (response.ok) return await response.json() as T;
    const text = await response.text().catch(() => '');
    if (response.status === 403) throw new VtError(`the Västtrafik application does not subscribe to ${apiOf(path)}`);
    let message = text.slice(0, 200);
    try {
      const body = JSON.parse(text);
      message = body.errorMessage ?? body.title ?? message;
    } catch {
      // not JSON: the text as it is
    }
    throw new VtError(`Västtrafik answers ${response.status}${message ? `: ${message}` : ''}`);
  }
};

/** Västtrafik's stop area as Geografi answers it. */
type GeoStopArea = {
  gid: string;
  name: string;
  municipality?: { name?: string } | null;
  geometry?: { northingCoordinate?: number; eastingCoordinate?: number } | null;
  validUpToDate?: string;
};

/** Every stop area in use, by name; from Geografi once a day. */
export const stops = (cmd: Ctx): Promise<VtStop[]> =>
  cached(`${vtBase(cmd)} stops`, KEEP.stops, async () => {
    const answer = await get<{ stopAreas: GeoStopArea[] }>(cmd, '/geo/v3/StopAreas', [
      ['offset', 0],
      ['limit', 100_000],
      ['IncludeMunicipality', 'true'],
      ['IncludeGeometry', 'true'],
      ['Srid', 4326],
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set<string>();
    const list: VtStop[] = [];
    for (const area of answer.stopAreas ?? []) {
      if (seen.has(area.gid) || (area.validUpToDate && area.validUpToDate.slice(0, 10) < today)) continue;
      seen.add(area.gid);
      const municipality = area.municipality?.name || undefined;
      list.push({
        gid: area.gid,
        name: area.name,
        municipality,
        label: municipality && municipality !== area.name ? `${area.name}, ${municipality}` : area.name,
        lat: area.geometry?.northingCoordinate,
        lng: area.geometry?.eastingCoordinate,
      });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label, 'sv'));
  });

/** The stop with this gid, or a VtError saying it is none. */
const stopOf = async (cmd: Ctx, gid: string): Promise<VtStop> => {
  if (!/^\d{16}$/.test(gid)) throw new VtError(`${gid}: not a stop area's gid, 16 digits; vt-stops lists them`);
  const found = (await stops(cmd)).find((stop) => stop.gid === gid);
  if (!found) throw new VtError(`${gid}: no such stop area; vt-stops lists them`);
  return found;
};

/** A line as Planera Resa answers it, on a departure or a vehicle. */
type PrLine = {
  gid?: string;
  name?: string;
  shortName?: string;
  designation?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  borderColor?: string;
  transportMode?: string;
};

type PrDeparture = {
  serviceJourney: { direction?: string; directionDetails?: { shortDirection?: string }; line: PrLine };
  stopPoint?: { name?: string; platform?: string };
  plannedTime: string;
  estimatedTime?: string;
  isCancelled?: boolean;
  isPartCancelled?: boolean;
};

const lineOf = (line: PrLine): VtLine => {
  const designation = line.designation ?? line.shortName ?? line.name ?? '?';
  return {
    gid: line.gid,
    designation,
    name: line.designation && line.name ? line.name : designation,
    background: line.backgroundColor ?? '#006c93',
    foreground: line.foregroundColor ?? '#ffffff',
    border: line.borderColor,
    mode: line.transportMode ?? 'unknown',
  };
};

const departureOf = (one: PrDeparture): VtDeparture => ({
  line: lineOf(one.serviceJourney.line),
  direction: one.serviceJourney.directionDetails?.shortDirection ?? one.serviceJourney.direction ?? '',
  platform: one.stopPoint?.platform || undefined,
  planned: one.plannedTime,
  estimated: one.estimatedTime,
  cancelled: one.isCancelled === true,
  partCancelled: one.isPartCancelled === true,
});

/** Designations in the order a person reads them: 1, 2, 10, X5. */
const byDesignation = (a: string, b: string): number => a.localeCompare(b, 'sv', { numeric: true });

/** The lines and platforms of the departures from `gid` within twelve hours, one of each line and direction. */
const linesAt = (cmd: Ctx, gid: string) =>
  cached(`${vtBase(cmd)} lines ${gid}`, KEEP.lines, async () => {
    const answer = await get<{ results: PrDeparture[] }>(cmd, `/pr/v4/stop-areas/${gid}/departures`, [
      ['timeSpanInMinutes', 720],
      ['maxDeparturesPerLineAndDirection', 1],
      ['limit', 500],
    ]);
    return (answer.results ?? []).map(departureOf);
  });

/** The lines calling at any of `gids`, with their directions, and the platforms they leave from. */
export const lines = async (cmd: Ctx, gids: string[]): Promise<VtLines> => {
  const byLine = new Map<string, VtLines['lines'][number]>();
  const platforms = new Set<string>();
  for (const gid of gids) {
    await stopOf(cmd, gid);
    for (const departure of await linesAt(cmd, gid)) {
      const line = byLine.get(departure.line.designation) ?? { ...departure.line, directions: [] };
      if (departure.direction && !line.directions.includes(departure.direction)) line.directions.push(departure.direction);
      byLine.set(line.designation, line);
      if (departure.platform) platforms.add(departure.platform);
    }
  }
  return {
    stops: gids,
    lines: [...byLine.values()].sort((a, b) => byDesignation(a.designation, b.designation)),
    platforms: [...platforms].sort((a, b) => a.localeCompare(b, 'sv', { numeric: true })).map((platform) => ({ platform })),
  };
};

/** The departures asked for at a time from a stop: so many in all, or so many of each line. */
const BUCKETS = [5, 10, 20];
const bucket = (n: number): number => BUCKETS.find((size) => size >= n) ?? BUCKETS[BUCKETS.length - 1];

/**
 * The next `limit` departures from `gid`, of `only` lines when given, from `platforms` when given.
 * All the cards on one stop share one call: the next 5, 10 or 20 in all, or, for a few lines, as
 * many of each line and direction within three hours, so a line that runs seldom is not crowded
 * out.
 */
export const departures = async (
  cmd: Ctx,
  gid: string,
  opts: { limit: number; lines?: string[]; platforms?: string[] },
): Promise<VtDepartures> => {
  const stop = await stopOf(cmd, gid);
  const n = bucket(opts.limit);
  const perLine = (opts.lines?.length ?? 0) > 0 || (opts.platforms?.length ?? 0) > 0;
  const keep = keepOf(cmd, 'departures');
  const fetched = await cached(`${vtBase(cmd)} departures ${gid} ${perLine ? 'each' : 'all'} ${n}`, keep, async () => {
    const at = new Date().toISOString();
    const answer = await get<{ results: PrDeparture[] }>(
      cmd,
      `/pr/v4/stop-areas/${gid}/departures`,
      perLine ? [['timeSpanInMinutes', 180], ['maxDeparturesPerLineAndDirection', n], ['limit', 500]] : [['limit', n]],
    );
    return { at, departures: (answer.results ?? []).map(departureOf) };
  });
  const wanted = (departure: VtDeparture) =>
    (!opts.lines?.length || opts.lines.includes(departure.line.designation)) &&
    (!opts.platforms?.length || opts.platforms.some((platform) => departure.platform?.startsWith(platform)));
  const leaves = (departure: VtDeparture) => Date.parse(departure.estimated ?? departure.planned);
  return {
    stop: { gid: stop.gid, name: stop.label },
    departures: fetched.departures.filter(wanted).sort((a, b) => leaves(a) - leaves(b)).slice(0, opts.limit),
    at: fetched.at,
    freshMs: freshFor(fetched.at, keep),
  };
};

/** A box, south-west and north-east. */
type Box = VtPositions['box'];

const METRES_PER_DEGREE = 111_320;

/** The box around `stops` with `margin` metres on every side. */
export const boxAround = (stops: VtStop[], margin: number): Box => {
  const placed = stops.filter((stop) => stop.lat !== undefined && stop.lng !== undefined);
  if (!placed.length) throw new VtError('Västtrafik says nowhere for these stops');
  const lats = placed.map((stop) => stop.lat!);
  const lngs = placed.map((stop) => stop.lng!);
  const dLat = margin / METRES_PER_DEGREE;
  const dLng = margin / (METRES_PER_DEGREE * Math.cos((Math.max(...lats) * Math.PI) / 180));
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return {
    south: round(Math.min(...lats) - dLat),
    west: round(Math.min(...lngs) - dLng),
    north: round(Math.max(...lats) + dLat),
    east: round(Math.max(...lngs) + dLng),
  };
};

/** The metres `--margin` takes around the stops. */
const MARGIN = { default: 1000, min: 100, max: 5000 };

/** The flags naming the box a command is about, and the lines in it. */
export const AREA_FLAGS = [
  { name: 'around', type: 'string' as const, description: 'stop areas by gid, as vt-stops lists them; the box takes them all, with the margin around' },
  { name: 'margin', type: 'number' as const, description: `metres around the stops, ${MARGIN.min} to ${MARGIN.max}; ${MARGIN.default} unless given` },
  { name: 'bbox', type: 'string' as const, description: 'the box instead: south,west,north,east in degrees; with --around too, the stops and their box are still answered' },
  { name: 'line', type: 'string' as const, description: 'only this line, by what its signs say; repeat it or put commas between for several' },
];

/** `south,west,north,east` in degrees, or nothing when it is not that. */
const parseBox = (text: string): Box | undefined => {
  const [south, west, north, east] = text.split(',').map(Number);
  if ([south, west, north, east].some((value) => !Number.isFinite(value)) || south >= north || west >= east) return undefined;
  return { south, west, north, east };
};

/**
 * The box `cmd` names with AREA_FLAGS, the stops given and the box around them, and the lines
 * asked for; or the exit code, once the flags' fault is said.
 */
export const areaOf = async (cmd: Command, name: string): Promise<{ box: Box; stops: VtStop[]; around?: Box; lines: string[] } | number> => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { string: ['bbox', 'margin'], collect: ['around', 'line'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const split = (values: unknown) => ([] as unknown[]).concat(values ?? []).map(String).flatMap((value) => value.split(',')).filter(Boolean);
  const around = split(flags.around);
  const margin = flags.margin === undefined ? MARGIN.default : Number(flags.margin);
  const bbox = flags.bbox ? parseBox(flags.bbox) : undefined;
  if ((!around.length && flags.bbox === undefined) || (flags.bbox && !bbox) || !(margin >= MARGIN.min && margin <= MARGIN.max)) {
    await cmd.writeError(`${name}: give --around with stops, --bbox south,west,north,east, or both; --margin from ${MARGIN.min} to ${MARGIN.max} metres\n`);
    return 2;
  }
  const stops: VtStop[] = [];
  for (const gid of around) stops.push(await stopOf(cmd, gid));
  const box = stops.length ? boxAround(stops, margin) : undefined;
  return { box: bbox ?? box!, stops, ...(box ? { around: box } : {}), lines: split(flags.line) };
};

type PrVehicle = {
  detailsReference: string;
  line: PrLine;
  name?: string;
  direction?: string;
  directionDetails?: { shortDirection?: string };
  latitude: number;
  longitude: number;
};

/** How far back a vehicle's trail reaches, and how far apart its points are at least. */
const TRAIL = { keep: 10 * MINUTE, every: 30 * SECOND };

/** Where each vehicle was, by the API's base and its journey: `[lat, lng, when]`, oldest first. */
const travelled = new Map<string, [number, number, number][]>();

/**
 * Notes where `vehicles` are at `now` under `base`, a point every half minute, and gives each its
 * trail before now; forgets what is older than ten minutes and vehicles not seen since.
 */
const trailsOf = (base: string, vehicles: Omit<VtVehicle, 'trail'>[], now: number): VtVehicle[] => {
  for (const [key, points] of travelled) {
    while (points.length && now - points[0][2] > TRAIL.keep) points.shift();
    if (!points.length) travelled.delete(key);
  }
  return vehicles.map((vehicle) => {
    const key = `${base} ${vehicle.ref}`;
    const points = travelled.get(key) ?? [];
    const trail = points.map(([lat, lng, at]): [number, number, number] => [lat, lng, Math.round((now - at) / SECOND)]);
    if (!points.length || now - points.at(-1)![2] >= TRAIL.every) travelled.set(key, [...points, [vehicle.lat, vehicle.lng, now]]);
    return { ...vehicle, trail };
  });
};

/** The most vehicles Västtrafik gives for one box. */
const POSITIONS_LIMIT = 200;

/** The vehicles in `box`, of `only` lines when given; at most 200, which a box around a city centre can hold. */
export const positions = async (cmd: Ctx, box: Box, only: string[] = []): Promise<Omit<VtPositions, 'stops'>> => {
  const wanted = [...new Set(only)].sort(byDesignation);
  const key = `${vtBase(cmd)} positions ${box.south} ${box.west} ${box.north} ${box.east} ${wanted.join(',')}`;
  const keep = keepOf(cmd, 'positions');
  const fetched = await cached(key, keep, async () => {
    const now = Date.now();
    const answer = await get<PrVehicle[]>(cmd, '/pr/v4/positions', [
      ['lowerLeftLat', box.south],
      ['lowerLeftLong', box.west],
      ['upperRightLat', box.north],
      ['upperRightLong', box.east],
      ['limit', POSITIONS_LIMIT],
      ...wanted.map((line): [string, string] => ['lineDesignations', line]),
    ]);
    const vehicles = trailsOf(
      vtBase(cmd),
      (Array.isArray(answer) ? answer : []).map((vehicle) => ({
        ref: vehicle.detailsReference,
        line: lineOf({ ...vehicle.line, designation: vehicle.line.name ?? vehicle.name }),
        direction: vehicle.directionDetails?.shortDirection ?? vehicle.direction ?? '',
        lat: vehicle.latitude,
        lng: vehicle.longitude,
      })),
      now,
    );
    return { box, vehicles, at: new Date(now).toISOString() };
  });
  return { ...fetched, freshMs: freshFor(fetched.at, keep), periodMs: keep.fresh };
};

/** A journey's details as Planera Resa answers them with its coordinates. */
type PrJourneyDetails = {
  tripLegs?: { serviceJourneys?: { serviceJourneyCoordinates?: { latitude: number; longitude: number }[] | null }[] | null }[] | null;
};

/** The path the journey `ref` runs, first stop to last, as `[lat, lng]`. */
const journeyPath = async (cmd: Ctx, ref: string): Promise<[number, number][]> => {
  const answer = await get<PrJourneyDetails>(cmd, `/pr/v4/journeys/${encodeURIComponent(ref)}/details`, [['includes', 'servicejourneycoordinates']]);
  return (answer.tripLegs ?? [])
    .flatMap((leg) => leg.serviceJourneys ?? [])
    .flatMap((journey) => journey.serviceJourneyCoordinates ?? [])
    .map((point): [number, number] => [point.latitude, point.longitude]);
};

/** The stretches of `path` that cross `box`: every segment whose own box meets it, with both its ends. */
export const clip = (path: [number, number][], box: Box): [number, number][][] => {
  const stretches: [number, number][][] = [];
  let stretch: [number, number][] = [];
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    const meets = Math.max(a[0], b[0]) >= box.south && Math.min(a[0], b[0]) <= box.north &&
      Math.max(a[1], b[1]) >= box.west && Math.min(a[1], b[1]) <= box.east;
    if (meets) {
      if (!stretch.length) stretch.push(a);
      stretch.push(b);
    } else if (stretch.length) {
      stretches.push(stretch);
      stretch = [];
    }
  }
  if (stretch.length) stretches.push(stretch);
  return stretches;
};

/** A line's path in one direction, under the API's base, line and direction, with when a vehicle on it was last in a box asked about. */
const known = new Map<string, { base: string; line: VtLine; direction: string; path: [number, number][]; seen: number }>();

/** How many journeys' details are asked for at a time. */
const AT_ONCE = 4;

/**
 * The tracks of the lines that run through `box`, of `only` lines when given: for each line and
 * direction, the path of one of its vehicles' journeys, clipped to the box. A line is in it when a
 * vehicle on it is in the box now, or when its path crosses the box and a vehicle on it was in a box
 * asked about within the day, so a line stays drawn between its vehicles. A path is kept a day under
 * its line and direction, so the next vehicle on it costs no call. A line whose path cannot be had is
 * left out, unless none can be drawn.
 */
export const tracks = async (cmd: Ctx, box: Box, only: string[] = []): Promise<VtTracks> => {
  const found = await positions(cmd, box, only);
  const first = new Map<string, VtVehicle>();
  for (const vehicle of found.vehicles) {
    const key = `${vehicle.line.designation} ${vehicle.direction}`;
    if (!first.has(key)) first.set(key, vehicle);
  }
  const wanted = [...first];
  const base = vtBase(cmd);
  const failed: unknown[] = [];
  for (let i = 0; i < wanted.length; i += AT_ONCE) {
    const paths = await Promise.allSettled(
      wanted.slice(i, i + AT_ONCE).map(([key, vehicle]) => cached(`${base} path ${key}`, KEEP.paths, () => journeyPath(cmd, vehicle.ref))),
    );
    paths.forEach((path, n) => {
      const [key, vehicle] = wanted[i + n];
      if (path.status === 'rejected') failed.push(path.reason);
      else known.set(`${base} ${key}`, { base, line: vehicle.line, direction: vehicle.direction, path: path.value, seen: Date.now() });
    });
  }
  const drawn: VtTrack[] = [];
  const lines = new Set(only);
  for (const [key, track] of known) {
    if (Date.now() - track.seen > KEEP.paths.fresh) known.delete(key);
    else if (track.base === base && (!lines.size || lines.has(track.line.designation))) {
      const paths = clip(track.path, box);
      if (paths.length) drawn.push({ line: track.line, direction: track.direction, paths });
    }
  }
  if (failed.length && !drawn.length) throw failed[0];
  drawn.sort((a, b) => byDesignation(a.line.designation, b.line.designation) || a.direction.localeCompare(b.direction, 'sv'));
  return { box, tracks: drawn, at: found.at };
};

/** A situation as Störning answers it. */
type TsSituation = {
  situationNumber: string;
  startTime: string;
  endTime?: string | null;
  severity?: string;
  title?: string;
  description?: string | null;
  affectedStopPoints?: { stopAreaGid?: string; stopAreaName?: string; municipalityName?: string }[] | null;
  affectedLines?:
    | {
      gid?: string;
      name?: string;
      designation?: string;
      defaultTransportModeCode?: string;
      textColor?: string;
      backgroundColor?: string;
    }[]
    | null;
};

/** Störning's `0061EB` as CSS. */
const colour = (hex: string | undefined, fallback: string): string => /^[0-9a-f]{6}$/i.test(hex ?? '') ? `#${hex!.toLowerCase()}` : fallback;

/** The order a reader wants them in: the worst first. */
const SEVERITY: Record<string, number> = { severe: 0, normal: 1, slight: 2 };

const disruptionOf = (one: TsSituation): VtDisruption => {
  const stops = new Map<string, string>();
  for (const point of one.affectedStopPoints ?? []) {
    if (!point.stopAreaGid || stops.has(point.stopAreaGid)) continue;
    const name = point.stopAreaName ?? point.stopAreaGid;
    stops.set(point.stopAreaGid, point.municipalityName && point.municipalityName !== name ? `${name}, ${point.municipalityName}` : name);
  }
  return {
    id: one.situationNumber,
    title: one.title ?? '',
    description: one.description || undefined,
    severity: one.severity ?? 'normal',
    start: one.startTime,
    end: one.endTime || undefined,
    stops: [...stops].map(([gid, name]) => ({ gid, name })),
    lines: (one.affectedLines ?? []).map((line) =>
      lineOf({
        gid: line.gid,
        designation: line.designation,
        name: line.name || undefined,
        backgroundColor: colour(line.backgroundColor, '#006c93'),
        foregroundColor: colour(line.textColor, '#ffffff'),
        transportMode: line.defaultTransportModeCode,
      })
    ),
  };
};

/**
 * The disruptions in effect now, or starting within `aheadHours`, that name any of `stops` (stop
 * area gids) or any of `lines` (designations or line gids); every one when neither is given. The
 * worst first, then by when they start. All of them come from one copy of the whole region's.
 */
export const disruptions = async (
  cmd: Ctx,
  opts: { stops?: string[]; lines?: string[]; aheadHours?: number },
): Promise<VtDisruptions> => {
  const keep = keepOf(cmd, 'disruptions');
  const fetched = await cached(`${vtBase(cmd)} disruptions`, keep, async () => {
    const answer = await get<TsSituation[]>(cmd, '/ts/v1/traffic-situations');
    return { at: new Date().toISOString(), disruptions: (Array.isArray(answer) ? answer : []).map(disruptionOf) };
  });
  const now = Date.now();
  const until = now + (opts.aheadHours ?? 0) * HOUR;
  const stops = opts.stops ?? [];
  const lines = opts.lines ?? [];
  const any = stops.length > 0 || lines.length > 0;
  const wanted = (one: VtDisruption) =>
    Date.parse(one.start) <= until && (!one.end || Date.parse(one.end) > now) &&
    (!any || one.stops.some((stop) => stops.includes(stop.gid)) ||
      one.lines.some((line) => lines.includes(line.designation) || (line.gid !== undefined && lines.includes(line.gid))));
  return {
    disruptions: fetched.disruptions.filter(wanted).sort((a, b) => (SEVERITY[a.severity] ?? 1) - (SEVERITY[b.severity] ?? 1) || Date.parse(a.start) - Date.parse(b.start)),
    at: fetched.at,
    freshMs: freshFor(fetched.at, keep),
  };
};

/** What went wrong, to say: a VtError as it is, anything else with what it was. */
const messageOf = (error: unknown): string =>
  error instanceof VtError ? error.message : error instanceof Error ? `${error.name === 'TimeoutError' ? 'Västtrafik did not answer in time' : error.message}` : String(error);

/** A command's failure, said on stderr. */
export const fail = async (cmd: Command, name: string, error: unknown): Promise<number> => {
  await cmd.writeError(`${name}: ${messageOf(error)}\n`);
  return 1;
};

/** `a message` as `A message.`, a check's reason. */
const sentence = (text: string): string => `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;

/** Each API the commands use, what it gives them, and a call to it that costs Västtrafik little. */
const APIS: { name: string; gives: string; path: string; query: [string, string | number][] }[] = [
  {
    name: 'Planera Resa v4',
    gives: 'departures, vehicles and their tracks',
    path: '/pr/v4/positions',
    query: [['lowerLeftLat', 57.705], ['lowerLeftLong', 11.965], ['upperRightLat', 57.708], ['upperRightLong', 11.972], ['limit', 1]],
  },
  { name: 'Geografi v3', gives: 'the stops', path: '/geo/v3/StopAreas', query: [['offset', 0], ['limit', 1]] },
  { name: 'Störning v1', gives: 'disruptions', path: '/ts/v1/traffic-situations', query: [] },
];

/**
 * Whether Västtrafik takes the key and answers each API the commands use, each asked anew rather
 * than from what is kept: first that a key is set and buys a token, then one call to each API.
 */
export const status = async (cmd: Ctx): Promise<HealthCheck[]> => {
  const base = vtBase(cmd);
  const key = await serviceKey(cmd, 'CFG_VASTTRAFIK_KEY', 'CFG_VASTTRAFIK_URL');
  if (!key) return [{ name: 'key', state: 'fail', reason: 'No key is set, so the Västtrafik cards and commands have nothing to show.' }];
  try {
    await token(base, key);
  } catch (error) {
    return [{ name: 'key', state: 'fail', reason: sentence(messageOf(error)) }];
  }
  const asked = await Promise.allSettled(APIS.map((api) => get(cmd, api.path, api.query)));
  return [
    { name: 'key', state: 'ok', reason: `Västtrafik at ${new URL(base).host} takes the key.` },
    ...APIS.map((api, n): HealthCheck => {
      const answer = asked[n];
      return answer.status === 'fulfilled'
        ? { name: api.name, state: 'ok', reason: `${api.name} answers: ${api.gives}.` }
        : { name: api.name, state: 'fail', reason: sentence(messageOf(answer.reason)) };
    }),
  ];
};
