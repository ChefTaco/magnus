-- Per-node Ed25519 credentials (additive). Nodes keep working on the shared node secret until
-- their agent binds a key; nothing here changes existing rows.
CREATE TABLE "node_credentials" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "nodeId" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "origin" TEXT NOT NULL,
  "boundFqdn" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "retireAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  CONSTRAINT "node_credentials_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT node_credentials_status_check CHECK ("status" IN ('ACTIVE', 'RETIRING', 'REVOKED')),
  CONSTRAINT node_credentials_origin_check CHECK ("origin" IN ('ENROLLMENT_TOKEN', 'LEGACY_UPGRADE', 'ROTATION')),
  CONSTRAINT node_credentials_key_id_check CHECK ("keyId" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "node_credentials_keyId_key" ON "node_credentials"("keyId");
CREATE INDEX "node_credentials_nodeId_status_idx" ON "node_credentials"("nodeId", "status");
-- First writer wins: a node has at most one ACTIVE key, whatever the application does.
CREATE UNIQUE INDEX node_credentials_one_active_per_node ON "node_credentials"("nodeId") WHERE "status" = 'ACTIVE';

CREATE TABLE "node_enrollment_tokens" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenSha256" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "usedKeyId" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "node_enrollment_tokens_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "node_enrollment_tokens_tokenSha256_key" ON "node_enrollment_tokens"("tokenSha256");
CREATE INDEX "node_enrollment_tokens_nodeId_idx" ON "node_enrollment_tokens"("nodeId");

CREATE TABLE "node_auth_state" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "legacyUpgradeStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
