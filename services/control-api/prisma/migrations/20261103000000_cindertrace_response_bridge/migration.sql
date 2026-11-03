CREATE TABLE "cindertrace_responses" (
 "id" TEXT NOT NULL PRIMARY KEY, "actionOperation" TEXT NOT NULL, "nodeId" TEXT NOT NULL,
 "requestSha256" TEXT NOT NULL, "requestJson" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'claimed',
 "responseJson" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "cindertrace_responses_actionOperation_key" ON "cindertrace_responses"("actionOperation");
