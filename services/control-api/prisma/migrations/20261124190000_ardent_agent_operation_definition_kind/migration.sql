-- Portable agent-definition installs record their receipts as kind 'definition' (added in 3.3.0);
-- the original constraint allowed only 'deploy' and 'hivemem', so every definition install failed.
ALTER TABLE "ardent_agent_operations" DROP CONSTRAINT ardent_agent_operations_kind_check;
ALTER TABLE "ardent_agent_operations" ADD CONSTRAINT ardent_agent_operations_kind_check CHECK ("kind" IN ('deploy', 'hivemem', 'definition'));
