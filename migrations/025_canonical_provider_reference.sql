-- One bank movement, one spelling.
--
-- `payments_provider_reference_idx` (migration 007) is UNIQUE on
-- (provider, provider_payment_id), and migration 019 leans on it for the
-- guarantee that one bank movement settles exactly one payment. The resolver
-- leans on the same column a second way: before matching, it asks which of the
-- bank's movements have already been spent.
--
-- Both are string comparisons. A movement written as `9000 0000 0999` by the
-- charge path and `900000000999` by the resolution path is two different
-- strings, so the index does not collide and the probe does not match -- and
-- one debit can settle two bills. The charge path stored whatever Mercantil
-- sent; the resolution path stripped it to digits. This backfills the rows
-- written under the old, inconsistent rule.
--
-- The rule matches `canonicalReference` in src/services/c2pMatcher.js, which is
-- now applied at every write:
--
--   * a value that is only digits and the separators a bank might print
--     between them collapses to its digits
--   * anything carrying a letter is an identifier, not a number, and is left
--     exactly as it is -- `TX-4F2A-9` must not become `429`
--   * leading zeros are kept, so `0900...` and `900...` stay distinct
--
-- IF THIS MIGRATION FAILS, IT WILL KEEP FAILING, AND THAT IS THE POINT.
--
-- A collision here means two payments are already holding two spellings of one
-- bank movement -- the double settlement all of the above exists to prevent.
-- `scripts/migrate.js` writes the ledger row inside the same transaction as the
-- migration, so a failure records nothing and the next deploy tries again and
-- stops at the same place. There is no skip, and none should be added: a person
-- has to look at the rows and refund one of them, and until they do, every
-- later migration is correctly held back.
--
-- The check below runs first so the failure names the payments instead of
-- surfacing as a bare 23505 from the UPDATE.

DO $$
DECLARE
  collisions TEXT;
BEGIN
  SELECT string_agg(ids, '; ')
    INTO collisions
    FROM (
      SELECT string_agg(id::text, ', ') AS ids
        FROM payments
       WHERE provider = 'MERCANTIL'
         AND provider_payment_id IS NOT NULL
         AND provider_payment_id ~ '^[0-9\s.\-/]+$'
         AND regexp_replace(provider_payment_id, '[^0-9]', '', 'g') <> ''
       GROUP BY regexp_replace(provider_payment_id, '[^0-9]', '', 'g')
      HAVING count(*) > 1
    ) AS duplicated;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'Two payments already hold one bank movement under different spellings: %. '
      'Refund one of them before deploying; this migration cannot decide which.',
      collisions
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

UPDATE payments
   SET provider_payment_id = regexp_replace(provider_payment_id, '[^0-9]', '', 'g')
 WHERE provider = 'MERCANTIL'
   AND provider_payment_id IS NOT NULL
   -- Only a number in some spelling, and only where the spelling differs.
   AND provider_payment_id ~ '^[0-9\s.\-/]+$'
   AND provider_payment_id <> regexp_replace(provider_payment_id, '[^0-9]', '', 'g')
   -- Never write an empty string where a reference used to be: a row of pure
   -- separators is unreadable, and blanking it would silently drop the only
   -- link between a debit and its bill.
   AND regexp_replace(provider_payment_id, '[^0-9]', '', 'g') <> '';
