// Teams' colours for the history sheets and pages, by F1DB constructor id: OpenF1's team_colour for the season (the
// timing tower's stripe), so a team reads the same on Home as in a replay. F1DB has no colours; when a team joins or
// changes its livery colour, add it here. A team not listed gets no stripe.

const COLORS: Record<string, string> = {
  alpine: "00A1E8",
  "aston-martin": "229971",
  audi: "F50537",
  cadillac: "909090",
  ferrari: "ED1131",
  haas: "9C9FA2",
  mclaren: "F47600",
  mercedes: "00D7B6",
  "racing-bulls": "6C98FF",
  "red-bull": "4781D7",
  williams: "1868DB",
};

/** "#00D7B6", or null for a team without one. */
export const teamColor = (id: string): string | null => (COLORS[id] ? `#${COLORS[id]}` : null);
