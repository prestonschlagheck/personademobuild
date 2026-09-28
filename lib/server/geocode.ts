import "server-only";

// The town a shared location is in, from OpenStreetMap's reverse geocoder (Nominatim). It gets only the point already
// rounded to about 1 km, once per share, from the server. Its usage policy asks for an identifying User-Agent and at most
// one request a second, which one share at a time stays well under.

const REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "persona-demo/1.0 (+https://persona-demo.personademobuild.workers.dev)";
// A share waits on this, so a slow answer is given up on and the point is kept without a name.
const TIMEOUT_MS = 2_500;

type Address = Partial<Record<"city" | "town" | "village" | "hamlet" | "municipality" | "suburb" | "county" | "state" | "country", string>> & {
  "ISO3166-2-lvl4"?: string;
};

/** "Columbia, SC" in the US (the state's code), "Toronto, Ontario" elsewhere, or null when the answer names no town. */
export function placeFrom(address: Address | undefined): string | null {
  if (!address) return null;
  const town = address.city ?? address.town ?? address.village ?? address.hamlet ?? address.municipality ?? address.suburb ?? address.county;
  if (!town) return null;
  const code = address["ISO3166-2-lvl4"];
  const region = code?.startsWith("US-") ? code.slice(3) : (address.state ?? address.country);
  return region ? `${town}, ${region}` : town;
}

export async function placeName(lat: number, lng: number, fetcher: typeof fetch = fetch): Promise<string | null> {
  // Tests never reach the network.
  if (process.env.NODE_ENV === "test" && fetcher === fetch) return null;
  const url = `${REVERSE_URL}?format=jsonv2&zoom=10&addressdetails=1&lat=${lat}&lon=${lng}`;
  try {
    const res = await fetcher(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { address?: Address };
    return placeFrom(body.address);
  } catch {
    return null;
  }
}
