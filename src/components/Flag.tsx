// A country's flag, as data beside a circuit's or a driver's name: like team colours, flags appear only where they say
// whose (DESIGN.md), never as chrome. SVGs from country-flag-icons (MIT), 3:2, as data URLs, so they draw the same on
// every OS (Windows shows emoji flags as letters). Only the countries the calendar has raced in since 2023 or is going
// to, by the country name it gives (scripts/lib/season.ts's venueCountry), and the nationalities of the drivers since,
// by ISO code; any other country gets none.

import AE from "country-flag-icons/string/3x2/AE";
import AT from "country-flag-icons/string/3x2/AT";
import AU from "country-flag-icons/string/3x2/AU";
import AZ from "country-flag-icons/string/3x2/AZ";
import BE from "country-flag-icons/string/3x2/BE";
import BH from "country-flag-icons/string/3x2/BH";
import BR from "country-flag-icons/string/3x2/BR";
import CA from "country-flag-icons/string/3x2/CA";
import CN from "country-flag-icons/string/3x2/CN";
import ES from "country-flag-icons/string/3x2/ES";
import GB from "country-flag-icons/string/3x2/GB";
import HU from "country-flag-icons/string/3x2/HU";
import IT from "country-flag-icons/string/3x2/IT";
import JP from "country-flag-icons/string/3x2/JP";
import MC from "country-flag-icons/string/3x2/MC";
import MX from "country-flag-icons/string/3x2/MX";
import MY from "country-flag-icons/string/3x2/MY";
import NL from "country-flag-icons/string/3x2/NL";
import PT from "country-flag-icons/string/3x2/PT";
import QA from "country-flag-icons/string/3x2/QA";
import SA from "country-flag-icons/string/3x2/SA";
import SG from "country-flag-icons/string/3x2/SG";
import TR from "country-flag-icons/string/3x2/TR";
import US from "country-flag-icons/string/3x2/US";
import AR from "country-flag-icons/string/3x2/AR";
import DE from "country-flag-icons/string/3x2/DE";
import DK from "country-flag-icons/string/3x2/DK";
import EE from "country-flag-icons/string/3x2/EE";
import FI from "country-flag-icons/string/3x2/FI";
import FR from "country-flag-icons/string/3x2/FR";
import NZ from "country-flag-icons/string/3x2/NZ";
import SE from "country-flag-icons/string/3x2/SE";
import TH from "country-flag-icons/string/3x2/TH";

/** SVG markup by country name. */
const FLAGS: Readonly<Record<string, string>> = {
  Australia: AU,
  Austria: AT,
  Azerbaijan: AZ,
  Bahrain: BH,
  Belgium: BE,
  Brazil: BR,
  Canada: CA,
  China: CN,
  Hungary: HU,
  Italy: IT,
  Japan: JP,
  Malaysia: MY,
  Mexico: MX,
  Monaco: MC,
  Netherlands: NL,
  Portugal: PT,
  Qatar: QA,
  "Saudi Arabia": SA,
  Singapore: SG,
  Spain: ES,
  Turkey: TR,
  Türkiye: TR,
  "United Arab Emirates": AE,
  "United Kingdom": GB,
  "United States": US,
};

/** SVG markup by ISO 3166 alpha-2 code (F1DB's for a driver's nationality). */
const CODES: Readonly<Record<string, string>> = { AE, AR, AT, AU, AZ, BE, BH, BR, CA, CN, DE, DK, EE, ES, FI, FR, GB, HU, IT, JP, MC, MX, MY, NL, NZ, PT, QA, SA, SE, SG, TH, TR, US };

/** `country`'s flag (a name, or `code` an ISO code) as an image URL (3:2), or null for a country it doesn't have. */
export function flagSrc(country: string, code = false): string | null {
  const svg = code ? CODES[country.toUpperCase()] : FLAGS[country];
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}

/**
 * `country`'s flag (by name, or by ISO code with `code`), 3:2 at the height `className` gives it (h-3 by default);
 * nothing for a country it doesn't have.
 */
export function Flag({ country, code = false, className = "h-3" }: { country: string; code?: boolean; className?: string }) {
  const src = flagSrc(country, code);
  if (!src) return null;
  // Decorative next to the country's name, which is always said in words too.
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      className={`inline-block aspect-[3/2] shrink-0 rounded-[2px] object-cover ring-1 ring-zinc-50/15 ${className}`}
    />
  );
}
