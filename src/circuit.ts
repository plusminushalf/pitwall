// Circuits, as the circuit pages (/circuit/<slug>, ../url.ts) name them: OpenF1's circuit_short_name ("Singapore",
// "Kuala Lumpur") as a slug. That name is the same for a circuit_key in every season (checked 2023–2027), so a
// calendar row and a downloaded session's meta, which only has the name, both give the same circuit. Keyed by the
// circuit, not the Grand Prix: the 2026 Bahrain Grand Prix, held at Sepang, is at "kuala-lumpur".

import type { CatalogRow } from "./ingest/catalog";

export const CIRCUIT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** "Spa-Francorchamps" → "spa-francorchamps", "Yas Marina Circuit" → "yas-marina-circuit". */
export const circuitSlug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The sessions at a circuit in the seasons given, oldest first. */
export function rowsAt(slug: string, catalogs: Iterable<{ rows: readonly CatalogRow[] } | null | undefined>): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const c of catalogs) for (const r of c?.rows ?? []) if (r.circuit && circuitSlug(r.circuit) === slug) rows.push(r);
  return rows.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
}
