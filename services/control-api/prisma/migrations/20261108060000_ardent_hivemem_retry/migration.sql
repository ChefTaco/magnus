-- Persist the complete non-secret request before contacting HiveMem. Lease tokens fence stale workers.
ALTER TABLE "ardent_hivemem_credentials"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "pendingJson" TEXT,
  ADD COLUMN "recoveryRequired" BOOLEAN NOT NULL DEFAULT false;

-- Old failed/in-flight attempts did not retain their exact request. Their outcome cannot be
-- inferred from the renewal counter, which advanced before delivery. Never invent a replacement.
UPDATE "ardent_hivemem_credentials"
SET "recoveryRequired" = true,
    "lastError" = 'A legacy renewal has an unresolved outcome. An ADMIN must inspect the profile and explicitly run Enable HiveMem to recover.',
    "failures" = GREATEST("failures", 1), "leaseUntil" = NULL
WHERE "lastAttemptAt" IS NOT NULL AND ("failures" > 0 OR "leaseUntil" IS NOT NULL);
