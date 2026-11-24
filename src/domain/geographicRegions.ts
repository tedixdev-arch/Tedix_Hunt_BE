/**
 * Location data standard shared by Creator, Organizer and Admin geography.
 *
 * Every place a Hunt can use is a Locality inside Country -> Region -> City:
 * - Country: the stored ISO 3166-1 alpha-2 reference (`countries`).
 * - Region: the GeoNames first-level administrative division (admin1). Its label comes only from the
 *   official admin1 dictionary; a missing label falls back to the code, never to a guessed name.
 *   Cities whose source admin1 is blank or "00", and manual Localities without a region, are grouped
 *   under the explicit `unspecified` region so every country uses the same three-level shape.
 * - City: a GeoNames populated place, usable once an Admin registers it as a Locality, or a manual
 *   Locality created by an approved proposal (for places missing from the GeoNames list).
 */
export const UNSPECIFIED_REGION = 'unspecified';
export const UNSPECIFIED_REGION_LABEL = 'Other (region not specified)';

// Name of the admin1 level shown to users. Only levels that GeoNames admin1 reliably represents are
// listed; every other country uses the neutral "Region".
const regionLabels: Record<string, string> = {
  RO: 'County', HU: 'County', MD: 'District', XK: 'District',
  US: 'State', AU: 'State', BR: 'State', DE: 'State', AT: 'State', IN: 'State', MX: 'State',
  CA: 'Province', NL: 'Province', CH: 'Canton', PL: 'Voivodeship',
  FR: 'Region', IT: 'Region', ES: 'Autonomous community',
};
export const regionLabel = (countryCode: string) => regionLabels[countryCode] ?? 'Region';

/** A stored, selectable admin1 code: never blank or the GeoNames "00" placeholder. */
export const isAdmin1Code = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(value) && value !== '00' && value !== UNSPECIFIED_REGION;

/** Missing official labels stay visibly code-based so Admin can see incomplete metadata. */
export const regionDisplayName = (admin1Code: string, label: string | null | undefined) =>
  admin1Code === UNSPECIFIED_REGION ? UNSPECIFIED_REGION_LABEL : label?.trim() || `Region ${admin1Code}`;

/** Duplicate identity used by registration and proposals: normalized, punctuation and spaces removed. */
export const placeIdentity = (normalizedName: string) => normalizedName.replace(/[^\p{L}\p{N}]/gu, '');
