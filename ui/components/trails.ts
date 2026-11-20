import type { VtTrack, VtVehicle } from '../../lib/api.ts';

/** How long a trail takes to fade out, in seconds. */
export const FADE_S = 600;

/** How many steps it fades in, each drawn a little fainter than the one before. */
const STEPS = 5;

/** How far from its track a vehicle, or a point of its trail, may be and still be on it, in metres. */
const NEAR_M = 150;

const METRES_PER_DEGREE = 111_320;

type Point = [number, number];

/** A piece of the trail behind `vehicle`, along its track: `age` is how many seconds ago it drove its middle. */
type TrailPiece = { id: string; vehicle: VtVehicle; points: Point[]; age: number };

/** A stretch of a track as `[lat, lng]`, the same in metres, and how far along the stretch each point lies. */
type Measured = { points: Point[]; xy: Point[]; along: number[] };

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

/**
 * The trails behind `vehicles` along `tracks`: for each vehicle on its line's track, the stretch it
 * drove in the last ten minutes as its `trail` says, in pieces of two minutes each, the newest first.
 * A trail stops where the next vehicle of its line and direction behind it is, which draws its own,
 * so a stretch shows how long ago one last passed. A vehicle off its track, or with no trail yet,
 * has none.
 */
export const trails = (vehicles: VtVehicle[], tracks: VtTrack[]): TrailPiece[] => {
  if (!vehicles.length) return [];
  const cos = Math.cos((vehicles[0].lat * Math.PI) / 180);
  const xy = (lat: number, lng: number): Point => [lng * METRES_PER_DEGREE * cos, lat * METRES_PER_DEGREE];
  const stretches = new Map<string, Measured[]>();
  for (const track of tracks) {
    stretches.set(
      `${track.line.designation} ${track.direction}`,
      track.paths.map((points) => {
        const metres = points.map(([lat, lng]) => xy(lat, lng));
        const along = [0];
        for (let i = 1; i < metres.length; i++) along.push(along[i - 1] + Math.hypot(metres[i][0] - metres[i - 1][0], metres[i][1] - metres[i - 1][1]));
        return { points, xy: metres, along };
      }),
    );
  }

  const placed = vehicles.flatMap((vehicle) => {
    let best: { vehicle: VtVehicle; stretch: Measured; along: number; off: number } | undefined;
    for (const stretch of stretches.get(`${vehicle.line.designation} ${vehicle.direction}`) ?? []) {
      const at = place(stretch, xy(vehicle.lat, vehicle.lng));
      if (at.off <= NEAR_M && (!best || at.off < best.off)) best = { vehicle, stretch, ...at };
    }
    return best ? [best] : [];
  });

  const pieces: TrailPiece[] = [];
  for (const { vehicle, stretch, along } of placed) {
    const behind = Math.max(0, ...placed.filter((other) => other.stretch === stretch && other.along < along).map((other) => other.along));
    // How far along the stretch it was how many seconds ago, the newest first; each no further on than the one after it.
    const knots: [number, number][] = [[along, 0]];
    for (const [lat, lng, age] of [...vehicle.trail].reverse()) {
      const at = place(stretch, xy(lat, lng), knots.at(-1)![0]);
      if (at.off > NEAR_M) break;
      knots.push([at.along, age]);
    }
    if (knots.length < 2) continue;
    const alongAt = (age: number): number => {
      const k = knots.findIndex(([, each]) => each >= age);
      if (k < 0) return knots.at(-1)![0];
      if (k === 0) return knots[0][0];
      const [[a0, t0], [a1, t1]] = [knots[k - 1], knots[k]];
      return a0 + ((age - t0) / (t1 - t0)) * (a1 - a0);
    };
    for (let step = 0; step < STEPS; step++) {
      const [young, old] = [(step * FADE_S) / STEPS, ((step + 1) * FADE_S) / STEPS];
      const [from, to] = [Math.max(alongAt(old), behind), alongAt(young)];
      if (to - from < 1) continue;
      pieces.push({ id: `${vehicle.ref} ${step}`, vehicle, points: between(stretch, from, to), age: (young + old) / 2 });
    }
  }
  return pieces;
};
