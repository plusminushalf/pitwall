/** OpenF1 endpoints / MQTT topics (`v1/<topic>`) live mode uses: the relay's, and what the page subscribes to in the vault. */
export const TOPICS = [
  "sessions",
  "drivers",
  "laps",
  "stints",
  "pit",
  "position",
  "intervals",
  "race_control",
  "weather",
  "team_radio",
  "overtakes",
  "session_result",
  "car_data",
  "location",
] as const;
export type Topic = (typeof TOPICS)[number];
