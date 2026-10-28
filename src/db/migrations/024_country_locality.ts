import type { Migration } from './types.js';

const migration: Migration = {
  id: '024_country_locality',
  async up(client) {
    await client.query(`
-- Initial reviewed reference: ISO 3166-1 alpha-2 RO / Romania. No locality import.
CREATE TABLE countries (
  code TEXT PRIMARY KEY CHECK (code IN (
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX',
    'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ',
    'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK',
    'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM',
    'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
    'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS',
    'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN',
    'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
    'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV',
    'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ',
    'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI',
    'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
    'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC',
    'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV',
    'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR',
    'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
    'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
  )),
  display_name TEXT NOT NULL CHECK ((length(display_name) BETWEEN 1 AND 100 AND btrim(display_name) <> ''))
);
INSERT INTO countries (code, display_name) VALUES ('RO', 'Romania');

CREATE TABLE localities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code TEXT NOT NULL REFERENCES countries(code) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK ((length(name) BETWEEN 1 AND 200 AND btrim(name) <> '')),
  administrative_context TEXT NOT NULL CHECK ((length(administrative_context) BETWEEN 1 AND 200 AND btrim(administrative_context) <> '')),
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  provider TEXT CHECK ((length(provider) BETWEEN 1 AND 100 AND btrim(provider) <> '')),
  provider_id TEXT CHECK ((length(provider_id) BETWEEN 1 AND 500 AND btrim(provider_id) <> '')),
  provenance TEXT NOT NULL CHECK ((length(provenance) BETWEEN 1 AND 2000 AND btrim(provenance) <> '')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT localities_provider_pair_check CHECK ((provider IS NULL) = (provider_id IS NULL)),
  CONSTRAINT localities_provider_identity_key UNIQUE (provider, provider_id)
);
CREATE INDEX localities_country_name_idx ON localities (country_code, lower(name), id) WHERE active;
-- Supports country FK checks even when all of its localities are inactive.
CREATE INDEX localities_country_idx ON localities (country_code);
    `);
  },
};

export default migration;
