import type { VtTrack, VtVehicle } from '../../lib/api.ts';

/** How far back the trail behind a vehicle reaches, in seconds. */
const BEHIND_S = 60;

/** How much of its track ahead of a vehicle is drawn, in metres. */
const AHEAD_M = 200;

/**
 * How much longer than the answers' period a vehicle takes to drive to where an answer puts it, in
 * milliseconds: an answer comes a little after it is due, and a vehicle should never stop to wait.
 */
const LATE_MS = 1_000;

/**
 * How far back along its track a vehicle may be answered and still be held where it was going, in
 * metres. Västtrafik moves a vehicle on between its own fixes, and when a fix comes it may put the
 * vehicle 50 to 200 metres back.
 */
const HOLD_M = 500;

/** How far from its track a vehicle, or a point of its trail, may be and still be on it, in metres. */
const NEAR_M = 150;

const METRES_PER_DEGREE = 111_320;

type Point = [number, number];

/** A piece of the line drawn along a vehicle's track, from where it was to where it is, or on from there where it is going. */
type TrailPiece = { id: string; vehicle: VtVehicle; points: Point[]; ahead: boolean };

/** A stretch of a track as `[lat, lng]`, the same in metres, and how far along the stretch each point lies. */
type Measured = { points: Point[]; xy: Point[]; along: number[] };

/** The lines' tracks measured, by line and direction, and how to turn a spot into metres. */
type Stretches = { byLine: Map<string, Measured[]>; xy: (lat: number, lng: number) => Point };

/**
 * Where a vehicle drives: on a stretch of its track from `from` metres along it to `to`, or, off
 * its track, straight from one spot to the other; starting at `start`, taking `drive` milliseconds.
 */
type Course =
  & { vehicle: VtVehicle; start: number; drive: number }
  & (
    | { stretch: Measured; from: number; to: number }
    | { stretch?: undefined; from: Point; to: Point }
  );

/** Where each vehicle drives, by its journey. */
export type Courses = Map<string, Course>;

/** Where on `stretch` the point nearest `at` lies, no further along than `upTo`: how far along it, and how far from `at`. */
const place = (stretch: Measured, at: Point, upTo = Infinity): { along: number; off: number } => {
  const { xy, along } = stretch;
  let best = { along: 0, off: Infinity };
  for (let i = 1; i < xy.length && along[i - 1] <= upTo; i++) {
    const [a, b] = [xy[i - 1], xy[i]];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const squared = dx * dx + dy * dy;
    let t = squared ? Math.min(1, Math.max(0, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / squared)) : 0;
    if (along[i - 1] + t * (along[i] - along[i - 1]) > upTo) t = (upTo - along[i - 1]) / (along[i] - along[i - 1]);
    const off = Math.hypot(a[0] + t * dx - at[0], a[1] + t * dy - at[1]);
    if (off < best.off) best = { along: along[i - 1] + t * (along[i] - along[i - 1]), off };
  }
  return best;
};

/** The point `along` metres along `stretch`. */
const pointAt = (stretch: Measured, along: number): Point => {
  const { points } = stretch;
  const i = stretch.along.findIndex((each) => each >= along);
  if (i < 0) return points.at(-1)!;
  if (i === 0) return points[0];
  const [from, to] = [stretch.along[i - 1], stretch.along[i]];
  const t = to > from ? (along - from) / (to - from) : 0;
  return [points[i - 1][0] + t * (points[i][0] - points[i - 1][0]), points[i - 1][1] + t * (points[i][1] - points[i - 1][1])];
};

/** The part of `stretch` from `from` to `to` metres along it. */
const between = (stretch: Measured, from: number, to: number): Point[] => [
  pointAt(stretch, from),
  ...stretch.points.filter((_, i) => stretch.along[i] > from && stretch.along[i] < to),
  pointAt(stretch, to),
];

/** The lines' `tracks` measured in metres, once for every answer of the vehicles. */
export const measure = (tracks: VtTrack[]): Stretches => {
  const first = tracks.find((track) => track.paths[0]?.length)?.paths[0][0];
  const cos = Math.cos(((first?.[0] ?? 0) * Math.PI) / 180);
  const xy = (lat: number, lng: number): Point => [lng * METRES_PER_DEGREE * cos, lat * METRES_PER_DEGREE];
  const byLine = new Map<string, Measured[]>();
  for (const track of tracks) {
    byLine.set(
      `${track.line.designation} ${track.direction}`,
      track.paths.map((points) => {
        const metres = points.map(([lat, lng]) => xy(lat, lng));
        const along = [0];
        for (let i = 1; i < metres.length; i++) along.push(along[i - 1] + Math.hypot(metres[i][0] - metres[i - 1][0], metres[i][1] - metres[i - 1][1]));
        return { points, xy: metres, along };
      }),
    );
  }
  return { byLine, xy };
};

