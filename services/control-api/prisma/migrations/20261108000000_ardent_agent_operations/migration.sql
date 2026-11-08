CREATE TABLE "ardent_agent_operations" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "requestJson" TEXT NOT NULL,
  "stepsJson" TEXT NOT NULL DEFAULT '[]',
  "error" TEXT,
  "createdBy" TEXT NOT NULL,
  "actingJson" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ardent_agent_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT ardent_agent_operations_kind_check CHECK ("kind" IN ('deploy', 'hivemem')),
  CONSTRAINT ardent_agent_operations_status_check CHECK ("status" IN ('running', 'succeeded', 'failed'))
);

CREATE INDEX "ardent_agent_operations_nodeId_profile_idx" ON "ardent_agent_operations"("nodeId", "profile");
CREATE INDEX "ardent_agent_operations_status_idx" ON "ardent_agent_operations"("status");
-- One running operation per profile: a second deploy or backfill waits for the first to settle.
CREATE UNIQUE INDEX ardent_agent_operations_one_running ON "ardent_agent_operations"("nodeId", "profile") WHERE "status" = 'running';
