-- Nyaitter address v2
-- Canonical local identity:    #1234@example.com
-- Canonical external identity: #1234@remote.example.com
--
-- Local addresses are derived from the incoming public URL at response time and
-- therefore do not need to be persisted. External addresses remain persisted to
-- identify a remote account independent of this server's current public URL.

UPDATE users
SET
  handle = '#' || LPAD(id::text, 4, '0'),
  nyaitter_address = NULL
WHERE COALESCE(auth_provider, 'local') <> 'nyaitter';

UPDATE users
SET
  handle = '#' || LPAD(external_id::text, 4, '0'),
  nyaitter_address = '#' || LPAD(external_id::text, 4, '0') || '@' || LOWER(provider_domain)
WHERE auth_provider = 'nyaitter'
  AND external_id IS NOT NULL
  AND external_id::text ~ '^\d+$'
  AND provider_domain IS NOT NULL
  AND provider_domain <> '';

-- Legacy external identities whose external_id is not numeric cannot be
-- losslessly represented as #ID@domain. Review and migrate those rows manually
-- before enabling their external login flow.

