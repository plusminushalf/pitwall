// Raw OpenF1 record shapes (only the fields we use).

export interface RawSession {
  session_key: number;
  meeting_key: number;
  session_name: string;
  session_type: string;
  date_start: string;
  date_end: string;
  year: number;
  circuit_short_name: string;
  country_name: string;
  location: string;
  gmt_offset: string;
  is_cancelled?: boolean;
}

export interface RawMeeting {
  meeting_key: number;
  meeting_name: string;
  circuit_info_url?: string | null; // MultiViewer circuit API: rotation, corners, marshal sectors
}

export interface RawCircuitPoint {
  number: number;
  angle: number;
  length: number;
  trackPosition: { x: number; y: number };
}

export interface RawCircuit {
  rotation: number;
  corners: RawCircuitPoint[];
  marshalSectors: RawCircuitPoint[];
  pitLoss?: { normal: string; sc: string; vsc: string };
  // Trace of one lap in the OpenF1 location frame (decimetres), starting at the timing line.
  x?: number[];
  y?: number[];
}

export interface RawDriver {
  driver_number: number;
  broadcast_name: string;
  full_name: string;
  name_acronym: string;
  team_name: string | null;
  team_colour: string | null;
  headshot_url: string | null;
}

export interface RawLap {
  driver_number: number;
  lap_number: number;
  date_start: string | null;
  lap_duration: number | null;
  duration_sector_1: number | null;
  duration_sector_2: number | null;
  duration_sector_3: number | null;
  segments_sector_1: (number | null)[] | null;
  segments_sector_2: (number | null)[] | null;
  segments_sector_3: (number | null)[] | null;
  i1_speed: number | null;
  i2_speed: number | null;
  st_speed: number | null;
  is_pit_out_lap: boolean;
}

export interface RawStint {
  driver_number: number;
  stint_number: number;
  lap_start: number;
  lap_end: number;
  compound: string | null;
  tyre_age_at_start: number | null;
}

export interface RawPit {
  date: string;
  driver_number: number;
  lap_number: number;
  pit_duration: number | null;
  lane_duration?: number | null;
  stop_duration?: number | null;
}

export interface RawPosition {
  date: string;
  driver_number: number;
  position: number;
}

export interface RawInterval {
  date: string;
  driver_number: number;
  gap_to_leader: number | string | null;
  interval: number | string | null;
}

export interface RawRaceControl {
  date: string;
  lap_number: number | null;
  category: string;
  flag: string | null;
  scope: string | null;
  sector: number | null;
  driver_number: number | null;
  message: string;
}

export interface RawWeather {
  date: string;
  air_temperature: number;
  track_temperature: number;
  humidity: number;
  pressure: number;
  rainfall: number;
  wind_speed: number;
  wind_direction: number;
}

export interface RawRadio {
  date: string;
  driver_number: number;
  recording_url: string;
}

export interface RawOvertake {
  date: string;
  overtaking_driver_number: number;
  overtaken_driver_number: number;
  position: number;
}

export interface RawResult {
  driver_number: number;
  position: number | null;
  number_of_laps: number | null; // null for disqualified drivers
  points: number | null;
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
  duration: number | number[] | null;
  gap_to_leader: number | string | number[] | null;
}

export interface RawCarData {
  date: string;
  speed: number;
  rpm: number;
  n_gear: number;
  throttle: number;
  brake: number;
  drs: number | null;
}

export interface RawLocation {
  date: string;
  x: number;
  y: number;
  z: number;
}
