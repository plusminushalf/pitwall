// Where Overtake Mode's 1 s gap is measured at each circuit (2026 on), from the FIA's documents for each Grand Prix:
// the Power Unit Information sheet's "Detection Line" (Art. B7.2.1b.viii, a timing loop) as metres from the line along
// that sheet's centreline, and the circuit map's Overtake box for where that is. Not in the Race Director's notes.
// Keyed by OpenF1's circuit_short_name (the session's `circuit`), as data/circuits.ts. A circuit a new season adds
// needs a line here; one without falls back to the entry of its last corner (engine/overtakeMode.ts).
//
// Source: https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2026-2072
// ("<Grand Prix> - Power Unit Information" and "... - Competition Notes - Circuit Map ..." for each event).

export interface Detection {
    /** Metres from the line to the detection line, along the FIA's centreline. */
    at: number
    /** The FIA's centreline length (m): `at` is scaled onto the session's measured lap length. */
    centreline: number
    /** The circuit map's words for it. */
    where: string
}

export const OVERTAKE_DETECTION: Readonly<Record<string, Detection>> = {
    Melbourne: { at: 4650, centreline: 5278, where: "15 m after T13" },
    Shanghai: { at: 5130, centreline: 5451, where: "entry T16" },
    Suzuka: { at: 5480, centreline: 5807, where: "exit T17" },
    Miami: { at: 4908, centreline: 5412, where: "20 m after T17" },
    Montreal: { at: 3870, centreline: 4361, where: "entry T13" },
    "Monte Carlo": { at: 2805, centreline: 3337, where: "80 m after T16" },
    Catalunya: { at: 4047, centreline: 4657, where: "apex T13" },
    // The PU sheet says 4,236 m, the circuit map 4,326 m (the circuit is 4.318 km): the map's.
    Spielberg: { at: 3936, centreline: 4326, where: "50 m before T10" },
    Silverstone: { at: 5560, centreline: 5891, where: "exit T17" },
    "Spa-Francorchamps": { at: 6745, centreline: 7004, where: "entry T19" },
    Hungaroring: { at: 3974, centreline: 4381, where: "entry T14" },
    Zandvoort: { at: 3431, centreline: 4259, where: "10 m before T13" },
    Monza: { at: 5050, centreline: 5793, where: "entry T11" },
    Madring: { at: 5160, centreline: 5416, where: "entry T22" },
    Baku: { at: 4177, centreline: 6003, where: "90 m after T16" },
    Singapore: { at: 4350, centreline: 4927, where: "entry T17" },
    // The 2026 Bahrain Grand Prix, held at Sepang.
    "Kuala Lumpur": {
        at: 5110,
        centreline: 5543,
        where: "45 m before T15 exit"
    },
    Austin: { at: 5326, centreline: 5513, where: "30 m after T20" }
}