/** How far along its course `course` is at `now`, from 0 to 1. */
const progress = (course: Course, now: number): number => Math.min(1, Math.max(0, (now - course.start) / course.drive));

/** Where `course` has brought its vehicle at `now`. */
const spotAt = (course: Course, now: number): Point => {
  const t = progress(course, now);
  if (course.stretch) return pointAt(course.stretch, course.from + (course.to - course.from) * t);
  return [course.from[0] + (course.to[0] - course.from[0]) * t, course.from[1] + (course.to[1] - course.from[1]) * t];
};

/**
 * Sets where each of `vehicles`, as answered at `now`, drives next, getting there a little after the
 * next answer is due, `periodMs` on: from where it is drawn now to where it is answered, along its
 * line's track when it is on it, and straight when it is not; a vehicle new to the map starts where it is. A vehicle answered back along its track from where it
 * was going, by less than HOLD_M, goes on there and waits until it is answered past that spot, so it
 * never drives backwards. Forgets the vehicles no longer answered.
 */
export const steer = (courses: Courses, vehicles: VtVehicle[], stretches: Stretches, now: number, periodMs: number): void => {
  const drive = periodMs + LATE_MS;
  const answered = new Set(vehicles.map((vehicle) => vehicle.ref));
  for (const ref of courses.keys()) if (!answered.has(ref)) courses.delete(ref);
  const { xy } = stretches;
  for (const vehicle of vehicles) {
    const before = courses.get(vehicle.ref);
    const here = before && spotAt(before, now);
    const there: Point = [vehicle.lat, vehicle.lng];
    let best: { stretch: Measured; along: number; off: number } | undefined;
    for (const stretch of stretches.byLine.get(`${vehicle.line.designation} ${vehicle.direction}`) ?? []) {
      const at = place(stretch, xy(...there));
      if (at.off <= NEAR_M && (!best || at.off < best.off)) best = { stretch, ...at };
    }
    if (!best) {
      courses.set(vehicle.ref, { vehicle, start: now, drive, from: here ?? there, to: there });
      continue;
    }
    const { stretch } = best;
    const onIt = (spot: Point | undefined) => {
      if (!spot) return undefined;
      const at = place(stretch, xy(...spot));
      return at.off <= NEAR_M ? at.along : undefined;
    };
    const going = before && onIt(before.stretch ? pointAt(before.stretch, before.to) : before.to);
    const to = going !== undefined && going > best.along && going - best.along < HOLD_M ? going : best.along;
    const from = onIt(here);
    courses.set(vehicle.ref, { vehicle, start: now, drive, stretch, from: from !== undefined && from <= to ? from : to, to });
  }
};

/**
 * The vehicles where their `courses` have brought them at `now`, and the pieces of their tracks
 * drawn from there: behind each vehicle on its track the stretch it drove in the last minute as its
 * `trail` says, and ahead of it the next 200 metres of its track. A vehicle off its track has neither.
 */
export const frame = (courses: Courses, stretches: Stretches, now: number): { vehicles: VtVehicle[]; pieces: TrailPiece[] } => {
  const { xy } = stretches;
  const vehicles: VtVehicle[] = [];
  const pieces: TrailPiece[] = [];
  for (const course of courses.values()) {
    const [lat, lng] = spotAt(course, now);
    const vehicle = { ...course.vehicle, lat, lng };
    vehicles.push(vehicle);
    const { stretch } = course;
    if (!stretch) continue;
    const along = course.from + (course.to - course.from) * progress(course, now);

    const ahead = Math.min(along + AHEAD_M, stretch.along.at(-1)!);
    if (ahead - along >= 1) pieces.push({ id: `${vehicle.ref} ahead`, vehicle, points: between(stretch, along, ahead), ahead: true });

    // How far along the stretch it was how many seconds ago, the newest first; each no further on than the one after it.
    const knots: [number, number][] = [[along, 0]];
    for (const [lat, lng, age] of [...vehicle.trail].reverse()) {
      const at = place(stretch, xy(lat, lng), knots.at(-1)![0]);
      if (at.off > NEAR_M) break;
      knots.push([at.along, age]);
      if (age >= BEHIND_S) break;
    }
    if (knots.length < 2) continue;
    // Where it was a minute ago, between the two points of its trail around then.
    const k = knots.findIndex(([, age]) => age >= BEHIND_S);
    const [[a0, t0], [a1, t1]] = k < 0 ? [knots.at(-1)!, knots.at(-1)!] : [knots[k - 1], knots[k]];
    const back = t1 > t0 ? a0 + ((BEHIND_S - t0) / (t1 - t0)) * (a1 - a0) : a1;
    if (along - back >= 1) pieces.push({ id: `${vehicle.ref} behind`, vehicle, points: between(stretch, back, along), ahead: false });
  }
  return { vehicles, pieces };
};
