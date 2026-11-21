/**
 * The Västtrafik commands in a booted EiN, against a stub of Västtrafik's API answering as the real
 * one did when probed (ein/core#1299, ein/core#1482): without a key they say so; with one, a token
 * is bought once and the stops, lines, departures, positions and the paths of the vehicles' journeys
 * come from the API, each kept so that asking again soon costs no call, the departures and positions
 * saying how long they stay fresh, as long as their settings say; a token Västtrafik stops taking is
 * renewed, and an API the application does not subscribe to is named, by the command that needs it
 * and by vt-status, which checks the key and each API.
 */

import { assert, assertEquals, assertMatch } from '@std/assert';
import { createTestContext } from '@ein/testing';
import type { HealthCheck } from '@ein/api';
import type { VtDepartures, VtDisruptions, VtLines, VtPositions, VtStop, VtTracks } from '../lib/api.ts';
import { boxAround, clip } from '../lib/client.ts';
import { darkerColour, shortName } from '../ui/components/look.ts';
import { type Courses, frame, measure, steer } from '../ui/components/trails.ts';

const KEY = btoa('app-id:app-secret');
const BRUNNSPARKEN = '9021014001760000';
const KUNGALV = '9021014004090000';

const line = (designation: string, mode: string, background: string, foreground: string) => ({
  gid: `90110145${designation.padStart(8, '0')}`,
  name: `${mode === 'tram' ? 'Spårvagn' : 'Buss'} ${designation}`,
  shortName: designation,
  designation,
  backgroundColor: background,
  foregroundColor: foreground,
  borderColor: foreground,
  transportMode: mode,
});

const TRAM_6 = line('6', 'tram', '#fda00a', '#ffffff');
const BUS_60 = line('60', 'bus', '#ffff50', '#0061eb');

const departure = (of: ReturnType<typeof line>, direction: string, platform: string, planned: string, estimated?: string, cancelled = false) => ({
  detailsReference: `ref-${of.designation}-${planned}`,
  serviceJourney: { gid: '9015014500106080', direction, directionDetails: { fullDirection: direction, shortDirection: direction }, line: of },
  stopPoint: { gid: '9022014001760005', name: 'Brunnsparken, Göteborg', platform, latitude: 57.7066, longitude: 11.9688 },
  plannedTime: `2099-11-19T${planned}:00.0000000+01:00`,
  ...(estimated ? { estimatedTime: `2099-11-19T${estimated}:00.0000000+01:00` } : {}),
  isCancelled: cancelled,
  isPartCancelled: false,
});

/** A situation as Störning answers it, naming stop points of `stops` and `lines`. */
const situation = (
  id: string,
  severity: string,
  title: string,
  start: string,
  end: string,
  stops: [string, string][],
  lines: ReturnType<typeof line>[],
) => ({
  situationNumber: id,
  creationTime: '2026-11-01T10:00:00+01:00',
  startTime: start,
  endTime: end,
  severity,
  title,
  description: 'Orsaken är vägarbete.',
  affectedStopPoints: stops.map(([gid, name], n) => ({
    gid: `${gid.slice(0, 4)}2${gid.slice(5, 15)}${n + 1}`,
    name,
    stopAreaGid: gid,
    stopAreaName: name,
    municipalityName: 'Göteborg',
  })),
  affectedLines: lines.map((of) => ({
    gid: of.gid,
    name: '',
    designation: of.designation,
    defaultTransportModeCode: of.transportMode,
    textColor: of.foregroundColor.slice(1).toUpperCase(),
    backgroundColor: of.backgroundColor.slice(1).toUpperCase(),
  })),
  affectedJourneys: [],
});

/** A line 6 elsewhere in the region, under another gid. */
const BUS_6_ELSEWHERE = { ...line('6', 'bus', '#ffff50', '#0061eb'), gid: '9011014306100000' };

