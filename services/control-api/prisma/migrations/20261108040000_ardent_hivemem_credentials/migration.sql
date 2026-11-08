-- The HiveMem credential Magnus issued each Ardent profile, so a job can renew it before its deadline.
CREATE TABLE "ardent_hivemem_credentials" (
  "id" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastRenewedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "renewals" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ardent_hivemem_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT ardent_hivemem_credentials_counts_check CHECK ("failures" >= 0 AND "renewals" >= 0)
);

CREATE UNIQUE INDEX "ardent_hivemem_credentials_nodeId_profile_key" ON "ardent_hivemem_credentials"("nodeId", "profile");
CREATE INDEX "ardent_hivemem_credentials_nextAttemptAt_idx" ON "ardent_hivemem_credentials"("nextAttemptAt");
