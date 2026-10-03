// What the MultiViewer circuit API doesn't give us: the maps of circuits it doesn't have, and corner names.
// Added to a session's track when it's loaded, so sessions processed before an entry was added get it too.

import type { TrackGeometry } from "../types";

type Corner = TrackGeometry["corners"][number];

/**
 * Circuits the MultiViewer API doesn't have, keyed by OpenF1's circuit_short_name: the rotation that shows them
 * the way F1's circuit maps do, and the corners numbered as on those maps. Each corner is on a qualifying lap's
 * path (OpenF1's location frame, decimetres), with `angle` pointing out of the bend, or into it where that's clearer.
 */
const CIRCUITS: Record<string, Pick<TrackGeometry, "rotation" | "corners">> = {
  // Sepang, which held the 2026 Bahrain Grand Prix.
  "Kuala Lumpur": {
    rotation: 0,
    corners: [
      { number: 1, x: -5046, y: -874, angle: 137 },
      { number: 2, x: -4263, y: -896, angle: 30 },
      { number: 3, x: -4392, y: 1751, angle: 156 },
      { number: 4, x: 250, y: 3855, angle: 72 },
      { number: 5, x: 1535, y: 790, angle: 64 },
      { number: 6, x: 3307, y: 1352, angle: 115 },
      { number: 7, x: 6407, y: -1089, angle: 16 },
      { number: 8, x: 6075, y: -1980, angle: -52 },
      { number: 9, x: 1237, y: -2693, angle: 190 },
      { number: 10, x: 2220, y: -3705, angle: 23 },
      { number: 11, x: 1582, y: -5496, angle: -74 },
      { number: 12, x: -820, y: -3789, angle: 67 },
      { number: 13, x: -2709, y: -4190, angle: -85 },
      { number: 14, x: -3986, y: -3138, angle: 149 },
      { number: 15, x: 4657, y: -781, angle: 53 },
    ],
  },
  // Madrid. 5 and 5A have their numbers side by side, as on F1's map.
  Madring: {
    rotation: 270,
    corners: [
      { number: 1, x: 1277, y: -2073, angle: 127 },
      { number: 2, x: 1018, y: -2570, angle: -41 },
      { number: 3, x: -111, y: -2625, angle: -114 },
      { number: 4, x: -3405, y: 3700, angle: 179 },
      { number: 5, x: -2941, y: 5465, angle: -35 },
      { number: 5, letter: "A", x: -3025, y: 5748, angle: 35 },
      { number: 6, x: -2969, y: 6082, angle: 173 },
      { number: 7, x: -3990, y: 8867, angle: 174 },
      { number: 8, x: -3659, y: 9246, angle: -30 },
      { number: 9, x: -3914, y: 10249, angle: -161 },
      { number: 10, x: -3851, y: 12034, angle: 147 },
      { number: 11, x: -3209, y: 12640, angle: 40 },
      { number: 12, x: -2021, y: 15298, angle: 64 },
      { number: 13, x: -3328, y: 10742, angle: 20 },
      { number: 14, x: -2039, y: 9453, angle: 23 },
      { number: 15, x: -1234, y: 7101, angle: -120 },
      { number: 16, x: 508, y: 6960, angle: -72 },
      { number: 17, x: 1063, y: 7163, angle: 78 },
      { number: 18, x: 2411, y: 5248, angle: -120 },
      { number: 19, x: 4235, y: 5046, angle: 56 },
      { number: 20, x: 5148, y: 1718, angle: -116 },
      { number: 20, letter: "A", x: 5571, y: 1872, angle: -70 },
      { number: 21, x: 6561, y: 1942, angle: 67 },
      { number: 22, x: 7071, y: -1028, angle: -45 },
    ],
  },
};

/**
 * Corner names, by circuit and corner ("5A" for a lettered one), for the layout with `corners` corners: a circuit
 * whose map has another count has been changed since, so its names are left off. Only names that sources (the
 * circuit's own site, formula1.com and others) tie to the turn; the name people use where it has an official one
 * too (Parabolica, not Curva Alboreto); none that change with each sponsorship deal (so nothing at Catalunya).
 */
