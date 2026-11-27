-- Setting the Emberpath client key of an existing Ardent agent records its receipt as kind
-- 'model-credential' (added in 3.5.0); the constraint allowed only 'deploy', 'hivemem' and 'definition',
-- so every such operation failed when it was created.
ALTER TABLE "ardent_agent_operations" DROP CONSTRAINT ardent_agent_operations_kind_check;
ALTER TABLE "ardent_agent_operations" ADD CONSTRAINT ardent_agent_operations_kind_check CHECK ("kind" IN ('deploy', 'hivemem', 'definition', 'model-credential'));