const SITUATIONS = [
  situation('RT1', 'slight', 'Brunnsparken läge C är flyttad', '2026-11-01T00:00:00+01:00', '2099-12-31T23:59:00+01:00', [[BRUNNSPARKEN, 'Brunnsparken']], []),
  situation('RT2', 'normal', 'Linje 6 är omdirigerad', '2026-11-01T00:00:00+01:00', '2099-12-31T23:59:00+01:00', [], [TRAM_6]),
  situation('RT3', 'slight', 'Linje 6 i en annan kommun', '2026-11-01T00:00:00+01:00', '2099-12-31T23:59:00+01:00', [], [BUS_6_ELSEWHERE]),
  situation('RT4', 'normal', 'Linje 60 är indragen i morgon', '2099-12-30T07:00:00+01:00', '2099-12-30T19:00:00+01:00', [], [BUS_60]),
  situation('RT5', 'severe', 'Över sedan länge', '2020-01-01T00:00:00+01:00', '2020-01-02T00:00:00+01:00', [[BRUNNSPARKEN, 'Brunnsparken']], [TRAM_6]),
];

/** A vehicle as Planera Resa's positions answer it, on the journey `ref`. */
const vehicle = (ref: string, of: ReturnType<typeof line>, direction: string, latitude: number, longitude: number) => ({
  detailsReference: ref,
  line: {
    name: of.designation,
    backgroundColor: of.backgroundColor,
    foregroundColor: of.foregroundColor,
    borderColor: of.borderColor,
    isRealtimeJourney: true,
    transportMode: of.transportMode,
  },
  name: of.designation,
  direction: `${direction}, Påstigning fram`,
  directionDetails: { fullDirection: `${direction}, Påstigning fram`, shortDirection: direction },
  latitude,
  longitude,
});

const TRAM_5 = line('5', 'tram', '#eb1923', '#ffffff');

/** Two trams on one line and direction, a bus, and a tram whose journey Västtrafik cannot give. */
const VEHICLES = [
  vehicle('journey-60', BUS_60, 'Redbergsplatsen', 57.7101, 11.9702),
  vehicle('journey-6a', TRAM_6, 'Kortedala', 57.7068, 11.9690),
  vehicle('journey-6b', TRAM_6, 'Kortedala', 57.7051, 11.9632),
  vehicle('journey-5', TRAM_5, 'Östra Sjukhuset', 57.7060, 11.9700),
];

/** The paths of the journeys, as `[lat, lng]`; the box around Brunnsparken by 500 m is 57.7024–57.7114, 11.9594–11.9763. */
const PATHS: Record<string, [number, number][]> = {
  'journey-60': [[57.69, 11.96], [57.705, 11.965], [57.708, 11.97], [57.74, 11.98], [57.75, 11.99]],
  'journey-6a': [[57.705, 11.962], [57.706, 11.965], [57.705, 12.01], [57.705, 12.02], [57.706, 11.97], [57.707, 11.968]],
};

