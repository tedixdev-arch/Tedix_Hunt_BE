/**
 * Location data standard shared by Creator, Organizer and Admin geography.
 *
 * Every place a Hunt can use is a Locality inside Country -> Region -> (optional Subregion) -> City:
 * - Country: the stored ISO 3166-1 alpha-2 reference (`countries`).
 * - Region: the GeoNames first-level administrative division (admin1). Its label comes only from the
 *   official admin1 dictionary; a missing label falls back to the code, never to a guessed name.
 *   Cities whose source admin1 is blank or "00", and manual Localities without a region, are grouped
 *   under the explicit `unspecified` region so every country uses the same three-level shape.
 * - Subregion: the GeoNames second-level division (admin2: county, district, commune, department...), only
 *   when its code is valid and officially named. It is optional: a whole region can always be browsed, and
 *   cities without a named subdivision (and manual Localities) form the explicit `unspecified` group.
 * - City: a GeoNames populated place (its Locality is linked or created automatically when first selected),
 *   or a manual Locality created by an approved proposal (for places missing from the GeoNames list).
 */
export const UNSPECIFIED_REGION = 'unspecified';
export const UNSPECIFIED_REGION_LABEL = 'Other (region not specified)';

// Name of the admin1 level shown to users. Only levels that GeoNames admin1 reliably represents are
// listed; every other country uses the neutral "Region".
const regionLabels: Record<string, string> = {
  RO: 'County', HU: 'County', MD: 'District', XK: 'District',
  US: 'State', AU: 'State', BR: 'State', DE: 'State', AT: 'State', IN: 'State', MX: 'State', GB: 'Country',
  CA: 'Province', NL: 'Province', CH: 'Canton', PL: 'Voivodeship',
  FR: 'Region', IT: 'Region', ES: 'Autonomous community',
};
export const regionLabel = (countryCode: string) => regionLabels[countryCode] ?? 'Region';

export const UNSPECIFIED_SUBREGION = 'unspecified';
export const UNSPECIFIED_SUBREGION_LABEL = 'Other (not specified)';
// Name of the admin2 level shown to users, where GeoNames admin2 is that local unit; otherwise generic.
const subregionLabels: Record<string, string> = {
  IN: 'District', US: 'County', RO: 'Commune', FR: 'Department',
  GB: 'County', IE: 'County', DE: 'District', AT: 'District', HU: 'District', CH: 'District',
  PL: 'County', IT: 'Province', ES: 'Province', BR: 'Municipality', MX: 'Municipality', NL: 'Municipality',
};
export const subregionLabel = (countryCode: string) => subregionLabels[countryCode] ?? 'District/County';

/** A stored, selectable admin1 or admin2 code: never blank or the GeoNames "00" placeholder. */
export const isAdmin1Code = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(value) && value !== '00' && value !== UNSPECIFIED_REGION;

export const isAdmin2Code = isAdmin1Code;

/** Missing official labels stay visibly code-based so Admin can see incomplete metadata. */
export const regionDisplayName = (admin1Code: string, label: string | null | undefined) =>
  admin1Code === UNSPECIFIED_REGION ? UNSPECIFIED_REGION_LABEL : label?.trim() || `Region ${admin1Code}`;

/** Duplicate identity used by registration and proposals: normalized, punctuation and spaces removed. */
export const placeIdentity = (normalizedName: string) => normalizedName.replace(/[^\p{L}\p{N}]/gu, '');
