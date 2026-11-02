-- pgAdmin Query Tool: execute the WHOLE statement on the independently verified dev connection.
-- Fill the two endpoint constants from that connection's reviewed server identity first.
-- These are safety checks, not credentials. Never use this file against production.
DO $cluj_seed$
DECLARE
  expected_server_address text := 'REPLACE_WITH_REVIEWED_DEV_SERVER_ADDRESS';
  expected_server_port integer := 0; -- replace with the reviewed development PostgreSQL port
  action text := 'apply'; -- 'remove' only deactivates this seed's own record
  selected_id uuid;
  active_matches integer;
  total_matches integer;
BEGIN
  IF current_database() <> 'tedix_hunt' OR current_user <> 'tedix_app' OR session_user <> 'tedix_app' THEN
    RAISE EXCEPTION 'Refused: requires database tedix_hunt and login/current role tedix_app';
  END IF;
  IF expected_server_address = 'REPLACE_WITH_REVIEWED_DEV_SERVER_ADDRESS'
     OR expected_server_port NOT BETWEEN 1 AND 65535
  THEN
    RAISE EXCEPTION 'Refused: independently reviewed development server address/port required';
  END IF;
  IF inet_server_addr() IS NULL
     OR inet_server_addr() IS DISTINCT FROM expected_server_address::inet
     OR inet_server_port() IS DISTINCT FROM expected_server_port THEN
    RAISE EXCEPTION 'Refused: independently reviewed development server address/port required';
  END IF;
  IF action NOT IN ('apply', 'remove') THEN RAISE EXCEPTION 'Invalid seed action'; END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  -- Serializes with normal registry writers, including concurrent seed execution.
  LOCK TABLE public.localities IN SHARE ROW EXCLUSIVE MODE;
  IF action = 'remove' THEN
    UPDATE public.localities SET active = false, updated_at = now()
      WHERE provider = 'development-setup' AND provider_id = 'cluj-napoca' AND active;
    RAISE NOTICE 'Seed-owned reference deactivated; all saved UUIDs and snapshots retained';
    RETURN;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE active) INTO total_matches, active_matches
    FROM public.localities
    WHERE country_code = 'RO' AND lower(regexp_replace(name, '[[:space:]-]', '', 'g')) = 'clujnapoca';
  IF active_matches = 1 THEN
    SELECT id INTO selected_id FROM public.localities
      WHERE country_code = 'RO' AND active
      AND lower(regexp_replace(name, '[[:space:]-]', '', 'g')) = 'clujnapoca';
    RAISE NOTICE 'Reusing existing registered locality %; no record changed', selected_id;
    RETURN;
  END IF;
  IF total_matches > 0 OR EXISTS (SELECT 1 FROM public.localities
      WHERE provider = 'development-setup' AND provider_id = 'cluj-napoca') THEN
    RAISE EXCEPTION 'Inactive, ambiguous or changed Cluj registry reference: explicit Admin reconciliation required';
  END IF;
  -- RO must exist from normal migrations; no country/catalog/import/approval rows are created.
  INSERT INTO public.localities
    (country_code, name, administrative_context, latitude, longitude, provider, provider_id, provenance)
    VALUES ('RO', 'Cluj-Napoca', 'Cluj', 46.7712, 23.6236, 'development-setup', 'cluj-napoca',
      'Temporary manually configured development city reference. Approximate city-centre coordinates; no GeoNames source, locality approval, route certification or Template approval.')
    RETURNING id INTO selected_id;
  RAISE NOTICE 'Created manual development locality %; no approval or Template created', selected_id;
END
$cluj_seed$;