/** Västtrafik's API as far as the module asks it, with what it was asked. */
const stubVasttrafik = () => {
  const asked: string[] = [];
  /** The journeys whose vehicles have left every box. */
  const gone = new Set<string>();
  let tokens = 0;
  /** The token the API takes; another is refused with 401. */
  let valid = 'token-1';
  const subscribes = { geo: true };
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await req.text());
      if (req.headers.get('authorization') !== `Basic ${KEY}` || form.get('grant_type') !== 'client_credentials') {
        return Response.json({ error: 'invalid_client', error_description: 'Client credentials are invalid.' }, { status: 401 });
      }
      tokens++;
      return Response.json({ access_token: valid, scope: 'default', token_type: 'Bearer', expires_in: 86400 });
    }
    if (req.headers.get('authorization') !== `Bearer ${valid}`) return new Response('', { status: 401 });
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/geo/v3/StopAreas') {
      if (!subscribes.geo) return Response.json({ fault: { code: 900908, message: 'Resource forbidden ' } }, { status: 403 });
      const area = (gid: string, name: string, municipality: string, lat: number, lng: number, validUpToDate = '2099-12-31T00:00:00') => ({
        gid,
        name,
        municipality: { name: municipality },
        geometry: { northingCoordinate: lat, eastingCoordinate: lng, srid: 4326 },
        validUpToDate,
      });
      return Response.json({
        stopAreas: [
          area(KUNGALV, 'Kungälvs busstation', 'Kungälv', 57.8708, 11.9805),
          area(BRUNNSPARKEN, 'Brunnsparken', 'Göteborg', 57.706882, 11.967852),
          area('9021014001761000', 'Brunnsparken', 'Göteborg', 57.7, 11.9, '2020-01-01T00:00:00'),
        ],
      });
    }
    const stop = /^\/pr\/v4\/stop-areas\/(\d{16})\/departures$/.exec(url.pathname)?.[1];
    if (stop) {
      const each = url.searchParams.has('maxDeparturesPerLineAndDirection');
      const results = stop !== BRUNNSPARKEN ? [] : each
        ? [
          departure(TRAM_6, 'Kortedala', 'A1', '17:40'),
          departure(BUS_60, 'Redbergsplatsen', 'C2', '17:28', '17:29'),
          departure(TRAM_6, 'Länsmansgården', 'B1', '17:31', undefined, true),
        ]
        : [departure(BUS_60, 'Redbergsplatsen', 'C2', '17:28', '17:33'), departure(TRAM_6, 'Kortedala', 'A1', '17:30')];
      return Response.json({ results, pagination: { limit: 5, offset: 0, size: results.length } });
    }
    if (url.pathname === '/ts/v1/traffic-situations') return Response.json(SITUATIONS);
    if (url.pathname === '/pr/v4/positions') {
      const only = url.searchParams.getAll('lineDesignations');
      return Response.json(VEHICLES.filter((vehicle) => !gone.has(vehicle.detailsReference) && (!only.length || only.includes(vehicle.name))));
    }
    const journey = /^\/pr\/v4\/journeys\/([^/]+)\/details$/.exec(url.pathname)?.[1];
    if (journey) {
      const path = PATHS[decodeURIComponent(journey)];
      if (!path || url.searchParams.get('includes') !== 'servicejourneycoordinates') return Response.json({ title: 'Internal Server Error' }, { status: 500 });
      const serviceJourneyCoordinates = path.map(([latitude, longitude]) => ({ latitude, longitude, isOnTripLeg: true }));
      return Response.json({ tripLegs: [{ serviceJourneys: [{ gid: '9015014500106080', serviceJourneyCoordinates }] }], tariffZones: [] });
    }
    return new Response(`no matching resource found for path : ${url.pathname}`, { status: 404 });
  });
  return {
    server,
    asked,
    gone,
    subscribes,
    tokens: () => tokens,
    /** Makes Västtrafik take only a new token, as when one is revoked. */
    revoke: () => valid = `token-${tokens + 1}`,
    url: `http://127.0.0.1:${server.addr.port}`,
  };
};

Deno.test('the box around stops has the margin on every side, and a marker the darker of its line’s colours', () => {
  const box = boxAround([{ gid: BRUNNSPARKEN, name: 'Brunnsparken', label: 'Brunnsparken', lat: 57.7, lng: 11.97 }], 1000);
  assertEquals(box, { south: 57.691, west: 11.9532, north: 57.709, east: 11.9868 });
  assertEquals(darkerColour({ designation: '60', name: '60', background: '#ffff50', foreground: '#0061eb', mode: 'bus' }), '#0061eb');
  assertEquals(darkerColour({ designation: '18', name: '18', background: '#323232', foreground: '#ffff50', mode: 'bus' }), '#323232');
});

Deno.test('a path is clipped to the stretches that cross the box, each with the ends of its segments, one crossing it without a point in it too', () => {
  const box = { south: 0, west: 0, north: 10, east: 10 };
  assertEquals(clip([[-5, 5], [5, 5], [15, 5], [20, 5], [20, 20], [5, 20], [5, -20], [5, 5]], box), [[[-5, 5], [5, 5], [15, 5]], [[5, 20], [5, -20], [5, 5]]]);
  assertEquals(clip([[20, 20], [30, 30]], box), []);
});

Deno.test('a stop’s name on the map is whole when it fits, else its first words or its start', () => {
  assertEquals(['Brunnsparken', 'Sahlgrenska Huvudentré', 'Bergsjön-Rymdtorget', 'Centralstationen'].map(shortName), [
    'Brunnsparken',
    'Sahlgrenska…',
    'Bergsjön…',
    'Centralstat…',
  ]);
});

const tram = { designation: '6', name: '6', background: '#fda00a', foreground: '#ffffff', mode: 'tram' };
// Along latitude 57.7, where 0.001° of longitude is 60 metres.
const stretches = measure([{ line: tram, direction: 'Kortedala', paths: [[[57.7, 11.9], [57.7, 11.99]]] }]);
const tramAt = (ref: string, lng: number, trail: [number, number, number][] = [], lat = 57.7) => ({ ref, line: tram, direction: 'Kortedala', lat, lng, trail });
const round = (value: number) => Math.round(value * 10_000) / 10_000;
/** The positions' period the vehicles are steered by: answers five seconds apart. */
const PERIOD_MS = 5_000;

