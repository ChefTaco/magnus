-- Deleting a remediation rule no longer erases its executions (approval plans, results and
-- in-flight runs): the server refuses to delete a rule that has any, and the database agrees.
ALTER TABLE "remediation_executions" DROP CONSTRAINT "remediation_executions_ruleId_fkey";
ALTER TABLE "remediation_executions" ADD CONSTRAINT "remediation_executions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "remediation_rules"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
