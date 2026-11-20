/**
 * What the Västtrafik commands answer under `JSON_OUTPUT=1`. Import-free, for the commands, the
 * cards and other modules alike.
 */

/** A stop area, as `vt-stops` lists it: where every line stopping there has its platforms. */
export type VtStop = {
  /** Västtrafik's id for it, 16 digits, which the other commands take. */
  gid: string;
  name: string;
  /** The municipality it is in, when Västtrafik says. */
  municipality?: string;
  /** Its name with the municipality after it, as a choice shows it: `Brunnsparken, Göteborg`. */
  label: string;
  lat?: number;
  lng?: number;
};

/** A line's look and kind, as Västtrafik draws it. */
export type VtLine = {
  /** Västtrafik's id for it, 16 digits, when the answer gives one: unlike the designation, the same in no two places. */
  gid?: string;
  /** What its signs say: `6`, `X5`, `Rosa Express`. */
  designation: string;
  /** Its full name, `Spårvagn 6`, when Västtrafik gives one; else the designation. */
  name: string;
  /** Its colours as CSS `#rrggbb`. */
  background: string;
  foreground: string;
  border?: string;
  /** `tram`, `bus`, `ferry`, `train`, `taxi`, or `unknown`. */
  mode: string;
};

/** The lines that call at one or more stops, as `vt-lines` answers. */
export type VtLines = {
  stops: string[];
  /** Each line once, in the order of their designations. */
  lines: (VtLine & { directions: string[] })[];
  /** Each platform once, `A`, `B1`, in order. */
  platforms: { platform: string }[];
};

/** One departure from a stop. */
export type VtDeparture = {
  line: VtLine;
  /** Where it is going, short: `Tynnered`. */
  direction: string;
  /** Where it stops: `A1`. */
  platform?: string;
  /** When it was planned to leave, ISO 8601 with offset. */
  planned: string;
  /** When it is expected to leave now, when Västtrafik knows. */
  estimated?: string;
  cancelled: boolean;
  /** Cancelled for part of its way. */
  partCancelled: boolean;
};

/** A stop's next departures, as `vt-departures` answers for each stop it is given. */
export type VtDepartures = {
  stop: { gid: string; name: string };
  departures: VtDeparture[];
  /** When Västtrafik was asked, ISO 8601. */
  at: string;
  /**
   * How long this answer stays fresh, in milliseconds: EiN asks Västtrafik again once it is due, and
   * gives this same answer to whoever asks before. 0 when it is due already, or when Västtrafik did
   * not answer and this is the last answer it gave.
   */
  freshMs: number;
};

/** A vehicle where it is now. */
export type VtVehicle = {
  /** The journey it is on, today only. */
  ref: string;
  line: VtLine;
  direction: string;
  lat: number;
  lng: number;
  /**
   * Where it was over the last ten minutes, oldest first, a point every half minute or so, as
   * `[lat, lng, seconds before the answer]`; as far back as the module has asked about it.
   */
  trail: [number, number, number][];
};

/** The vehicles in a box, as `vt-positions` answers. */
export type VtPositions = {
  box: { south: number; west: number; north: number; east: number };
  /** The stops given with `--around`. */
  stops: VtStop[];
  /** The box around them with `--margin`, which is `box` unless `--bbox` named another. */
  around?: { south: number; west: number; north: number; east: number };
  vehicles: VtVehicle[];
  /** When Västtrafik was asked, ISO 8601. */
  at: string;
  /**
   * How long this answer stays fresh, in milliseconds: EiN asks Västtrafik again once it is due, and
   * gives this same answer to whoever asks before. 0 when it is due already, or when Västtrafik did
   * not answer and this is the last answer it gave.
   */
  freshMs: number;
};

/** Where one line runs in one direction, as the journey of a vehicle on it runs. */
export type VtTrack = {
  line: VtLine;
  /** Where it is going, short, as the vehicle says: `Kortedala`. */
  direction: string;
  /** Each stretch of its path that crosses the box, as `[lat, lng]` pairs in order. */
  paths: [number, number][][];
};

/** The tracks of the lines through a box, as `vt-tracks` answers. */
export type VtTracks = {
  box: { south: number; west: number; north: number; east: number };
  /** One for each line and direction, in the order of their designations. */
  tracks: VtTrack[];
  /** When Västtrafik was asked for the vehicles, ISO 8601. */
  at: string;
};

/** A disruption: a moved platform, a diversion, a line not running. */
export type VtDisruption = {
  /** Västtrafik's number for it: `RT3082417`. */
  id: string;
  title: string;
  description?: string;
  /** How much it disrupts, as Västtrafik says: `slight`, `normal` or `severe`. */
  severity: string;
  /** When it starts and ends, ISO 8601 with offset. */
  start: string;
  end?: string;
  /** The stop areas it names, each once. */
  stops: { gid: string; name: string }[];
  /** The lines it names. */
  lines: VtLine[];
};

/** The disruptions in effect, as `vt-disruptions` answers. */
export type VtDisruptions = {
  disruptions: VtDisruption[];
  /** When Västtrafik was asked, ISO 8601. */
  at: string;
};