Deno.test('behind a vehicle on its track runs where it was a minute ago, and ahead of it the next 200 metres', () => {
  const courses: Courses = new Map();
  steer(courses, [tramAt('tram', 11.95, [[57.7001, 11.92, 360], [57.7, 11.93, 120], [57.6999, 11.94, 60]]), tramAt('elsewhere', 11.95, [], 57.71)], stretches, 0, PERIOD_MS);
  const { vehicles, pieces } = frame(courses, stretches, 0);
  assertEquals(vehicles.map((vehicle) => vehicle.lng), [11.95, 11.95]);
  assertEquals(pieces.map((piece) => [piece.id, piece.ahead, piece.points[0][1], piece.points.at(-1)![1]].map((each) => typeof each === 'number' ? round(each) : each)), [
    ['tram ahead', true, 11.95, 11.9534],
    ['tram behind', false, 11.94, 11.95],
  ]);
});

Deno.test('a vehicle drives along its track to where each answer puts it, and one answered back waits until it is answered past where it was going', () => {
  const courses: Courses = new Map();
  const at = (now: number) => frame(courses, stretches, now).vehicles.map((vehicle) => round(vehicle.lng));
  steer(courses, [tramAt('tram', 11.95)], stretches, 0, PERIOD_MS);
  steer(courses, [tramAt('tram', 11.951)], stretches, 6_000, PERIOD_MS);
  assertEquals(at(9_000), [11.9505]);
  steer(courses, [tramAt('tram', 11.949)], stretches, 12_000, PERIOD_MS);
  assertEquals(at(15_000), [11.951]);
  steer(courses, [tramAt('tram', 11.952)], stretches, 18_000, PERIOD_MS);
  assertEquals(at(21_000), [11.9515]);
  // 600 metres back is too far to be Västtrafik's own guess: it is put there.
  steer(courses, [tramAt('tram', 11.942)], stretches, 24_000, PERIOD_MS);
  assertEquals(at(24_000), [11.942]);
  steer(courses, [], stretches, 30_000, PERIOD_MS);
  assertEquals(courses.size, 0);
});

Deno.test('a vehicle off its track drives straight to where it is answered', () => {
  const courses: Courses = new Map();
  steer(courses, [tramAt('bus', 11.95, [], 57.71)], stretches, 0, PERIOD_MS);
  steer(courses, [tramAt('bus', 11.96, [], 57.71)], stretches, 6_000, PERIOD_MS);
  assertEquals(frame(courses, stretches, 9_000), { vehicles: [{ ...tramAt('bus', 11.955, [], 57.71) }], pieces: [] });
});

