-- Per-node credentials, phase 2 (additive). No existing row changes meaning.

-- Whether the agent holding this key signs its evidence with it (it says so in a signed heartbeat).
-- While true, evidence for the node signed only with the shared result key is refused.
ALTER TABLE "node_credentials" ADD COLUMN "evidenceSigning" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "node_credentials" ADD COLUMN "evidenceSigningAt" TIMESTAMP(3);

-- Automatic key bindings refused because the caller's address is not the node's recorded address,
-- kept for an administrator to approve or reject.
CREATE TABLE "node_pending_bindings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "nodeId" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "fqdn" TEXT NOT NULL,
  "peerAddress" TEXT NOT NULL,
  "recordedAddress" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "decidedBy" TEXT,
  "decisionReason" TEXT,
  CONSTRAINT "node_pending_bindings_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT node_pending_bindings_status_check CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT node_pending_bindings_key_id_check CHECK ("keyId" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "node_pending_bindings_nodeId_keyId_key" ON "node_pending_bindings"("nodeId", "keyId");
CREATE INDEX "node_pending_bindings_status_idx" ON "node_pending_bindings"("status");

-- Per node and channel: how often, and when last, the shared node secret or the shared result key
-- was still accepted for (or sent to) the node.
CREATE TABLE "node_legacy_credential_use" (
  "nodeId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "firstUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDetail" TEXT,
  CONSTRAINT "node_legacy_credential_use_pkey" PRIMARY KEY ("nodeId", "channel"),
  CONSTRAINT "node_legacy_credential_use_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT node_legacy_credential_use_channel_check CHECK ("channel" IN ('request', 'evidence', 'outbound'))
);
CREATE INDEX "node_legacy_credential_use_lastUsedAt_idx" ON "node_legacy_credential_use"("lastUsedAt");
