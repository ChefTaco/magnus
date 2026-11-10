CREATE TABLE "EmbermendOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "integrationId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "state" TEXT NOT NULL,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "EmbermendOperation_commandId_key" ON "EmbermendOperation"("commandId");
CREATE UNIQUE INDEX "EmbermendOperation_integrationId_operationId_key" ON "EmbermendOperation"("integrationId", "operationId");