Deno.test({ name: 'the Västtrafik commands ask the API once for what they keep', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const api = stubVasttrafik();
  const testCtx = createTestContext({ modules: ['vasttrafik'], boot: true });
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  try {
    await t.step('without a key they say whom to ask', async () => {
      await admin.execString(`config set CFG_VASTTRAFIK_URL ${api.url}`);
      const result = await admin.exec('vt-stops');
      assertEquals(result.success, false);
      assertMatch(result.error ?? '', /no Västtrafik key: an administrator sets CFG_VASTTRAFIK_KEY/);
      assertEquals(await admin.execJson<HealthCheck[]>('vt-status'), [
        { name: 'key', state: 'fail', reason: 'No key is set, so the Västtrafik cards and commands have nothing to show.' },
      ]);
      assertEquals(api.tokens(), 0);
    });

    await t.step('a key Västtrafik refuses is said so', async () => {
      await admin.execString(`config set CFG_VASTTRAFIK_KEY ${btoa('app-id:wrong')}`);
      assertEquals(await admin.execJson<HealthCheck[]>('vt-status'), [
        { name: 'key', state: 'fail', reason: 'Västtrafik refuses the key: check CFG_VASTTRAFIK_KEY.' },
      ]);
    });

    await admin.execString(`config set CFG_VASTTRAFIK_KEY ${KEY}`);

    await t.step('the stops in use, by name, found by words with or without accents', async () => {
      const all = await admin.execJson<VtStop[]>('vt-stops');
      assertEquals(all.map((stop) => [stop.gid, stop.label]), [[BRUNNSPARKEN, 'Brunnsparken, Göteborg'], [KUNGALV, 'Kungälvs busstation, Kungälv']]);
      assertEquals((await admin.execJson<VtStop[]>('vt-stops kungalv')).map((stop) => stop.gid), [KUNGALV]);
      assertEquals((await admin.execJson<VtStop[]>('vt-stops --municipality göteborg')).map((stop) => stop.gid), [BRUNNSPARKEN]);
      assertEquals(api.asked.filter((path) => path.startsWith('/geo/')).length, 1);
      assertEquals(api.tokens(), 1);
      const refused = await admin.exec('vt-departures 9021014009999000');
      assertMatch(refused.error ?? '', /9021014009999000: no such stop area/);
    });

    await t.step('the next departures, by when they are now expected, and asked again only once they are 20 s old', async () => {
      const [board] = await admin.execJson<VtDepartures[]>(`vt-departures ${BRUNNSPARKEN} --limit 4`);
      assertEquals(board.stop, { gid: BRUNNSPARKEN, name: 'Brunnsparken, Göteborg' });
      assertEquals(board.departures.map((each) => [each.line.designation, each.direction, each.estimated?.slice(11, 16) ?? each.planned.slice(11, 16)]), [
        ['6', 'Kortedala', '17:30'],
        ['60', 'Redbergsplatsen', '17:33'],
      ]);
      assertEquals(board.departures[1].line, {
        gid: BUS_60.gid,
        designation: '60',
        name: 'Buss 60',
        background: '#ffff50',
        foreground: '#0061eb',
        border: '#0061eb',
        mode: 'bus',
      });
      assert(board.freshMs > 10_000 && board.freshMs <= 20_000, `fresh for ${board.freshMs} ms`);
      const [later] = await admin.execJson<VtDepartures[]>(`vt-departures ${BRUNNSPARKEN} --limit 5`);
      assert(later.freshMs <= board.freshMs, 'the same answer, fresh for no longer');
      assertEquals(api.asked.filter((path) => path.includes('/departures')), [`/pr/v4/stop-areas/${BRUNNSPARKEN}/departures?limit=5`]);
      const text = await admin.execString(`vt-departures ${BRUNNSPARKEN}`, { json: false });
      assertMatch(text, /17:33 {2}60 {4}Redbergsplatsen {2}\(C2\) {2}\+5 min/);
    });

    await t.step('a few lines are asked for as so many of each, and a platform takes the ones under it', async () => {
      const [board] = await admin.execJson<VtDepartures[]>(`vt-departures ${BRUNNSPARKEN} --line 6 --platform B`);
      assertEquals(board.departures.map((each) => [each.line.designation, each.direction, each.cancelled]), [['6', 'Länsmansgården', true]]);
      assert(api.asked.some((path) => path.includes('timeSpanInMinutes=180&maxDeparturesPerLineAndDirection=10')));
    });

    await t.step('the lines at a stop, with their directions, and its platforms', async () => {
      const lines = await admin.execJson<VtLines>(`vt-lines ${BRUNNSPARKEN}`);
      assertEquals(lines.lines.map((each) => [each.designation, each.directions]), [['6', ['Kortedala', 'Länsmansgården']], ['60', ['Redbergsplatsen']]]);
      assertEquals(lines.platforms, [{ platform: 'A1' }, { platform: 'B1' }, { platform: 'C2' }]);
    });

    await t.step('the vehicles around a stop, of the lines asked for', async () => {
      const found = await admin.execJson<VtPositions>(`vt-positions --around ${BRUNNSPARKEN} --margin 500 --line 60`);
      assertEquals(found.box, { south: 57.7024, west: 11.9594, north: 57.7114, east: 11.9763 });
      assertEquals(found.vehicles.map((each) => [each.ref, each.line.designation, each.direction, each.lat]), [['journey-60', '60', 'Redbergsplatsen', 57.7101]]);
      assertEquals(found.stops.map((stop) => stop.gid), [BRUNNSPARKEN]);
      assert(found.freshMs > 0 && found.freshMs <= 5_000, `fresh for ${found.freshMs} ms`);
      assertEquals(found.periodMs, 5_000);
      assert(api.asked.some((path) => path.startsWith('/pr/v4/positions?lowerLeftLat=57.7024&lowerLeftLong=11.9594') && path.endsWith('lineDesignations=60')));
      assertEquals((await admin.exec('vt-positions')).success, false);
    });

    await t.step('the vehicles in a box of their own, with the stops and the box around them', async () => {
      const found = await admin.execJson<VtPositions>(`vt-positions --around ${BRUNNSPARKEN} --margin 500 --bbox=57.69,11.94,57.72,11.99 --line 6`);
      assertEquals(found.box, { south: 57.69, west: 11.94, north: 57.72, east: 11.99 });
      assertEquals(found.around, { south: 57.7024, west: 11.9594, north: 57.7114, east: 11.9763 });
      assertEquals(found.stops.map((stop) => stop.gid), [BRUNNSPARKEN]);
      assert(api.asked.some((path) => path.startsWith('/pr/v4/positions?lowerLeftLat=57.69&lowerLeftLong=11.94&upperRightLat=57.72&upperRightLong=11.99')));
      assertEquals(found.vehicles.map((each) => each.trail), [[], []], 'not asked about before');
      const again = await admin.execJson<VtPositions>('vt-positions --bbox=57.69,11.94,57.72,11.98 --line 6');
      assertEquals(again.vehicles.map((each) => each.trail), [[[57.7068, 11.969, 0]], [[57.7051, 11.9632, 0]]], 'where each was when last asked');
    });

    await t.step('the tracks of the lines in the box, one journey asked for each line and direction', async () => {
      const found = await admin.execJson<VtTracks>(`vt-tracks --around ${BRUNNSPARKEN} --margin 500`);
      assertEquals(found.box, { south: 57.7024, west: 11.9594, north: 57.7114, east: 11.9763 });
      assertEquals(found.tracks.map((track) => [track.line.designation, track.direction, track.line.background, track.paths]), [
        ['6', 'Kortedala', '#fda00a', [[[57.705, 11.962], [57.706, 11.965], [57.705, 12.01]], [[57.705, 12.02], [57.706, 11.97], [57.707, 11.968]]]],
        ['60', 'Redbergsplatsen', '#ffff50', [[[57.69, 11.96], [57.705, 11.965], [57.708, 11.97], [57.74, 11.98]]]],
      ], 'line 5, whose journey Västtrafik cannot give, is left out');
      const details = () => api.asked.filter((path) => path.startsWith('/pr/v4/journeys/')).map((path) => path.split('/')[4]);
      assertEquals(details().sort(), ['journey-5', 'journey-60', 'journey-6a']);
      assert(api.asked.includes('/pr/v4/journeys/journey-60/details?includes=servicejourneycoordinates'));
      const text = await admin.execString(`vt-tracks --around ${BRUNNSPARKEN} --margin 500`, { json: false });
      assertEquals(text, '6     Kortedala  6 points\n60    Redbergsplatsen  4 points\n');
      assertEquals(details().sort(), ['journey-5', 'journey-5', 'journey-60', 'journey-6a'], 'a path is kept, a failure is asked again');
      const none = await admin.exec(`vt-tracks --around ${BRUNNSPARKEN} --line 5`);
      assertEquals(none.success, false);
      assertMatch(none.error ?? '', /vt-tracks: Västtrafik answers 500/);
    });

    await t.step('a line stays drawn after its vehicles have left the box, and only where its path crosses the box', async () => {
      api.gone.add('journey-60');
      const found = await admin.execJson<VtTracks>('vt-tracks --bbox=57.70,11.95,57.72,11.99 --line 6,60');
      assertEquals(found.tracks.map((track) => [track.line.designation, track.direction]), [['6', 'Kortedala'], ['60', 'Redbergsplatsen']]);
      const far = await admin.execJson<VtTracks>('vt-tracks --bbox=58.00,12.50,58.10,12.60 --line 6');
      assertEquals(far.tracks, []);
      api.gone.clear();
    });

    await t.step('the disruptions in effect at a stop or on a line, the worst first, from one copy', async () => {
      const at = await admin.execJson<VtDisruptions>(`vt-disruptions --stop ${BRUNNSPARKEN} --line ${TRAM_6.gid}`);
      assertEquals(at.disruptions.map((one) => one.id), ['RT2', 'RT1']);
      assertEquals(at.disruptions[1].stops, [{ gid: BRUNNSPARKEN, name: 'Brunnsparken, Göteborg' }]);
      assertEquals(at.disruptions[0].lines, [
        { gid: TRAM_6.gid, designation: '6', name: '6', background: '#fda00a', foreground: '#ffffff', mode: 'tram' },
      ]);
      const byName = await admin.execJson<VtDisruptions>('vt-disruptions --line 6');
      assertEquals(byName.disruptions.map((one) => one.id), ['RT2', 'RT3']);
      const ahead = await admin.execJson<VtDisruptions>(`vt-disruptions --line ${BUS_60.gid} --ahead 168`);
      assertEquals(ahead.disruptions.map((one) => one.id), [], 'one starting in 2099 is not within a week');
      assertEquals((await admin.execJson<VtDisruptions>('vt-disruptions')).disruptions.length, 3);
      assertEquals(api.asked.filter((path) => path.startsWith('/ts/')), ['/ts/v1/traffic-situations']);
      const text = await admin.execString(`vt-disruptions --stop ${BRUNNSPARKEN}`, { json: false });
      assertMatch(text, /^slight {2}2026-11-01 00:00 – 2099-12-31 23:59\n {2}Brunnsparken läge C är flyttad\n {2}Orsaken är vägarbete\./);
      assertEquals((await admin.exec('vt-disruptions --stop brunnsparken')).success, false);
      assert(at.freshMs > 4 * 60_000 && at.freshMs <= 5 * 60_000, `fresh for ${at.freshMs} ms`);
    });

    await t.step('an answer is kept as long as its setting says, held within what the setting takes', async () => {
      await admin.execString('config set CFG_VASTTRAFIK_DEPARTURES_SECONDS 60 && config set CFG_VASTTRAFIK_POSITIONS_SECONDS 1');
      const [board] = await admin.execJson<VtDepartures[]>(`vt-departures ${BRUNNSPARKEN} --limit 20`);
      assert(board.freshMs > 50_000 && board.freshMs <= 60_000, `fresh for ${board.freshMs} ms`);
      const found = await admin.execJson<VtPositions>(`vt-positions --around ${KUNGALV}`);
      assertEquals(found.periodMs, 2_000, 'two seconds at the least');
      await admin.execString('config unset CFG_VASTTRAFIK_DEPARTURES_SECONDS && config unset CFG_VASTTRAFIK_POSITIONS_SECONDS');
    });

    await t.step('vt-status: the key is taken, and each API answers, asked anew', async () => {
      const before = api.asked.length;
      const checks = await admin.execJson<HealthCheck[]>('vt-status');
      assertEquals(checks.map((check) => [check.name, check.state]), [['key', 'ok'], ['Planera Resa v4', 'ok'], ['Geografi v3', 'ok'], ['Störning v1', 'ok']]);
      assertEquals(checks[2].reason, 'Geografi v3 answers: the stops.');
      assertEquals(api.asked.slice(before).map((path) => path.split('?')[0]).sort(), ['/geo/v3/StopAreas', '/pr/v4/positions', '/ts/v1/traffic-situations']);
    });

    await t.step('a token no longer taken is renewed once', async () => {
      api.revoke();
      await admin.execJson(`vt-lines ${BRUNNSPARKEN},${KUNGALV}`);
      assertEquals(api.tokens(), 2);
    });
  } finally {
    await testCtx.teardown();
    await api.server.shutdown();
  }
});

Deno.test({ name: 'an API the application does not subscribe to is named', sanitizeResources: false, sanitizeOps: false }, async () => {
  const api = stubVasttrafik();
  api.subscribes.geo = false;
  const testCtx = createTestContext({ modules: ['vasttrafik'], boot: true });
  await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  try {
    await admin.execString(`config set CFG_VASTTRAFIK_URL ${api.url} && config set CFG_VASTTRAFIK_KEY ${KEY}`);
    const result = await admin.exec('vt-stops');
    assertEquals(result.success, false);
    assertMatch(result.error ?? '', /the Västtrafik application does not subscribe to Geografi v3/);
    const checks = await admin.execJson<HealthCheck[]>('vt-status');
    assertEquals(checks.map((check) => [check.name, check.state]), [['key', 'ok'], ['Planera Resa v4', 'ok'], ['Geografi v3', 'fail'], ['Störning v1', 'ok']]);
    assertEquals(checks[2].reason, 'The Västtrafik application does not subscribe to Geografi v3.');
  } finally {
    await testCtx.teardown();
    await api.server.shutdown();
  }
});
