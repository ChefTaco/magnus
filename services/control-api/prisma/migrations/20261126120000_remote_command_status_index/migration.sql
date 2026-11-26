-- The command reconciler runs every 5 s with `status IN ('QUEUED','RUNNING') ORDER BY "createdAt"`,
-- and history retention deletes by status and age; both used to scan and sort the whole table.
CREATE INDEX "remote_commands_status_createdAt_idx" ON "remote_commands"("status", "createdAt");
