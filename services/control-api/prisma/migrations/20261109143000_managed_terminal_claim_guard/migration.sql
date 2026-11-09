ALTER TABLE "resource_participant_work" ADD CONSTRAINT "managed_terminal_claim_complete"
CHECK ("managedTerminalClaimedAt" IS NULL OR
  (participant = 'dashboard' AND kind = 'terminal-http' AND "startedAt" IS NOT NULL AND state IN ('running','unknown','released')));

CREATE FUNCTION magnus_guard_managed_terminal_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."managedTerminalClaimedAt" IS NOT NULL AND NEW."managedTerminalClaimedAt" IS DISTINCT FROM OLD."managedTerminalClaimedAt" THEN
    RAISE EXCEPTION 'a consumed managed terminal claim is immutable';
  END IF;
  IF OLD."managedTerminalClaimedAt" IS NULL AND NEW."managedTerminalClaimedAt" IS NOT NULL AND OLD.state <> 'running' THEN
    RAISE EXCEPTION 'only running participant work can consume a terminal claim';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER managed_terminal_claim_immutable BEFORE UPDATE ON "resource_participant_work"
FOR EACH ROW EXECUTE FUNCTION magnus_guard_managed_terminal_claim();