const NAMES: Record<string, { corners: number; names: Record<string, string> }> = {
  Austin: { corners: 20, names: { 1: "Big Red", 3: "Esses", 4: "Esses", 5: "Esses", 11: "Bobby Pin", 20: "The Andretti" } },
  Baku: { corners: 20, names: { 8: "Castle", 9: "Castle" } },
  Hungaroring: {
    // MultiViewer's map numbers two kinks 1 and 12 too.
    corners: 16,
    names: {
      1: "Piquet",
      2: "Hamilton",
      3: "Spring",
      4: "Mansell",
      5: "Mogyoród",
      6: "Driving Center",
      7: "Driving Center",
      8: "Buda/Pest",
      9: "Buda/Pest",
      10: "Danube",
      11: "Alesi",
      12: "Schumacher",
      13: "Senna",
      14: "Szisz",
    },
  },
  Imola: {
    corners: 19,
    names: {
      2: "Tamburello",
      3: "Tamburello",
      4: "Tamburello",
      5: "Villeneuve",
      6: "Villeneuve",
      7: "Tosa",
      9: "Piratella",
      11: "Acque Minerali",
      12: "Acque Minerali",
      14: "Variante Alta",
      15: "Variante Alta",
      17: "Rivazza",
      18: "Rivazza",
    },
  },
  Interlagos: {
    corners: 15,
    names: {
      1: "S do Senna",
      2: "S do Senna",
      3: "Curva do Sol",
      4: "Descida do Lago",
      5: "Descida do Lago",
      6: "Ferradura",
      7: "Ferradura",
      8: "Laranjinha",
      9: "Pinheirinho",
      10: "Bico de Pato",
      11: "Mergulho",
      12: "Junção",
      14: "Subida dos Boxes",
    },
  },
  "Kuala Lumpur": {
    corners: 15,
    names: { 4: "Langkawi", 5: "Genting", 6: "Genting", 7: "KLIA", 8: "KLIA", 9: "Berjaya Tioman", 14: "Sunway Lagoon" },
  },
  Madring: {
    corners: 24,
    names: {
      3: "Hortaleza",
      6: "Subida de las Cárcavas",
      7: "Subida de las Cárcavas",
      8: "El Búnker",
      10: "La Chicane",
      11: "La Chicane",
      12: "La Monumental",
      14: "Las Enlazadas",
      15: "Las Enlazadas",
      16: "Las Enlazadas",
      18: "Norte",
      22: "El Parque",
    },
  },
  Melbourne: { corners: 14, names: { 6: "In Her Corner" } },
  "Mexico City": {
    corners: 17,
    names: {
      1: "Moisés Solana",
      2: "Moisés Solana",
      3: "Moisés Solana",
      6: "Rebaque",
      7: "Esses",
      8: "Esses",
      9: "Esses",
      10: "Esses",
      11: "Esses",
      12: "Adrián Fernández",
      13: "Foro Sol",
      14: "Foro Sol",
      15: "Foro Sol",
      17: "Peraltada",
    },
  },
  "Monte Carlo": {
    corners: 19,
    names: {
      1: "Sainte Dévote",
      2: "Beau Rivage",
      3: "Massenet",
      4: "Casino",
      5: "Mirabeau Haute",
      6: "Fairmont Hairpin",
      7: "Mirabeau Bas",
      8: "Portier",
      9: "Tunnel",
      10: "Nouvelle Chicane",
      11: "Nouvelle Chicane",
      12: "Tabac",
      13: "Swimming Pool",
      14: "Swimming Pool",
      15: "Swimming Pool",
      16: "Swimming Pool",
      18: "Rascasse",
      19: "Antony Noghès",
    },
  },
  Montreal: { corners: 14, names: { 1: "Senna S", 2: "Senna S", 10: "L'Épingle", 14: "Wall of Champions" } },
  Monza: {
    corners: 11,
    names: {
      1: "Rettifilo",
      2: "Rettifilo",
      3: "Curva Grande",
      4: "Roggia",
      5: "Roggia",
      6: "Lesmo 1",
      7: "Lesmo 2",
      8: "Ascari",
      9: "Ascari",
      10: "Ascari",
      11: "Parabolica",
    },
  },
  Sakhir: { corners: 15, names: { 1: "Michael Schumacher" } },
  Silverstone: {
    corners: 18,
    names: {
      1: "Abbey",
      2: "Farm",
      3: "Village",
      4: "The Loop",
      5: "Aintree",
      6: "Brooklands",
      7: "Luffield",
      8: "Woodcote",
      9: "Copse",
      10: "Maggotts",
      11: "Maggotts",
      12: "Becketts",
      13: "Becketts",
      14: "Chapel",
      15: "Stowe",
      16: "Vale",
      17: "Club",
      18: "Club",
    },
  },
  Singapore: { corners: 19, names: { 1: "Sheares", 7: "Memorial" } },
  "Spa-Francorchamps": {
    corners: 19,
    names: {
      1: "La Source",
      2: "Eau Rouge",
      3: "Raidillon",
      4: "Raidillon",
      5: "Les Combes",
      6: "Les Combes",
      7: "Malmedy",
      8: "Bruxelles",
      9: "Jacky Ickx",
      10: "Pouhon",
      11: "Pouhon",
      12: "Fagnes",
      13: "Fagnes",
      14: "Campus",
      15: "Paul Frère",
      16: "Blanchimont",
      17: "Blanchimont",
      18: "Bus Stop",
      19: "Bus Stop",
    },
  },
  Spielberg: { corners: 10, names: { 1: "Niki Lauda", 7: "Graz", 9: "Jochen Rindt" } },
  Suzuka: {
    corners: 18,
    names: {
      1: "First Curve",
      3: "S Curves",
      4: "S Curves",
      5: "S Curves",
      6: "Reverse Bank",
      7: "Dunlop",
      8: "Degner 1",
      9: "Degner 2",
      11: "Hairpin",
      12: "200R",
      13: "Spoon",
      14: "Spoon",
      15: "130R",
      16: "Casio Triangle",
      17: "Casio Triangle",
      18: "Final Corner",
    },
  },
  Zandvoort: {
    corners: 14,
    names: {
      1: "Tarzan",
      2: "Gerlach",
      3: "Hugenholtz",
      4: "Hunserug",
      5: "Slotemaker",
      6: "Scheivlak",
      7: "Scheivlak",
      8: "Masters",
      11: "Hans Ernst",
      12: "Hans Ernst",
      14: "Arie Luyendyk",
    },
  },
};

/** A corner as circuit maps label it: its number, and letter if it has one ("5A"). */
export const cornerLabel = (c: Pick<Corner, "number" | "letter">): string => `${c.number}${c.letter ?? ""}`;

const filled = new WeakMap<TrackGeometry, TrackGeometry>();

/**
 * The track with the corners the circuit API had for it, else ours (with our rotation), and the corners' names.
 * The same object for the same track, and for a track it returned, so a view keyed on the track doesn't redraw.
 */
export function withCircuit(track: TrackGeometry, circuit: string): TrackGeometry {
  const done = filled.get(track);
  if (done) return done;
  const ours = track.corners.length ? null : CIRCUITS[circuit];
  const corners = ours?.corners ?? track.corners;
  const named = NAMES[circuit]?.corners === corners.length ? NAMES[circuit].names : null;
  const out: TrackGeometry =
    !ours && !named
      ? track
      : {
          ...track,
          rotation: ours?.rotation ?? track.rotation,
          corners: named ? corners.map((c) => (named[cornerLabel(c)] ? { ...c, name: named[cornerLabel(c)] } : c)) : corners,
        };
  filled.set(track, out);
  filled.set(out, out);
  return out;
}
