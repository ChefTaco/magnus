-- Magnus server 1.0.0 baseline schema (PostgreSQL).
--
-- Beyond what Prisma models, this migration carries database-enforced
-- invariants: trigger functions and triggers guarding resource leases, fences
-- and append-only tables, CHECK constraints, partial unique indexes, and a few
-- seeded base rows.

CREATE TYPE public."AgentStatus" AS ENUM (
    'RUNNING',
    'STOPPED',
    'UPDATING',
    'ERROR'
);

CREATE TYPE public."CommandStatus" AS ENUM (
    'PENDING',
    'QUEUED',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'TIMEOUT',
    'CANCELLED'
);

CREATE TYPE public."CronJobStatus" AS ENUM (
    'ACTIVE',
    'PAUSED',
    'ERROR'
);

CREATE TYPE public."NodeStatus" AS ENUM (
    'ONLINE',
    'OFFLINE',
    'DEGRADED',
    'PROVISIONING',
    'DECOMMISSIONED'
);

CREATE TYPE public."UserRole" AS ENUM (
    'ADMIN',
    'OPERATOR',
    'VIEWER'
);

CREATE FUNCTION public.magnus_assert_shared_resource_consistency(checked_lease_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "shared_resource_leases" lease
    WHERE lease."id" = checked_lease_id
      AND (NOT EXISTS (SELECT 1 FROM "shared_resource_lease_resources" claim WHERE claim."leaseId" = lease."id")
        OR EXISTS (SELECT 1 FROM "shared_resource_lease_resources" claim
          WHERE claim."leaseId" = lease."id" AND claim."state" <> lease."state")
        OR lease."resourceSetBinding" IS DISTINCT FROM (
          SELECT string_agg(claim."resourceKey" || '=' || claim."fenceGeneration"::TEXT, E'\n' ORDER BY claim."resourceKey")
          FROM "shared_resource_lease_resources" claim WHERE claim."leaseId" = lease."id"
        ))
  ) THEN
    RAISE EXCEPTION 'shared resource lease and claim states must remain complete and identical';
  END IF;
END;
$$;

CREATE FUNCTION public.magnus_check_shared_resource_claim_consistency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM "magnus_assert_shared_resource_consistency"(COALESCE(NEW."leaseId", OLD."leaseId"));
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.magnus_check_shared_resource_lease_consistency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM "magnus_assert_shared_resource_consistency"(COALESCE(NEW."id", OLD."id"));
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.magnus_enforce_shared_resource_claim_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  authoritative_generation BIGINT;
BEGIN
  IF NEW."state" <> 'reserved' THEN
    RAISE EXCEPTION 'shared resource claim must be born reserved';
  END IF;
  SELECT fence."generation" INTO authoritative_generation
  FROM "shared_resource_fences" fence
  WHERE fence."resourceKey" = NEW."resourceKey"
  FOR SHARE;
  IF authoritative_generation IS NULL
    OR NEW."fenceGeneration" IS DISTINCT FROM authoritative_generation
  THEN
    RAISE EXCEPTION 'shared resource claim must bind the current authoritative fence generation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.magnus_enforce_shared_resource_claim_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."leaseId" IS DISTINCT FROM OLD."leaseId"
    OR NEW."resourceKey" IS DISTINCT FROM OLD."resourceKey"
    OR NEW."fenceGeneration" IS DISTINCT FROM OLD."fenceGeneration"
  THEN
    RAISE EXCEPTION 'shared resource claim identity is immutable';
  END IF;
  IF (OLD."state" = 'released' AND NEW."state" <> 'released')
    OR (OLD."state" = 'unknown' AND NEW."state" NOT IN ('unknown','released'))
    OR (OLD."state" = 'running' AND NEW."state" NOT IN ('running','unknown','released'))
    OR (OLD."state" = 'reserved' AND NEW."state" NOT IN ('reserved','running','released'))
  THEN
    RAISE EXCEPTION 'invalid shared resource claim transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.magnus_enforce_shared_resource_fence_generation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."resourceKey" IS DISTINCT FROM OLD."resourceKey" THEN
    RAISE EXCEPTION 'shared resource fence identity is immutable';
  END IF;
  IF NEW."generation" <= OLD."generation" THEN
    RAISE EXCEPTION 'shared resource fence generations must increase';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.magnus_enforce_shared_resource_fence_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."generation" <> 1 THEN
    RAISE EXCEPTION 'shared resource fence history must begin at generation one';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.magnus_enforce_shared_resource_lease_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  assertion JSONB;
  issued_at BIGINT;
  expires_at BIGINT;
BEGIN
  IF NEW."state" <> 'reserved'
    OR NEW."startedAt" IS NOT NULL
    OR NEW."settledAt" IS NOT NULL
    OR NEW."settlement" IS NOT NULL
    OR NEW."evidenceSha256" IS NOT NULL
    OR NEW."settlementRecordSha256" IS NOT NULL
    OR NEW."terminalEvidenceJson" IS NOT NULL
    OR NEW."reconciliationDecisionId" IS NOT NULL
    OR NEW."reconciliationJson" IS NOT NULL
  THEN
    RAISE EXCEPTION 'shared resource lease must be born reserved without execution or settlement evidence';
  END IF;
  IF NEW."id" !~ '^[A-Za-z0-9_-]{16,64}$'
    OR NEW."missionRootId" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR NEW."taskId" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR NEW."operationId" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR NEW."ownerActor" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR (NEW."callerKind" = 'delegated'
      AND NEW."delegationId" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    OR NEW."missionIssuer" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR NEW."missionKeyId" !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR NEW."actionClass" NOT IN ('observe','analyze','create_artifact','create_draft',
      'reversible_change','deploy','external_publish','destructive_response')
    OR NEW."deadline" <= NEW."acquiredAt"
    OR NEW."resourceSetBinding" = ''
  THEN
    RAISE EXCEPTION 'shared resource lease initial identity is invalid';
  END IF;
  BEGIN
    assertion := NEW."missionAssertionJson"::JSONB;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'shared resource lease initial mission assertion is invalid';
  END;
  IF jsonb_typeof(assertion) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(assertion)) <> 5
    OR jsonb_typeof(assertion->'issuer') IS DISTINCT FROM 'string'
    OR jsonb_typeof(assertion->'keyId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(assertion->'issuedAt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(assertion->'expiresAt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(assertion->'signature') IS DISTINCT FROM 'string'
    OR assertion->>'issuer' IS DISTINCT FROM NEW."missionIssuer"
    OR assertion->>'keyId' IS DISTINCT FROM NEW."missionKeyId"
    OR COALESCE(assertion->>'issuedAt', '') !~ '^[1-9][0-9]{0,11}$'
    OR COALESCE(assertion->>'expiresAt', '') !~ '^[1-9][0-9]{0,11}$'
    OR COALESCE(assertion->>'signature', '') !~ '^[A-Za-z0-9+/]{80,128}={0,2}$'
    OR NEW."missionAssertionSha256" IS DISTINCT FROM
      encode(sha256(convert_to(NEW."missionAssertionJson", 'UTF8')), 'hex')
  THEN
    RAISE EXCEPTION 'shared resource lease initial mission assertion is invalid';
  END IF;
  issued_at := (assertion->>'issuedAt')::BIGINT;
  expires_at := (assertion->>'expiresAt')::BIGINT;
  IF expires_at <= issued_at OR expires_at > issued_at + 300 OR expires_at > 253402300799 THEN
    RAISE EXCEPTION 'shared resource lease initial mission assertion is invalid';
  END IF;
  RETURN NEW;
END;
$_$;

CREATE FUNCTION public.magnus_enforce_shared_resource_lease_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."missionRootId" IS DISTINCT FROM OLD."missionRootId"
    OR NEW."missionRevision" IS DISTINCT FROM OLD."missionRevision"
    OR NEW."taskId" IS DISTINCT FROM OLD."taskId"
    OR NEW."operationId" IS DISTINCT FROM OLD."operationId"
    OR NEW."requestSha256" IS DISTINCT FROM OLD."requestSha256"
    OR NEW."actionClass" IS DISTINCT FROM OLD."actionClass"
    OR NEW."ownerActor" IS DISTINCT FROM OLD."ownerActor"
    OR NEW."callerKind" IS DISTINCT FROM OLD."callerKind"
    OR NEW."delegationId" IS DISTINCT FROM OLD."delegationId"
    OR NEW."missionIssuer" IS DISTINCT FROM OLD."missionIssuer"
    OR NEW."missionKeyId" IS DISTINCT FROM OLD."missionKeyId"
    OR NEW."missionAssertionSha256" IS DISTINCT FROM OLD."missionAssertionSha256"
    OR NEW."missionAssertionJson" IS DISTINCT FROM OLD."missionAssertionJson"
    OR NEW."resourceSetBinding" IS DISTINCT FROM OLD."resourceSetBinding"
    OR NEW."deadline" IS DISTINCT FROM OLD."deadline"
    OR NEW."acquiredAt" IS DISTINCT FROM OLD."acquiredAt"
  THEN
    RAISE EXCEPTION 'shared resource lease identity is immutable';
  END IF;
  IF OLD."state" = 'released' AND NEW."state" <> 'released' THEN
    RAISE EXCEPTION 'released shared resource ownership cannot be revived';
  END IF;
  IF OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'shared resource lease start time is immutable';
  END IF;
  IF OLD."state" = 'released' AND (
    NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
    OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
    OR NEW."settlement" IS DISTINCT FROM OLD."settlement"
    OR NEW."evidenceSha256" IS DISTINCT FROM OLD."evidenceSha256"
    OR NEW."settlementRecordSha256" IS DISTINCT FROM OLD."settlementRecordSha256"
    OR NEW."terminalEvidenceJson" IS DISTINCT FROM OLD."terminalEvidenceJson"
    OR NEW."reconciliationDecisionId" IS DISTINCT FROM OLD."reconciliationDecisionId"
    OR NEW."reconciliationJson" IS DISTINCT FROM OLD."reconciliationJson"
  ) THEN
    RAISE EXCEPTION 'released shared resource settlement is immutable';
  END IF;
  IF NEW."state" = 'released' THEN
    IF NEW."settlement" LIKE 'signed-terminal:%' THEN
      IF NEW."terminalEvidenceJson" IS NULL OR NEW."reconciliationDecisionId" IS NOT NULL
        OR NEW."reconciliationJson" IS NOT NULL
        OR COALESCE(NEW."terminalEvidenceJson"::jsonb->>'signature', '') !~ '^[A-Za-z0-9+/]{80,128}={0,2}$'
        OR COALESCE(NEW."terminalEvidenceJson"::jsonb->>'issuer', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        OR COALESCE(NEW."terminalEvidenceJson"::jsonb->>'keyId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        OR COALESCE(NEW."terminalEvidenceJson"::jsonb->>'outcome', '') NOT IN ('succeeded', 'failed', 'no_effect')
        OR NEW."terminalEvidenceJson"::jsonb->>'missionRootId' IS DISTINCT FROM NEW."missionRootId"
        OR (NEW."terminalEvidenceJson"::jsonb->>'missionRevision')::INTEGER IS DISTINCT FROM NEW."missionRevision"
        OR NEW."terminalEvidenceJson"::jsonb->>'taskId' IS DISTINCT FROM NEW."taskId"
        OR NEW."terminalEvidenceJson"::jsonb->>'operationId' IS DISTINCT FROM NEW."operationId"
        OR NEW."terminalEvidenceJson"::jsonb->>'requestSha256' IS DISTINCT FROM NEW."requestSha256"
        OR NEW."terminalEvidenceJson"::jsonb->>'actionClass' IS DISTINCT FROM NEW."actionClass"
        OR NEW."terminalEvidenceJson"::jsonb->>'ownerActor' IS DISTINCT FROM NEW."ownerActor"
        OR NEW."terminalEvidenceJson"::jsonb->>'evidenceSha256' IS DISTINCT FROM NEW."evidenceSha256"
        OR (NEW."terminalEvidenceJson"::jsonb->>'version')::INTEGER IS DISTINCT FROM 1
        OR (NEW."terminalEvidenceJson"::jsonb->>'deadline')::BIGINT IS DISTINCT FROM EXTRACT(EPOCH FROM NEW."deadline")::BIGINT
        OR NEW."terminalEvidenceJson"::jsonb->'caller' IS DISTINCT FROM (CASE WHEN NEW."callerKind" = 'direct'
          THEN jsonb_build_object('kind', 'direct')
          ELSE jsonb_build_object('kind', 'delegated', 'delegationId', NEW."delegationId") END)
        OR NEW."terminalEvidenceJson"::jsonb->'resources' IS DISTINCT FROM (
          SELECT jsonb_agg(jsonb_build_object('resourceKey', claim."resourceKey",
            'fenceGeneration', claim."fenceGeneration"::TEXT) ORDER BY claim."resourceKey")
          FROM "shared_resource_lease_resources" claim WHERE claim."leaseId" = NEW."id"
        )
        OR NEW."settlement" IS DISTINCT FROM 'signed-terminal:' || (NEW."terminalEvidenceJson"::jsonb->>'outcome')
      THEN
        RAISE EXCEPTION 'released shared resource lease requires exact authenticated terminal evidence';
      END IF;
    ELSIF NEW."settlement" LIKE 'signed-reconciliation:%' THEN
      IF NEW."reconciliationJson" IS NULL OR NEW."terminalEvidenceJson" IS NOT NULL
        OR NEW."reconciliationDecisionId" IS NULL
        OR COALESCE(NEW."reconciliationJson"::jsonb->>'signature', '') !~ '^[a-f0-9]{64}$'
        OR NEW."reconciliationJson"::jsonb->>'missionRootId' IS DISTINCT FROM NEW."missionRootId"
        OR (NEW."reconciliationJson"::jsonb->>'missionRevision')::INTEGER IS DISTINCT FROM NEW."missionRevision"
        OR NEW."reconciliationJson"::jsonb->>'taskId' IS DISTINCT FROM NEW."taskId"
        OR NEW."reconciliationJson"::jsonb->>'operationId' IS DISTINCT FROM NEW."operationId"
        OR NEW."reconciliationJson"::jsonb->>'requestSha256' IS DISTINCT FROM NEW."requestSha256"
        OR NEW."reconciliationJson"::jsonb->>'actionClass' IS DISTINCT FROM NEW."actionClass"
        OR NEW."reconciliationJson"::jsonb->>'ownerActor' IS DISTINCT FROM NEW."ownerActor"
        OR NEW."reconciliationJson"::jsonb->>'evidenceSha256' IS DISTINCT FROM NEW."evidenceSha256"
        OR NEW."reconciliationJson"::jsonb->>'decisionId' IS DISTINCT FROM NEW."reconciliationDecisionId"
        OR (NEW."reconciliationJson"::jsonb->>'version')::INTEGER IS DISTINCT FROM 1
        OR (NEW."reconciliationJson"::jsonb->>'deadline')::BIGINT IS DISTINCT FROM EXTRACT(EPOCH FROM NEW."deadline")::BIGINT
        OR NEW."reconciliationJson"::jsonb->'caller' IS DISTINCT FROM (CASE WHEN NEW."callerKind" = 'direct'
          THEN jsonb_build_object('kind', 'direct')
          ELSE jsonb_build_object('kind', 'delegated', 'delegationId', NEW."delegationId") END)
        OR NEW."reconciliationJson"::jsonb->'resources' IS DISTINCT FROM (
          SELECT jsonb_agg(jsonb_build_object('resourceKey', claim."resourceKey",
            'fenceGeneration', claim."fenceGeneration"::TEXT) ORDER BY claim."resourceKey")
          FROM "shared_resource_lease_resources" claim WHERE claim."leaseId" = NEW."id"
        )
        OR NEW."settlement" IS DISTINCT FROM 'signed-reconciliation:' || (NEW."reconciliationJson"::jsonb->>'disposition')
      THEN
        RAISE EXCEPTION 'released shared resource lease requires exact authenticated reconciliation evidence';
      END IF;
    ELSE
      RAISE EXCEPTION 'released shared resource lease requires authenticated settlement evidence';
    END IF;
  END IF;
  IF (OLD."state" = 'unknown' AND NEW."state" NOT IN ('unknown','released'))
    OR (OLD."state" = 'running' AND NEW."state" NOT IN ('running','unknown','released'))
    OR (OLD."state" = 'reserved' AND NEW."state" NOT IN ('reserved','running','released'))
  THEN
    RAISE EXCEPTION 'invalid shared resource lease transition';
  END IF;
  RETURN NEW;
END;
$_$;

CREATE FUNCTION public.magnus_reject_command_resource_authority_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
    OR NEW."resourceKey" IS DISTINCT FROM OLD."resourceKey"
    OR NEW."serviceUnit" IS DISTINCT FROM OLD."serviceUnit"
    OR NEW."commandId" IS DISTINCT FROM OLD."commandId"
    OR NEW."ownerActor" IS DISTINCT FROM OLD."ownerActor"
    OR NEW."requestSha256" IS DISTINCT FROM OLD."requestSha256"
    OR NEW."coordinationJson" IS DISTINCT FROM OLD."coordinationJson"
    OR NEW."directCommand" IS DISTINCT FROM OLD."directCommand"
    OR NEW."deadline" IS DISTINCT FROM OLD."deadline"
    OR NEW."completionClass" IS DISTINCT FROM OLD."completionClass"
    OR NEW."completionRegistryVersion" IS DISTINCT FROM OLD."completionRegistryVersion"
    OR NEW."completionRegistrySha256" IS DISTINCT FROM OLD."completionRegistrySha256"
    OR NEW."completionDescriptorId" IS DISTINCT FROM OLD."completionDescriptorId"
    OR NEW."completionOccurrenceId" IS DISTINCT FROM OLD."completionOccurrenceId"
    OR NEW."completionSpecSha256" IS DISTINCT FROM OLD."completionSpecSha256"
  THEN
    RAISE EXCEPTION 'command resource authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.magnus_reject_recovery_exercise_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'engineering recovery exercise records are immutable';
END;
$$;

CREATE FUNCTION public.magnus_reject_resource_participant_identity_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."workId" IS DISTINCT FROM OLD."workId"
    OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
    OR NEW."nodeFqdn" IS DISTINCT FROM OLD."nodeFqdn"
    OR NEW."participant" IS DISTINCT FROM OLD."participant"
    OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."epoch" IS DISTINCT FROM OLD."epoch"
    OR NEW."barrierId" IS DISTINCT FROM OLD."barrierId"
    OR NEW."requestSha256" IS DISTINCT FROM OLD."requestSha256"
    OR NEW."operationSha256" IS DISTINCT FROM OLD."operationSha256"
    OR NEW."fence" IS DISTINCT FROM OLD."fence"
    OR NEW."deadline" IS DISTINCT FROM OLD."deadline"
  THEN
    RAISE EXCEPTION 'resource participant reservation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.magnus_reject_shared_resource_claim_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'shared resource claim history cannot be deleted or rewritten';
END;
$$;

CREATE FUNCTION public.magnus_reject_shared_resource_fence_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'shared resource fence history cannot be deleted or reset';
END;
$$;

CREATE FUNCTION public.managed_cron_clear_acknowledgement_on_disable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."enabled" IS TRUE AND NEW."enabled" IS FALSE THEN
    NEW."acknowledgementProtocolVersion" := NULL;
    NEW."stageCommandSha256" := NULL;
    NEW."stageReceiptSha256" := NULL;
    NEW."stageAcknowledgedAt" := NULL;
    NEW."activationCommandSha256" := NULL;
    NEW."activationReceiptSha256" := NULL;
    NEW."activationAcknowledgedAt" := NULL;
    NEW."acknowledgedJobId" := NULL;
    NEW."acknowledgedRevision" := NULL;
    NEW."acknowledgedSpecSha256" := NULL;
    NEW."acknowledgedSpecJson" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.a2a_tasks (
    id text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'submitted'::text NOT NULL,
    "fromAgent" text DEFAULT 'user'::text NOT NULL,
    "toAgent" text DEFAULT 'magnus'::text NOT NULL,
    input text DEFAULT '{}'::text NOT NULL,
    output text,
    artifacts text DEFAULT '[]'::text NOT NULL,
    history text DEFAULT '[]'::text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.agents (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    version text NOT NULL,
    status public."AgentStatus" DEFAULT 'RUNNING'::public."AgentStatus" NOT NULL,
    pid integer,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastCheckIn" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    capabilities text DEFAULT '[]'::text NOT NULL
);

CREATE TABLE public.ai_conversations (
    id text NOT NULL,
    title text DEFAULT 'New conversation'::text NOT NULL,
    type text DEFAULT 'chat'::text NOT NULL,
    "nodeId" text,
    "parentId" text,
    "forkedFromMessageId" text,
    status text DEFAULT 'active'::text NOT NULL,
    summary text,
    "createdBy" text DEFAULT 'system'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.ai_dashboards (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    layout text DEFAULT '[]'::text NOT NULL,
    "createdBy" text DEFAULT 'system'::text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.ai_memories (
    id text NOT NULL,
    key text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    content text NOT NULL,
    source text DEFAULT 'heartbeat'::text NOT NULL,
    relevance double precision DEFAULT 1.0 NOT NULL,
    "accessedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.ai_messages (
    id text NOT NULL,
    "conversationId" text NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    "toolCalls" text DEFAULT '[]'::text NOT NULL,
    thinking text,
    "structuredAnalysis" text,
    "tokenCount" integer DEFAULT 0 NOT NULL,
    "isRead" boolean DEFAULT false NOT NULL,
    "readAt" timestamp(3) without time zone,
    "pendingApproval" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.ai_scheduled_ops (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "cronExpr" text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    type text DEFAULT 'chat'::text NOT NULL,
    prompt text NOT NULL,
    "nodeId" text,
    "createdBy" text NOT NULL,
    "lastRunAt" timestamp(3) without time zone,
    "nextRunAt" timestamp(3) without time zone,
    "runCount" integer DEFAULT 0 NOT NULL,
    "lastResult" text,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.alert_condition_states (
    "ruleId" text NOT NULL,
    "nodeId" text NOT NULL,
    "breachedAt" timestamp(3) without time zone NOT NULL,
    "lastObservedAt" timestamp(3) without time zone NOT NULL,
    "lastValue" double precision NOT NULL
);

CREATE TABLE public.alert_rules (
    id text NOT NULL,
    name text NOT NULL,
    metric text NOT NULL,
    operator text NOT NULL,
    threshold double precision NOT NULL,
    "durationSeconds" integer DEFAULT 0 NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    "nodeFilter" text DEFAULT '*'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "cooldownMinutes" integer DEFAULT 15 NOT NULL,
    "createdBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.alert_violations (
    id text NOT NULL,
    "ruleId" text NOT NULL,
    "nodeId" text NOT NULL,
    "nodeName" text,
    metric text NOT NULL,
    value double precision NOT NULL,
    threshold double precision NOT NULL,
    severity text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "resolvedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.anomaly_events (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    metric text NOT NULL,
    value double precision NOT NULL,
    "zScore" double precision NOT NULL,
    mean double precision NOT NULL,
    "stdDev" double precision NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    "resolvedAt" timestamp(3) without time zone,
    "firstSeenAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastSeenAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "occurrenceCount" integer DEFAULT 1 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "healthSnapshotId" text
);

CREATE TABLE public.application_observations (
    id text NOT NULL,
    "projectId" text NOT NULL,
    "serviceId" text NOT NULL,
    "nodeId" text NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    "resultJson" text DEFAULT '{}'::text NOT NULL,
    "observedAt" timestamp(3) without time zone
);

CREATE TABLE public.ardent_installations (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    owner text,
    version text,
    installed boolean DEFAULT false NOT NULL,
    reachable boolean DEFAULT false NOT NULL,
    error text,
    "observedAt" timestamp(3) without time zone,
    "checkedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.ardent_profiles (
    id text NOT NULL,
    "installationId" text NOT NULL,
    name text NOT NULL,
    "displayName" text NOT NULL,
    backend text,
    "apiPort" integer,
    running boolean DEFAULT false NOT NULL,
    "a2aEnabled" boolean DEFAULT false NOT NULL,
    "telegramEnabled" boolean DEFAULT false NOT NULL,
    error text,
    "observedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.ardent_scope_enrollments (
    "nodeId" text NOT NULL,
    "nodeFqdn" text NOT NULL,
    epoch integer NOT NULL,
    "barrierId" text NOT NULL,
    "decisionId" text NOT NULL,
    "assertionJson" text NOT NULL,
    "evidenceSha256" text NOT NULL,
    "activatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.command_resource_fences (
    "resourceKey" text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.command_resource_leases (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    "resourceKey" text NOT NULL,
    "serviceUnit" text,
    "commandId" text NOT NULL,
    "ownerActor" text NOT NULL,
    "requestSha256" text NOT NULL,
    "coordinationJson" text NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    "directCommand" boolean DEFAULT false NOT NULL,
    deadline timestamp(3) without time zone NOT NULL,
    "acquiredAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "dispatchedAt" timestamp(3) without time zone,
    "settledAt" timestamp(3) without time zone,
    settlement text,
    "evidenceSha256" text,
    "completionClass" text,
    "completionRegistryVersion" integer,
    "completionRegistrySha256" text,
    "completionDescriptorId" text,
    "completionOccurrenceId" text,
    "completionSpecSha256" text,
    CONSTRAINT command_resource_leases_completion_authority_complete CHECK (((("completionClass" IS NULL) AND ("completionRegistryVersion" IS NULL) AND ("completionRegistrySha256" IS NULL) AND ("completionDescriptorId" IS NULL) AND ("completionOccurrenceId" IS NULL) AND ("completionSpecSha256" IS NULL)) OR (("completionClass" = ANY (ARRAY['node-supervised-command'::text, 'native-http'::text])) AND ("completionRegistryVersion" = 1) AND ("completionRegistrySha256" ~ '^[a-f0-9]{64}$'::text) AND ("completionDescriptorId" ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'::text) AND ("completionOccurrenceId" IS NULL) AND ("completionSpecSha256" IS NULL)) OR (("completionClass" = 'managed-scheduler'::text) AND ("completionRegistryVersion" IS NULL) AND ("completionRegistrySha256" IS NULL) AND ("completionDescriptorId" IS NULL) AND ("completionOccurrenceId" ~ '^[a-f0-9]{64}$'::text) AND ("completionSpecSha256" ~ '^[a-f0-9]{64}$'::text)) OR (("completionClass" = 'unverified'::text) AND ("completionRegistryVersion" IS NULL) AND ("completionRegistrySha256" IS NULL) AND ("completionDescriptorId" IS NULL) AND ("completionOccurrenceId" IS NULL) AND ("completionSpecSha256" IS NULL)))),
    CONSTRAINT command_resource_leases_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'running'::text, 'unknown'::text, 'released'::text])))
);

CREATE TABLE public.command_results (
    id text NOT NULL,
    "commandId" text NOT NULL,
    "exitCode" integer NOT NULL,
    stdout text NOT NULL,
    stderr text NOT NULL,
    "durationMs" integer NOT NULL,
    truncated boolean DEFAULT false NOT NULL
);

CREATE TABLE public.council_admission_fences (
    "nodeId" text NOT NULL,
    "nodeFqdn" text NOT NULL,
    "releaseId" text NOT NULL,
    "closedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.cron_job_executions (
    id text NOT NULL,
    "cronJobId" text NOT NULL,
    "nodeId" text NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "exitCode" integer,
    stdout text NOT NULL,
    stderr text NOT NULL,
    "durationMs" integer
);

CREATE TABLE public.cron_jobs (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    schedule text NOT NULL,
    command text NOT NULL,
    args text DEFAULT '[]'::text NOT NULL,
    "workingDirectory" text,
    environment text DEFAULT '{}'::text NOT NULL,
    "timeoutSeconds" integer DEFAULT 600 NOT NULL,
    status public."CronJobStatus" DEFAULT 'ACTIVE'::public."CronJobStatus" NOT NULL,
    "lastRunAt" timestamp(3) without time zone,
    "lastRunExitCode" integer,
    "nextRunAt" timestamp(3) without time zone,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.deploy_jobs (
    id text NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    concurrency integer DEFAULT 5 NOT NULL,
    targets text NOT NULL,
    results text,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "createdBy" text NOT NULL
);

CREATE TABLE public.drift_scans (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    "roleId" text,
    status text NOT NULL,
    findings text NOT NULL,
    "scannedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.engineering_metric_samples (
    id text NOT NULL,
    "applicationId" text NOT NULL,
    "nodeId" text NOT NULL,
    metric text NOT NULL,
    "sourceKey" text NOT NULL,
    unit text NOT NULL,
    value double precision NOT NULL,
    "observedAt" timestamp(3) without time zone NOT NULL,
    "probeContractSha256" text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    "httpStatus" integer NOT NULL,
    "evidenceSha256" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT engineering_metric_samples_http_status_check CHECK ((("httpStatus" >= 200) AND ("httpStatus" <= 399))),
    CONSTRAINT engineering_metric_samples_method_check CHECK ((method = ANY (ARRAY['GET'::text, 'POST'::text]))),
    CONSTRAINT engineering_metric_samples_metric_check CHECK ((metric = ANY (ARRAY['gpu_queue'::text, 'dependency_latency'::text]))),
    CONSTRAINT engineering_metric_samples_path_check CHECK ((path ~ '^/[A-Za-z0-9/_.-]*$'::text)),
    CONSTRAINT engineering_metric_samples_probe_digest_check CHECK (("probeContractSha256" ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT engineering_metric_samples_unit_check CHECK ((unit = ANY (ARRAY['jobs'::text, 'ms'::text]))),
    CONSTRAINT engineering_metric_samples_value_check CHECK ((value >= (0)::double precision))
);

CREATE TABLE public.engineering_recovery_exercises (
    id text NOT NULL,
    "targetId" text NOT NULL,
    scenario text NOT NULL,
    "startedAt" timestamp(3) without time zone NOT NULL,
    "recoveredAt" timestamp(3) without time zone NOT NULL,
    "recoveryPointAt" timestamp(3) without time zone NOT NULL,
    "rtoObjectiveSeconds" integer NOT NULL,
    "rpoObjectiveSeconds" integer NOT NULL,
    "beforeStateSha256" text NOT NULL,
    "beforeTaskSha256" text NOT NULL,
    "beforeArtifactSha256" text NOT NULL,
    "afterStateSha256" text NOT NULL,
    "afterTaskSha256" text NOT NULL,
    "afterArtifactSha256" text NOT NULL,
    "beforeEvidenceJson" text NOT NULL,
    "afterEvidenceJson" text NOT NULL,
    "runtimeEvidenceJson" text NOT NULL,
    "directEvidenceSha256" text NOT NULL,
    "runnerIssuer" text NOT NULL,
    "runnerKeyId" text NOT NULL,
    "runnerPublicKeySha256" text NOT NULL,
    "runnerNonce" text NOT NULL,
    "runnerIssuedAt" timestamp(3) without time zone NOT NULL,
    "runnerExpiresAt" timestamp(3) without time zone NOT NULL,
    "runnerExerciseContractSha256" text NOT NULL,
    "runnerReceiptJson" text NOT NULL,
    "runnerReceiptSha256" text NOT NULL,
    "inventorySnapshotSha256" text NOT NULL,
    "recordSha256" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT engineering_recovery_exercises_chronology_check CHECK ((("recoveryPointAt" <= "startedAt") AND ("startedAt" <= "recoveredAt") AND ("recoveredAt" <= "runnerIssuedAt") AND ("runnerIssuedAt" <= "createdAt") AND ("createdAt" < "runnerExpiresAt"))),
    CONSTRAINT engineering_recovery_exercises_digest_check CHECK ((("beforeStateSha256" ~ '^[a-f0-9]{64}$'::text) AND ("beforeTaskSha256" ~ '^[a-f0-9]{64}$'::text) AND ("beforeArtifactSha256" ~ '^[a-f0-9]{64}$'::text) AND ("afterStateSha256" ~ '^[a-f0-9]{64}$'::text) AND ("afterTaskSha256" ~ '^[a-f0-9]{64}$'::text) AND ("afterArtifactSha256" ~ '^[a-f0-9]{64}$'::text) AND ("directEvidenceSha256" ~ '^[a-f0-9]{64}$'::text) AND ("runnerPublicKeySha256" ~ '^[a-f0-9]{64}$'::text) AND ("runnerExerciseContractSha256" ~ '^[a-f0-9]{64}$'::text) AND ("runnerReceiptSha256" ~ '^[a-f0-9]{64}$'::text) AND ("inventorySnapshotSha256" ~ '^[a-f0-9]{64}$'::text) AND ("recordSha256" ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT engineering_recovery_exercises_objectives_check CHECK ((("rtoObjectiveSeconds" > 0) AND ("rpoObjectiveSeconds" >= 0))),
    CONSTRAINT engineering_recovery_exercises_scenario_check CHECK ((scenario = ANY (ARRAY['backup_restore'::text, 'rollback'::text, 'specialist_loss'::text, 'coordinator_loss'::text]))),
    CONSTRAINT engineering_recovery_exercises_target_check CHECK (("targetId" ~ '^disposable:[A-Za-z0-9._/-]{1,140}$'::text))
);

CREATE TABLE public.execution_runs (
    id text NOT NULL,
    type text NOT NULL,
    "rolloutStrategy" text DEFAULT 'all_at_once'::text NOT NULL,
    status text DEFAULT 'created'::text NOT NULL,
    "totalNodes" integer DEFAULT 0 NOT NULL,
    "completedNodes" integer DEFAULT 0 NOT NULL,
    "failedNodes" integer DEFAULT 0 NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone
);

CREATE TABLE public.file_patch_tasks (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    "filePath" text NOT NULL,
    direction text DEFAULT 'push'::text NOT NULL,
    content text,
    checksum text,
    "previousChecksum" text,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone
);

CREATE TABLE public.gpu_snapshots (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    "sampledAt" timestamp(3) without time zone NOT NULL,
    "sampleIntervalSeconds" integer DEFAULT 30 NOT NULL,
    status text DEFAULT 'unavailable'::text NOT NULL,
    devices text NOT NULL,
    "maxUtilizationPercent" double precision,
    "maxFanPercent" double precision
);

CREATE TABLE public.health_snapshots (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "cpuUsagePercent" double precision NOT NULL,
    "cpuCores" integer NOT NULL,
    "cpuLoadAverage" text NOT NULL,
    "memoryTotalBytes" bigint NOT NULL,
    "memoryUsedBytes" bigint NOT NULL,
    "memoryPercent" double precision NOT NULL,
    "swapTotalBytes" bigint NOT NULL,
    "swapUsedBytes" bigint NOT NULL,
    disks text NOT NULL,
    network text NOT NULL,
    services text NOT NULL,
    wazuh text DEFAULT '{}'::text NOT NULL,
    "systemUpdates" text DEFAULT '{}'::text NOT NULL,
    "cockpitAvailable" boolean DEFAULT false NOT NULL,
    source text DEFAULT 'system-probe'::text NOT NULL
);

CREATE TABLE public.hermes_core_rollout_hosts (
    id text NOT NULL,
    "rolloutId" text NOT NULL,
    hostname text NOT NULL,
    "installationId" text NOT NULL,
    stage integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "leaseExpiresAt" timestamp(3) without time zone,
    "evidenceJson" text DEFAULT '{}'::text NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_core_rollouts (
    id text NOT NULL,
    tag text NOT NULL,
    "bootstrapScriptSha256" text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_credential_pool_attachments (
    id text NOT NULL,
    "poolId" text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "lastSyncedAt" timestamp(3) without time zone,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_credential_pools (
    id text NOT NULL,
    name text NOT NULL,
    provider text NOT NULL,
    "rotationPolicy" text DEFAULT 'rate-limit'::text NOT NULL,
    "secretRefsJson" text DEFAULT '[]'::text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_cron_jobs (
    id text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    name text NOT NULL,
    prompt text DEFAULT ''::text NOT NULL,
    "cronExpr" text DEFAULT ''::text NOT NULL,
    "naturalLanguage" text,
    "attachedSkillsJson" text DEFAULT '[]'::text NOT NULL,
    "deliveryJson" text DEFAULT '{}'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "lastRunAt" timestamp(3) without time zone,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_hooks (
    id text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    event text NOT NULL,
    target text NOT NULL,
    "configJson" text DEFAULT '{}'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "lastSyncedAt" timestamp(3) without time zone,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_installations (
    id text NOT NULL,
    "nodeId" text,
    hostname text NOT NULL,
    "sshPort" integer DEFAULT 22 NOT NULL,
    "displayName" text,
    "installMode" text DEFAULT 'unknown'::text NOT NULL,
    "hermesHome" text DEFAULT '~/.hermes'::text NOT NULL,
    "hermesBin" text DEFAULT 'hermes'::text NOT NULL,
    version text,
    status text DEFAULT 'unknown'::text NOT NULL,
    "gatewayStatus" text DEFAULT 'unknown'::text NOT NULL,
    "dashboardHost" text DEFAULT '127.0.0.1'::text NOT NULL,
    "dashboardPort" integer DEFAULT 9119 NOT NULL,
    "dashboardStatus" text DEFAULT 'unknown'::text NOT NULL,
    "apiServerEnabled" boolean DEFAULT false NOT NULL,
    "apiServerHost" text DEFAULT '127.0.0.1'::text NOT NULL,
    "apiServerPort" integer,
    "lastDetectedAt" timestamp(3) without time zone,
    "lastSyncedAt" timestamp(3) without time zone,
    metadata text DEFAULT '{}'::text NOT NULL,
    "rawStatus" text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_mcp_server_attachments (
    id text NOT NULL,
    "serverId" text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "lastSyncedAt" timestamp(3) without time zone,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_mcp_servers (
    id text NOT NULL,
    name text NOT NULL,
    transport text NOT NULL,
    endpoint text DEFAULT ''::text NOT NULL,
    "argsJson" text DEFAULT '[]'::text NOT NULL,
    "envJson" text DEFAULT '{}'::text NOT NULL,
    "toolFilterJson" text DEFAULT '[]'::text NOT NULL,
    "samplingEnabled" boolean DEFAULT false NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_messaging_bindings (
    id text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    platform text NOT NULL,
    "channelIdsJson" text DEFAULT '[]'::text NOT NULL,
    "voiceEnabled" boolean DEFAULT false NOT NULL,
    "voiceModel" text,
    "ttsProvider" text,
    "secretRef" text,
    metadata text DEFAULT '{}'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "lastSyncedAt" timestamp(3) without time zone,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_operation_jobs (
    id text NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    "installationId" text,
    "profileId" text,
    "targetHost" text,
    "createdBy" text NOT NULL,
    steps text DEFAULT '[]'::text NOT NULL,
    result text,
    error text,
    metadata text DEFAULT '{}'::text NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone
);

CREATE TABLE public.hermes_plugin_installs (
    id text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    "pluginSlug" text NOT NULL,
    "pluginType" text DEFAULT 'general'::text NOT NULL,
    "pinnedVersion" text,
    status text DEFAULT 'pending'::text NOT NULL,
    "healthState" text DEFAULT 'unknown'::text NOT NULL,
    "lastSyncedAt" timestamp(3) without time zone,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_profiles (
    id text NOT NULL,
    "installationId" text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "profileHome" text DEFAULT ''::text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "providerSummary" text,
    "modelSummary" text,
    distribution text,
    "gatewayStatus" text DEFAULT 'unknown'::text NOT NULL,
    "apiServerEnabled" boolean DEFAULT false NOT NULL,
    "apiServerHost" text DEFAULT '127.0.0.1'::text NOT NULL,
    "apiServerPort" integer,
    "apiServerKeyFingerprint" text,
    capabilities text DEFAULT '{}'::text NOT NULL,
    "envStatus" text DEFAULT '{}'::text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "lastSyncedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_provider_configs (
    id text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    "chainJson" text DEFAULT '[]'::text NOT NULL,
    "sortStrategy" text DEFAULT 'priority'::text NOT NULL,
    "whitelistJson" text DEFAULT '[]'::text NOT NULL,
    "blacklistJson" text DEFAULT '[]'::text NOT NULL,
    "visionOverride" text,
    "compressionOverride" text,
    "lastSyncedAt" timestamp(3) without time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_registry_clients (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    "installationId" text NOT NULL,
    "tokenSha256" text NOT NULL,
    "canPull" boolean DEFAULT false NOT NULL,
    "canSubmit" boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "revokedAt" timestamp(3) without time zone
);

CREATE TABLE public.hermes_registry_inventory (
    id text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    kind text NOT NULL,
    slug text NOT NULL,
    "pluginType" text,
    "sourceKind" text DEFAULT 'unknown'::text NOT NULL,
    "sourceUrl" text,
    commit text,
    version text,
    status text DEFAULT 'observed'::text NOT NULL,
    "observedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.hermes_registry_receipts (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    kind text NOT NULL,
    slug text NOT NULL,
    revision integer NOT NULL,
    sha256 text NOT NULL,
    status text NOT NULL,
    "detailsJson" text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.hermes_registry_revisions (
    id text NOT NULL,
    kind text NOT NULL,
    slug text NOT NULL,
    revision integer NOT NULL,
    sha256 text NOT NULL,
    "artifactJson" text NOT NULL,
    "metadataJson" text DEFAULT '{}'::text NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    "sourceHost" text,
    "publishedBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.hermes_registry_targets (
    id text NOT NULL,
    kind text NOT NULL,
    slug text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    "pinnedRevision" integer,
    enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "observedRevision" integer,
    "lastReceiptAt" timestamp(3) without time zone,
    error text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_role_applications (
    id text NOT NULL,
    "roleId" text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "appliedAt" timestamp(3) without time zone,
    error text,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_roles (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "personalityMd" text DEFAULT ''::text NOT NULL,
    "personalityRef" text,
    "toolsetsJson" text DEFAULT '[]'::text NOT NULL,
    "skillsJson" text DEFAULT '[]'::text NOT NULL,
    "providerJson" text DEFAULT '{}'::text NOT NULL,
    "cronJson" text DEFAULT '[]'::text NOT NULL,
    "messagingJson" text DEFAULT '[]'::text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_skill_assignments (
    id text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    "skillSlug" text NOT NULL,
    "pinnedVersion" text,
    source text DEFAULT 'magnus-skills'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "lastSyncedAt" timestamp(3) without time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.hermes_toolset_policies (
    id text NOT NULL,
    "installationId" text NOT NULL,
    "profileId" text DEFAULT ''::text NOT NULL,
    toolset text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "approvalMode" text DEFAULT 'auto'::text NOT NULL,
    "perToolHooks" text DEFAULT '[]'::text NOT NULL,
    "allowList" text DEFAULT '[]'::text NOT NULL,
    "denyList" text DEFAULT '[]'::text NOT NULL,
    "lastSyncedAt" timestamp(3) without time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.incident_lessons (
    id text NOT NULL,
    "incidentId" text NOT NULL,
    "nodeId" text,
    symptom text NOT NULL,
    cause text NOT NULL,
    "runbookVersion" text NOT NULL,
    "evidenceIds" text NOT NULL,
    "reviewedBy" text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "supersededAt" timestamp(3) without time zone,
    "memoryId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.library_categories (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    color text DEFAULT '#6366f1'::text NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.library_files (
    id text NOT NULL,
    name text NOT NULL,
    "fileName" text NOT NULL,
    "mimeType" text DEFAULT 'text/markdown'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    "sizeBytes" integer DEFAULT 0 NOT NULL,
    "categoryId" text,
    tags text DEFAULT '[]'::text NOT NULL,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.log_entries (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    source text NOT NULL,
    level text NOT NULL,
    message text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.magnus_release_canaries (
    epoch bigint NOT NULL,
    "tokenSha256" character varying(64) NOT NULL,
    "acceptedCommit" character varying(40) NOT NULL,
    "sourceTreeSha256" character varying(64) NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT magnus_release_canaries_commit_check CHECK ((("acceptedCommit")::text ~ '^[0-9a-f]{40}$'::text)),
    CONSTRAINT magnus_release_canaries_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT magnus_release_canaries_source_check CHECK ((("sourceTreeSha256")::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT magnus_release_canaries_token_check CHECK ((("tokenSha256")::text ~ '^[0-9a-f]{64}$'::text))
);

COMMENT ON TABLE public.magnus_release_canaries IS 'Append-only database side of the root-owned Magnus release anti-rewind chain';

CREATE TABLE public.maintenance_windows (
    id text NOT NULL,
    reason text NOT NULL,
    "nodeIds" text NOT NULL,
    "serviceIds" text DEFAULT '[]'::text NOT NULL,
    "actorId" text NOT NULL,
    "startsAt" timestamp(3) without time zone NOT NULL,
    "endsAt" timestamp(3) without time zone NOT NULL,
    "cancelledAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.managed_cron_definitions (
    "cronJobId" text NOT NULL,
    "nodeId" text NOT NULL,
    "jobId" text NOT NULL,
    revision integer NOT NULL,
    "specSha256" text NOT NULL,
    "specJson" text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "acknowledgementProtocolVersion" integer,
    "stageCommandSha256" text,
    "stageReceiptSha256" text,
    "stageAcknowledgedAt" timestamp(3) without time zone,
    "activationCommandSha256" text,
    "activationReceiptSha256" text,
    "activationAcknowledgedAt" timestamp(3) without time zone,
    "acknowledgedJobId" text,
    "acknowledgedRevision" integer,
    "acknowledgedSpecSha256" text,
    "acknowledgedSpecJson" text,
    CONSTRAINT managed_cron_definitions_revision_check CHECK ((revision > 0)),
    CONSTRAINT managed_cron_enabled_requires_v1_acknowledgement CHECK (((enabled = false) OR (("acknowledgementProtocolVersion" IS NOT NULL) AND ("acknowledgementProtocolVersion" = 1) AND ("stageCommandSha256" IS NOT NULL) AND ("stageReceiptSha256" IS NOT NULL) AND ("stageAcknowledgedAt" IS NOT NULL) AND ("activationCommandSha256" IS NOT NULL) AND ("activationReceiptSha256" IS NOT NULL) AND ("activationAcknowledgedAt" IS NOT NULL) AND ("acknowledgedJobId" IS NOT NULL) AND ("acknowledgedRevision" IS NOT NULL) AND ("acknowledgedSpecSha256" IS NOT NULL) AND ("acknowledgedSpecJson" IS NOT NULL) AND ("jobId" = "acknowledgedJobId") AND (revision = "acknowledgedRevision") AND ("specSha256" = "acknowledgedSpecSha256") AND ("specJson" = "acknowledgedSpecJson"))))
);

CREATE TABLE public.managed_cron_occurrences (
    id text NOT NULL,
    "cronJobId" text NOT NULL,
    "nodeId" text NOT NULL,
    revision integer NOT NULL,
    "specSha256" text NOT NULL,
    "scheduledAt" timestamp(3) without time zone NOT NULL,
    deadline timestamp(3) without time zone NOT NULL,
    "commandId" text NOT NULL,
    state text DEFAULT 'admitting'::text NOT NULL,
    "admissionJson" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT managed_cron_occurrences_revision_check CHECK ((revision > 0))
);

CREATE TABLE public.nodes (
    id text NOT NULL,
    name text NOT NULL,
    hostname text NOT NULL,
    "ipAddress" text NOT NULL,
    port integer DEFAULT 4100 NOT NULL,
    status public."NodeStatus" DEFAULT 'PROVISIONING'::public."NodeStatus" NOT NULL,
    os text NOT NULL,
    arch text NOT NULL,
    tags text DEFAULT '[]'::text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    token text NOT NULL,
    "roleId" text,
    "lastHeartbeatAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.notification_preferences (
    id text NOT NULL,
    "userId" text NOT NULL,
    channel text DEFAULT 'in_app'::text NOT NULL,
    category text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "minSeverity" text DEFAULT 'info'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.notifications (
    id text NOT NULL,
    type text NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    "nodeId" text,
    "nodeName" text,
    "sourceRef" text,
    metadata text DEFAULT '{}'::text NOT NULL,
    "isRead" boolean DEFAULT false NOT NULL,
    "readAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "suppressedBy" text
);

CREATE TABLE public.remediation_executions (
    id text NOT NULL,
    "ruleId" text NOT NULL,
    "anomalyEventId" text NOT NULL,
    "nodeId" text NOT NULL,
    "orchestraRunId" text,
    status text DEFAULT 'triggered'::text NOT NULL,
    input text DEFAULT ''::text NOT NULL,
    output text,
    "triggeredAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone
);

CREATE TABLE public.remediation_rules (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    metric text DEFAULT '*'::text NOT NULL,
    "severityThreshold" text DEFAULT 'critical'::text NOT NULL,
    "agentDefinitionId" text NOT NULL,
    input text DEFAULT ''::text NOT NULL,
    "cooldownMinutes" integer DEFAULT 60 NOT NULL,
    "maxConcurrentRuns" integer DEFAULT 1 NOT NULL,
    "nodeFilter" text,
    enabled boolean DEFAULT true NOT NULL,
    "createdBy" text DEFAULT 'system'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.remote_commands (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    command text NOT NULL,
    args text DEFAULT '[]'::text NOT NULL,
    "workingDirectory" text,
    environment text DEFAULT '{}'::text NOT NULL,
    "timeoutSeconds" integer DEFAULT 300 NOT NULL,
    status public."CommandStatus" DEFAULT 'PENDING'::public."CommandStatus" NOT NULL,
    "riskLevel" text DEFAULT 'low'::text NOT NULL,
    "idempotencyKey" text NOT NULL,
    "correlationId" text,
    "createdBy" text NOT NULL,
    "approvedBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    "executionDeadline" timestamp(3) without time zone,
    "coordinationJson" text
);

CREATE TABLE public.resource_drain_participants (
    "nodeId" text NOT NULL,
    participant text NOT NULL,
    epoch integer NOT NULL,
    "barrierId" text NOT NULL,
    "challengeId" text NOT NULL,
    "challengeExpiresAt" timestamp(3) without time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "evidenceSha256" text,
    "receiptJson" text,
    "verifiedAt" timestamp(3) without time zone,
    CONSTRAINT resource_drain_participants_participant_check CHECK ((participant = ANY (ARRAY['agent'::text, 'api'::text, 'dashboard'::text, 'scheduler'::text])))
);

CREATE TABLE public.resource_enrollments (
    "nodeId" text NOT NULL,
    "nodeFqdn" text NOT NULL,
    state text DEFAULT 'legacy'::text NOT NULL,
    epoch integer DEFAULT 0 NOT NULL,
    "barrierId" text,
    "startedBy" text,
    "startedAt" timestamp(3) without time zone,
    "enrolledAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT resource_enrollments_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT resource_enrollments_state_check CHECK ((state = ANY (ARRAY['legacy'::text, 'draining'::text, 'enrolled'::text])))
);

CREATE TABLE public.resource_participant_work (
    "workId" text NOT NULL,
    "nodeId" text NOT NULL,
    participant text NOT NULL,
    "ownerId" text NOT NULL,
    kind text NOT NULL,
    epoch integer NOT NULL,
    "barrierId" text,
    state text DEFAULT 'reserved'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "startedAt" timestamp(3) without time zone,
    "settledAt" timestamp(3) without time zone,
    settlement text,
    "evidenceSha256" text,
    "nodeFqdn" text,
    "requestSha256" text,
    "reconciliationDecisionId" text,
    "reconciliationJson" text,
    "operationSha256" text,
    fence bigint,
    deadline timestamp(3) without time zone,
    "nodeSessionReceiptSha256" text,
    "nodeSessionReceiptJson" text,
    CONSTRAINT resource_participant_work_authority_complete CHECK (((("operationSha256" IS NULL) AND (fence IS NULL) AND (deadline IS NULL)) OR (("operationSha256" ~ '^[a-f0-9]{64}$'::text) AND (fence > 0) AND (deadline IS NOT NULL)))),
    CONSTRAINT resource_participant_work_node_receipt_complete CHECK (((("nodeSessionReceiptSha256" IS NULL) AND ("nodeSessionReceiptJson" IS NULL)) OR (("nodeSessionReceiptSha256" ~ '^[a-f0-9]{64}$'::text) AND ("nodeSessionReceiptJson" IS NOT NULL)))),
    CONSTRAINT resource_participant_work_participant_check CHECK ((participant = ANY (ARRAY['agent'::text, 'api'::text, 'dashboard'::text, 'scheduler'::text]))),
    CONSTRAINT resource_participant_work_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'running'::text, 'unknown'::text, 'released'::text])))
);

CREATE TABLE public.role_applications (
    id text NOT NULL,
    "nodeId" text NOT NULL,
    "roleId" text NOT NULL,
    action text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    steps text DEFAULT '[]'::text NOT NULL,
    error text,
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.roles (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "libraryFileIds" text DEFAULT '[]'::text NOT NULL,
    "skillNames" text DEFAULT '[]'::text NOT NULL,
    "aptPackages" text DEFAULT '[]'::text NOT NULL,
    "npmPackages" text DEFAULT '[]'::text NOT NULL,
    "envConfig" text DEFAULT '{}'::text NOT NULL,
    "dockerEnabled" boolean DEFAULT false NOT NULL,
    "dockerNonRoot" boolean DEFAULT false NOT NULL,
    "dockerImage" text,
    "dockerVolumes" text DEFAULT '[]'::text NOT NULL,
    "firewallEnabled" boolean DEFAULT false NOT NULL,
    "firewallMode" text DEFAULT 'restrictive'::text NOT NULL,
    "firewallAllowRules" text DEFAULT '[]'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.rollout_targets (
    id text NOT NULL,
    "rolloutId" text NOT NULL,
    "nodeId" text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    "commandId" text,
    evidence text DEFAULT '{}'::text NOT NULL
);

CREATE TABLE public.security_export_outbox (
    id text NOT NULL,
    payload text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "deliveredAt" timestamp(3) without time zone,
    attempts integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastError" text
);

CREATE TABLE public.security_fusion_action_approvals (
    id text NOT NULL,
    "actionId" text NOT NULL,
    "previewSha256" text NOT NULL,
    "tokenHash" text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "requestedBy" text NOT NULL,
    "decidedBy" text,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "decidedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.security_fusion_actions (
    id text NOT NULL,
    "caseId" text NOT NULL,
    "nodeId" text NOT NULL,
    kind text NOT NULL,
    "serviceName" text,
    "isolationMinutes" integer,
    rationale text NOT NULL,
    "rollbackPlan" text NOT NULL,
    "previewJson" text NOT NULL,
    "previewSha256" text NOT NULL,
    status text DEFAULT 'previewed'::text NOT NULL,
    "requestedBy" text NOT NULL,
    "approvedBy" text,
    "approvalTokenHash" text,
    "approvalExpiresAt" timestamp(3) without time zone,
    "executedAt" timestamp(3) without time zone,
    "resultJson" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "verificationDeadline" timestamp(3) without time zone
);

CREATE TABLE public.security_fusion_case_activity (
    id text NOT NULL,
    "caseId" text NOT NULL,
    kind text NOT NULL,
    "actorId" text NOT NULL,
    "detailJson" text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.security_fusion_case_entities (
    id text NOT NULL,
    "caseId" text NOT NULL,
    "entityId" text NOT NULL
);

CREATE TABLE public.security_fusion_case_events (
    id text NOT NULL,
    "caseId" text NOT NULL,
    "eventId" text NOT NULL,
    "ruleId" text DEFAULT 'builtin-security-fusion'::text NOT NULL,
    "confidenceContribution" double precision DEFAULT 0 NOT NULL
);

CREATE TABLE public.security_fusion_case_relationships (
    id text NOT NULL,
    "fromCaseId" text NOT NULL,
    "toCaseId" text NOT NULL,
    kind text NOT NULL,
    confidence double precision NOT NULL,
    "rationaleJson" text DEFAULT '{}'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.security_fusion_cases (
    id text NOT NULL,
    fingerprint text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    severity text NOT NULL,
    confidence double precision NOT NULL,
    summary text NOT NULL,
    "recommendedInvestigationJson" text DEFAULT '[]'::text NOT NULL,
    "evidenceStepsJson" text DEFAULT '[]'::text NOT NULL,
    "assignedTo" text,
    "firstSeenAt" timestamp(3) without time zone NOT NULL,
    "lastSeenAt" timestamp(3) without time zone NOT NULL,
    "resolvedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "archivedAt" timestamp(3) without time zone,
    "evidenceAcceptedCount" integer DEFAULT 0 NOT NULL,
    "evidenceTruncatedCount" integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.security_fusion_collectors (
    id text NOT NULL,
    "displayName" text NOT NULL,
    "credentialFingerprint" text NOT NULL,
    "allowedSourcesJson" text DEFAULT '[]'::text NOT NULL,
    "schemaVersion" text DEFAULT '1.0'::text NOT NULL,
    "dataClassification" text DEFAULT 'restricted'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    "lastReceiptAt" timestamp(3) without time zone,
    "lastSuccessAt" timestamp(3) without time zone,
    "lastErrorAt" timestamp(3) without time zone,
    "lastError" text,
    "revokedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.security_fusion_command_outbox (
    id text NOT NULL,
    "actionId" text NOT NULL,
    operation text NOT NULL,
    "actorId" text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "remoteCommandId" text,
    attempts integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "leaseExpiresAt" timestamp(3) without time zone,
    "lastError" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "dispatchedAt" timestamp(3) without time zone
);

CREATE TABLE public.security_fusion_deletion_receipts (
    id text NOT NULL,
    "resourceType" text NOT NULL,
    "resourceIdHash" text NOT NULL,
    reason text NOT NULL,
    outcome text NOT NULL,
    "bytesDeleted" integer DEFAULT 0 NOT NULL,
    "detailJson" text DEFAULT '{}'::text NOT NULL,
    "receiptSha256" text NOT NULL,
    "deletedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "previousReceiptSha256" text,
    "chainSequence" integer NOT NULL,
    "chainVersion" integer DEFAULT 2 NOT NULL
);

CREATE TABLE public.security_fusion_deliveries (
    id text NOT NULL,
    "caseId" text NOT NULL,
    "revisionKey" text NOT NULL,
    channel text NOT NULL,
    status text NOT NULL,
    "externalId" text,
    error text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.security_fusion_entities (
    id text NOT NULL,
    type text NOT NULL,
    canonical text NOT NULL,
    label text NOT NULL,
    "aliasesJson" text DEFAULT '[]'::text NOT NULL,
    "firstSeenAt" timestamp(3) without time zone NOT NULL,
    "lastSeenAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.security_fusion_entity_aliases (
    id text NOT NULL,
    "entityId" text NOT NULL,
    source text NOT NULL,
    value text NOT NULL,
    canonical text NOT NULL,
    "firstSeenAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastSeenAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.security_fusion_event_entities (
    id text NOT NULL,
    "eventId" text NOT NULL,
    "entityId" text NOT NULL
);

CREATE TABLE public.security_fusion_events (
    id text NOT NULL,
    "eventId" text NOT NULL,
    source text NOT NULL,
    "sourceEventId" text NOT NULL,
    kind text NOT NULL,
    "observedAt" timestamp(3) without time zone NOT NULL,
    "ingestedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    severity text NOT NULL,
    confidence double precision NOT NULL,
    summary text NOT NULL,
    "attributesJson" text DEFAULT '{}'::text NOT NULL,
    "integritySha256" text NOT NULL,
    "collectorId" text NOT NULL
);

CREATE TABLE public.security_fusion_evidence (
    id text NOT NULL,
    "caseId" text NOT NULL,
    "eventId" text,
    "sourceLocator" text NOT NULL,
    "mediaType" text NOT NULL,
    sha256 text NOT NULL,
    "storagePath" text NOT NULL,
    "preservedBy" text NOT NULL,
    "preservedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "byteSize" integer DEFAULT 0 NOT NULL,
    "integrityStatus" text DEFAULT 'verified'::text NOT NULL,
    "quarantinedAt" timestamp(3) without time zone,
    "quarantineReason" text
);

CREATE TABLE public.security_fusion_investigations (
    id text NOT NULL,
    "caseId" text NOT NULL,
    revision integer NOT NULL,
    "authorId" text NOT NULL,
    "draftJson" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.security_fusion_nonces (
    nonce text NOT NULL,
    "collectorId" text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.security_fusion_receipt_chain_heads (
    id text NOT NULL,
    "headSha256" text,
    "chainSequence" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.security_fusion_rule_versions (
    id text NOT NULL,
    "ruleId" text NOT NULL,
    version integer NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "definitionJson" text NOT NULL,
    sha256 text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.security_fusion_source_state (
    id text NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    checkpoint text,
    "lastEventAt" timestamp(3) without time zone,
    "lastSuccessAt" timestamp(3) without time zone,
    "lastErrorAt" timestamp(3) without time zone,
    "lastError" text,
    "rejectedCount" integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "truncatedCount" integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.security_service_states (
    "nodeId" text NOT NULL,
    "serviceName" text NOT NULL,
    status text NOT NULL,
    "observationId" text NOT NULL,
    "observedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.shared_resource_fences (
    "resourceKey" text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT shared_resource_fences_generation_check CHECK ((generation > 0)),
    CONSTRAINT shared_resource_fences_key_check CHECK (("resourceKey" ~ '^(repo:[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*|provider:[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*|gpu:[a-z0-9][a-z0-9._-]*)$'::text))
);

CREATE TABLE public.shared_resource_lease_resources (
    "leaseId" text NOT NULL,
    "resourceKey" text NOT NULL,
    "fenceGeneration" bigint NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    CONSTRAINT shared_resource_lease_resources_generation_check CHECK (("fenceGeneration" > 0)),
    CONSTRAINT shared_resource_lease_resources_key_check CHECK (("resourceKey" ~ '^(repo:[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*|provider:[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)*|gpu:[a-z0-9][a-z0-9._-]*)$'::text)),
    CONSTRAINT shared_resource_lease_resources_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'running'::text, 'unknown'::text, 'released'::text])))
);

CREATE TABLE public.shared_resource_leases (
    id text NOT NULL,
    "missionRootId" text NOT NULL,
    "missionRevision" integer NOT NULL,
    "taskId" text NOT NULL,
    "operationId" text NOT NULL,
    "requestSha256" text NOT NULL,
    "actionClass" text NOT NULL,
    "ownerActor" text NOT NULL,
    "callerKind" text NOT NULL,
    "delegationId" text,
    "missionIssuer" text NOT NULL,
    "missionKeyId" text NOT NULL,
    "missionAssertionSha256" text NOT NULL,
    "missionAssertionJson" text NOT NULL,
    "resourceSetBinding" text NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    deadline timestamp(3) without time zone NOT NULL,
    "acquiredAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "startedAt" timestamp(3) without time zone,
    "settledAt" timestamp(3) without time zone,
    settlement text,
    "evidenceSha256" text,
    "settlementRecordSha256" text,
    "terminalEvidenceJson" text,
    "reconciliationDecisionId" text,
    "reconciliationJson" text,
    CONSTRAINT shared_resource_leases_caller_check CHECK (((("callerKind" = 'direct'::text) AND ("delegationId" IS NULL)) OR (("callerKind" = 'delegated'::text) AND ("delegationId" IS NOT NULL)))),
    CONSTRAINT shared_resource_leases_digest_check CHECK ((("requestSha256" ~ '^[a-f0-9]{64}$'::text) AND ("missionAssertionSha256" ~ '^[a-f0-9]{64}$'::text) AND (("evidenceSha256" IS NULL) OR ("evidenceSha256" ~ '^[a-f0-9]{64}$'::text)) AND (("settlementRecordSha256" IS NULL) OR ("settlementRecordSha256" ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT shared_resource_leases_mission_evidence_check CHECK ((((("missionAssertionJson")::jsonb ->> 'issuer'::text) = "missionIssuer") AND ((("missionAssertionJson")::jsonb ->> 'keyId'::text) = "missionKeyId") AND (COALESCE((("missionAssertionJson")::jsonb ->> 'signature'::text), ''::text) ~ '^[A-Za-z0-9+/]{80,128}={0,2}$'::text))),
    CONSTRAINT shared_resource_leases_revision_check CHECK (("missionRevision" > 0)),
    CONSTRAINT shared_resource_leases_settlement_check CHECK ((((state = 'released'::text) AND ("settledAt" IS NOT NULL) AND (settlement IS NOT NULL) AND ("evidenceSha256" IS NOT NULL) AND ("settlementRecordSha256" IS NOT NULL)) OR ((state <> 'released'::text) AND ("settledAt" IS NULL) AND (settlement IS NULL) AND ("evidenceSha256" IS NULL) AND ("settlementRecordSha256" IS NULL) AND ("terminalEvidenceJson" IS NULL) AND ("reconciliationDecisionId" IS NULL) AND ("reconciliationJson" IS NULL)))),
    CONSTRAINT shared_resource_leases_started_check CHECK ((((state = 'reserved'::text) AND ("startedAt" IS NULL)) OR ((state = ANY (ARRAY['running'::text, 'unknown'::text])) AND ("startedAt" IS NOT NULL) AND ("startedAt" >= "acquiredAt")) OR ((state = 'released'::text) AND (("startedAt" IS NULL) OR ("startedAt" >= "acquiredAt"))))),
    CONSTRAINT shared_resource_leases_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'running'::text, 'unknown'::text, 'released'::text])))
);

CREATE TABLE public.skill_installations (
    id text NOT NULL,
    "skillName" text NOT NULL,
    "nodeId" text NOT NULL,
    version text NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    "registryEntryId" text,
    "versionHash" text,
    "installedAt" timestamp(3) without time zone,
    error text,
    "bundleSha256" text,
    "treeSha256" text,
    "workflowCommandId" text,
    "workflowRequestSha256" text,
    "workflowReceiptSha256" text,
    CONSTRAINT "skill_installations_bundleSha256_format" CHECK ((("bundleSha256" IS NULL) OR ("bundleSha256" ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT skill_installations_installed_workflow_receipt CHECK ((("workflowCommandId" IS NULL) OR (status <> 'installed'::text) OR (("workflowRequestSha256" IS NOT NULL) AND ("workflowReceiptSha256" IS NOT NULL)))),
    CONSTRAINT "skill_installations_treeSha256_format" CHECK ((("treeSha256" IS NULL) OR ("treeSha256" ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT "skill_installations_workflowCommandId_format" CHECK ((("workflowCommandId" IS NULL) OR ("workflowCommandId" ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'::text))),
    CONSTRAINT "skill_installations_workflowReceiptSha256_format" CHECK ((("workflowReceiptSha256" IS NULL) OR ("workflowReceiptSha256" ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT "skill_installations_workflowRequestSha256_format" CHECK ((("workflowRequestSha256" IS NULL) OR ("workflowRequestSha256" ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT skill_installations_workflow_identity_complete CHECK ((("workflowCommandId" IS NULL) OR (("bundleSha256" IS NOT NULL) AND ("treeSha256" IS NOT NULL))))
);

CREATE TABLE public.skill_registry_entries (
    id text NOT NULL,
    slug text NOT NULL,
    "displayName" text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    source text DEFAULT 'local'::text NOT NULL,
    "sourceUrl" text,
    "entryPoint" text DEFAULT 'run.sh'::text NOT NULL,
    dependencies text DEFAULT '[]'::text NOT NULL,
    metadata text DEFAULT '{}'::text NOT NULL,
    "latestVersion" text,
    status text DEFAULT 'active'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.skill_tags (
    id text NOT NULL,
    "skillId" text NOT NULL,
    tag text NOT NULL,
    "versionId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.skill_versions (
    id text NOT NULL,
    "skillId" text NOT NULL,
    version text NOT NULL,
    changelog text DEFAULT ''::text NOT NULL,
    "contentHash" text NOT NULL,
    files text DEFAULT '[]'::text NOT NULL,
    "entryPoint" text DEFAULT 'run.sh'::text NOT NULL,
    "sizeBytes" integer DEFAULT 0 NOT NULL,
    "publishedBy" text DEFAULT 'system'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.team_approval_decisions (
    "decisionId" text NOT NULL,
    "proposalId" text NOT NULL,
    "proposalRevision" integer NOT NULL,
    "planSha256" text NOT NULL,
    decision text NOT NULL,
    "assertionSha256" text NOT NULL,
    "actorBindingSha256" text NOT NULL,
    "executionId" text,
    "decidedAt" timestamp(3) without time zone NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT team_approval_decision_kind CHECK ((decision = ANY (ARRAY['approve'::text, 'reject'::text]))),
    CONSTRAINT team_approval_execution_binding CHECK (((decision = 'approve'::text) = ("executionId" IS NOT NULL)))
);

CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    password text NOT NULL,
    role public."UserRole" DEFAULT 'VIEWER'::public."UserRole" NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "lastLoginAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.webhook_deliveries (
    id text NOT NULL,
    "endpointId" text NOT NULL,
    event text NOT NULL,
    payload text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "httpStatus" integer,
    response text,
    error text,
    attempts integer DEFAULT 0 NOT NULL,
    "deliveredAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.webhook_endpoints (
    id text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    type text DEFAULT 'generic'::text NOT NULL,
    secret text,
    events text DEFAULT '[]'::text NOT NULL,
    headers text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    retries integer DEFAULT 3 NOT NULL,
    "timeoutMs" integer DEFAULT 10000 NOT NULL,
    "createdBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

ALTER TABLE ONLY public.a2a_tasks
    ADD CONSTRAINT a2a_tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_dashboards
    ADD CONSTRAINT ai_dashboards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_memories
    ADD CONSTRAINT ai_memories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_scheduled_ops
    ADD CONSTRAINT ai_scheduled_ops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.alert_condition_states
    ADD CONSTRAINT alert_condition_states_pkey PRIMARY KEY ("ruleId", "nodeId");

ALTER TABLE ONLY public.alert_rules
    ADD CONSTRAINT alert_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.alert_violations
    ADD CONSTRAINT alert_violations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.anomaly_events
    ADD CONSTRAINT anomaly_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.application_observations
    ADD CONSTRAINT application_observations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ardent_installations
    ADD CONSTRAINT ardent_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ardent_profiles
    ADD CONSTRAINT ardent_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ardent_scope_enrollments
    ADD CONSTRAINT ardent_scope_enrollments_pkey PRIMARY KEY ("nodeId");

ALTER TABLE ONLY public.command_resource_fences
    ADD CONSTRAINT command_resource_fences_pkey PRIMARY KEY ("resourceKey");

ALTER TABLE ONLY public.command_resource_leases
    ADD CONSTRAINT command_resource_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.command_results
    ADD CONSTRAINT command_results_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.council_admission_fences
    ADD CONSTRAINT council_admission_fences_pkey PRIMARY KEY ("nodeId");

ALTER TABLE ONLY public.cron_job_executions
    ADD CONSTRAINT cron_job_executions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cron_jobs
    ADD CONSTRAINT cron_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deploy_jobs
    ADD CONSTRAINT deploy_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.drift_scans
    ADD CONSTRAINT drift_scans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.engineering_metric_samples
    ADD CONSTRAINT engineering_metric_samples_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.engineering_recovery_exercises
    ADD CONSTRAINT engineering_recovery_exercises_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.execution_runs
    ADD CONSTRAINT execution_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.file_patch_tasks
    ADD CONSTRAINT file_patch_tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gpu_snapshots
    ADD CONSTRAINT gpu_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.health_snapshots
    ADD CONSTRAINT health_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_core_rollout_hosts
    ADD CONSTRAINT hermes_core_rollout_hosts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_core_rollouts
    ADD CONSTRAINT hermes_core_rollouts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_credential_pool_attachments
    ADD CONSTRAINT hermes_credential_pool_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_credential_pools
    ADD CONSTRAINT hermes_credential_pools_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_cron_jobs
    ADD CONSTRAINT hermes_cron_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_hooks
    ADD CONSTRAINT hermes_hooks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_installations
    ADD CONSTRAINT hermes_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_mcp_server_attachments
    ADD CONSTRAINT hermes_mcp_server_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_mcp_servers
    ADD CONSTRAINT hermes_mcp_servers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_messaging_bindings
    ADD CONSTRAINT hermes_messaging_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_operation_jobs
    ADD CONSTRAINT hermes_operation_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_plugin_installs
    ADD CONSTRAINT hermes_plugin_installs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_profiles
    ADD CONSTRAINT hermes_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_provider_configs
    ADD CONSTRAINT hermes_provider_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_registry_clients
    ADD CONSTRAINT hermes_registry_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_registry_inventory
    ADD CONSTRAINT hermes_registry_inventory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_registry_receipts
    ADD CONSTRAINT hermes_registry_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_registry_revisions
    ADD CONSTRAINT hermes_registry_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_registry_targets
    ADD CONSTRAINT hermes_registry_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_role_applications
    ADD CONSTRAINT hermes_role_applications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_roles
    ADD CONSTRAINT hermes_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_skill_assignments
    ADD CONSTRAINT hermes_skill_assignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hermes_toolset_policies
    ADD CONSTRAINT hermes_toolset_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.incident_lessons
    ADD CONSTRAINT incident_lessons_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.library_categories
    ADD CONSTRAINT library_categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.library_files
    ADD CONSTRAINT library_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.log_entries
    ADD CONSTRAINT log_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.magnus_release_canaries
    ADD CONSTRAINT magnus_release_canaries_pkey PRIMARY KEY ("tokenSha256");

ALTER TABLE ONLY public.maintenance_windows
    ADD CONSTRAINT maintenance_windows_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.managed_cron_definitions
    ADD CONSTRAINT managed_cron_definitions_pkey PRIMARY KEY ("cronJobId");

ALTER TABLE ONLY public.managed_cron_occurrences
    ADD CONSTRAINT managed_cron_occurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.remediation_executions
    ADD CONSTRAINT remediation_executions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.remediation_rules
    ADD CONSTRAINT remediation_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.remote_commands
    ADD CONSTRAINT remote_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.resource_drain_participants
    ADD CONSTRAINT resource_drain_participants_pkey PRIMARY KEY ("nodeId", participant);

ALTER TABLE ONLY public.resource_enrollments
    ADD CONSTRAINT resource_enrollments_pkey PRIMARY KEY ("nodeId");

ALTER TABLE ONLY public.resource_participant_work
    ADD CONSTRAINT resource_participant_work_pkey PRIMARY KEY ("workId");

ALTER TABLE ONLY public.role_applications
    ADD CONSTRAINT role_applications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rollout_targets
    ADD CONSTRAINT rollout_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_export_outbox
    ADD CONSTRAINT security_export_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_action_approvals
    ADD CONSTRAINT security_fusion_action_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_actions
    ADD CONSTRAINT security_fusion_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_case_activity
    ADD CONSTRAINT security_fusion_case_activity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_case_entities
    ADD CONSTRAINT security_fusion_case_entities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_case_events
    ADD CONSTRAINT security_fusion_case_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_case_relationships
    ADD CONSTRAINT security_fusion_case_relationships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_cases
    ADD CONSTRAINT security_fusion_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_collectors
    ADD CONSTRAINT security_fusion_collectors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_command_outbox
    ADD CONSTRAINT security_fusion_command_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_deletion_receipts
    ADD CONSTRAINT security_fusion_deletion_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_deliveries
    ADD CONSTRAINT security_fusion_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_entities
    ADD CONSTRAINT security_fusion_entities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_entity_aliases
    ADD CONSTRAINT security_fusion_entity_aliases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_event_entities
    ADD CONSTRAINT security_fusion_event_entities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_events
    ADD CONSTRAINT security_fusion_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_evidence
    ADD CONSTRAINT security_fusion_evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_investigations
    ADD CONSTRAINT security_fusion_investigations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_nonces
    ADD CONSTRAINT security_fusion_nonces_pkey PRIMARY KEY (nonce);

ALTER TABLE ONLY public.security_fusion_receipt_chain_heads
    ADD CONSTRAINT security_fusion_receipt_chain_heads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_rule_versions
    ADD CONSTRAINT security_fusion_rule_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_fusion_source_state
    ADD CONSTRAINT security_fusion_source_state_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_service_states
    ADD CONSTRAINT security_service_states_pkey PRIMARY KEY ("nodeId", "serviceName");

ALTER TABLE ONLY public.shared_resource_fences
    ADD CONSTRAINT shared_resource_fences_pkey PRIMARY KEY ("resourceKey");

ALTER TABLE ONLY public.shared_resource_lease_resources
    ADD CONSTRAINT shared_resource_lease_resources_pkey PRIMARY KEY ("leaseId", "resourceKey");

ALTER TABLE ONLY public.shared_resource_leases
    ADD CONSTRAINT shared_resource_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_installations
    ADD CONSTRAINT skill_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_registry_entries
    ADD CONSTRAINT skill_registry_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_tags
    ADD CONSTRAINT skill_tags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.team_approval_decisions
    ADD CONSTRAINT team_approval_decisions_pkey PRIMARY KEY ("decisionId");

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);

CREATE INDEX "a2a_tasks_fromAgent_idx" ON public.a2a_tasks USING btree ("fromAgent");

CREATE INDEX a2a_tasks_status_idx ON public.a2a_tasks USING btree (status);

CREATE INDEX "a2a_tasks_toAgent_idx" ON public.a2a_tasks USING btree ("toAgent");

CREATE UNIQUE INDEX "agents_nodeId_key" ON public.agents USING btree ("nodeId");

CREATE INDEX "ai_conversations_forkedFromMessageId_idx" ON public.ai_conversations USING btree ("forkedFromMessageId");

CREATE INDEX "ai_conversations_nodeId_idx" ON public.ai_conversations USING btree ("nodeId");

CREATE INDEX "ai_conversations_parentId_updatedAt_idx" ON public.ai_conversations USING btree ("parentId", "updatedAt");

CREATE INDEX "ai_conversations_status_createdAt_idx" ON public.ai_conversations USING btree (status, "createdAt");

CREATE INDEX "ai_conversations_type_createdAt_idx" ON public.ai_conversations USING btree (type, "createdAt");

CREATE INDEX "ai_dashboards_createdBy_idx" ON public.ai_dashboards USING btree ("createdBy");

CREATE INDEX ai_memories_category_idx ON public.ai_memories USING btree (category);

CREATE UNIQUE INDEX ai_memories_key_key ON public.ai_memories USING btree (key);

CREATE INDEX ai_memories_relevance_idx ON public.ai_memories USING btree (relevance);

CREATE INDEX "ai_messages_conversationId_createdAt_idx" ON public.ai_messages USING btree ("conversationId", "createdAt");

CREATE INDEX "ai_messages_role_isRead_idx" ON public.ai_messages USING btree (role, "isRead");

CREATE INDEX "ai_scheduled_ops_enabled_nextRunAt_idx" ON public.ai_scheduled_ops USING btree (enabled, "nextRunAt");

CREATE INDEX "alert_condition_states_nodeId_idx" ON public.alert_condition_states USING btree ("nodeId");

CREATE INDEX alert_rules_active_idx ON public.alert_rules USING btree (active);

CREATE INDEX alert_rules_metric_idx ON public.alert_rules USING btree (metric);

CREATE INDEX "alert_violations_nodeId_status_idx" ON public.alert_violations USING btree ("nodeId", status);

CREATE INDEX "alert_violations_ruleId_status_idx" ON public.alert_violations USING btree ("ruleId", status);

CREATE INDEX "alert_violations_status_createdAt_idx" ON public.alert_violations USING btree (status, "createdAt");

CREATE INDEX "anomaly_events_healthSnapshotId_idx" ON public.anomaly_events USING btree ("healthSnapshotId");

CREATE INDEX "anomaly_events_metric_createdAt_idx" ON public.anomaly_events USING btree (metric, "createdAt");

CREATE INDEX "anomaly_events_nodeId_createdAt_idx" ON public.anomaly_events USING btree ("nodeId", "createdAt");

CREATE INDEX "anomaly_events_nodeId_metric_resolved_idx" ON public.anomaly_events USING btree ("nodeId", metric, resolved);

CREATE INDEX "anomaly_events_resolved_createdAt_idx" ON public.anomaly_events USING btree (resolved, "createdAt");

CREATE INDEX "application_observations_nodeId_idx" ON public.application_observations USING btree ("nodeId");

CREATE UNIQUE INDEX "ardent_installations_nodeId_key" ON public.ardent_installations USING btree ("nodeId");

CREATE INDEX "ardent_installations_reachable_checkedAt_idx" ON public.ardent_installations USING btree (reachable, "checkedAt");

CREATE UNIQUE INDEX "ardent_profiles_installationId_name_key" ON public.ardent_profiles USING btree ("installationId", name);

CREATE INDEX "ardent_profiles_running_observedAt_idx" ON public.ardent_profiles USING btree (running, "observedAt");

CREATE UNIQUE INDEX "ardent_scope_enrollments_decisionId_key" ON public.ardent_scope_enrollments USING btree ("decisionId");

CREATE UNIQUE INDEX command_resource_leases_active_resource ON public.command_resource_leases USING btree ("resourceKey") WHERE (state = ANY (ARRAY['reserved'::text, 'running'::text, 'unknown'::text]));

CREATE UNIQUE INDEX "command_resource_leases_commandId_key" ON public.command_resource_leases USING btree ("commandId");

CREATE INDEX "command_resource_leases_nodeId_state_idx" ON public.command_resource_leases USING btree ("nodeId", state);

CREATE INDEX "command_resource_leases_resourceKey_state_idx" ON public.command_resource_leases USING btree ("resourceKey", state);

CREATE UNIQUE INDEX "command_results_commandId_key" ON public.command_results USING btree ("commandId");

CREATE INDEX "cron_job_executions_cronJobId_startedAt_idx" ON public.cron_job_executions USING btree ("cronJobId", "startedAt");

CREATE UNIQUE INDEX "cron_jobs_nodeId_name_key" ON public.cron_jobs USING btree ("nodeId", name);

CREATE INDEX "deploy_jobs_createdBy_idx" ON public.deploy_jobs USING btree ("createdBy");

CREATE INDEX deploy_jobs_status_idx ON public.deploy_jobs USING btree (status);

CREATE INDEX "drift_scans_nodeId_idx" ON public.drift_scans USING btree ("nodeId");

CREATE INDEX drift_scans_status_idx ON public.drift_scans USING btree (status);

CREATE INDEX "engineering_metric_samples_applicationId_metric_observedAt_idx" ON public.engineering_metric_samples USING btree ("applicationId", metric, "observedAt");

CREATE UNIQUE INDEX "engineering_metric_samples_applicationId_metric_sourceKey_o_key" ON public.engineering_metric_samples USING btree ("applicationId", metric, "sourceKey", "observedAt");

CREATE INDEX "engineering_metric_samples_nodeId_metric_observedAt_idx" ON public.engineering_metric_samples USING btree ("nodeId", metric, "observedAt");

CREATE UNIQUE INDEX "engineering_recovery_exercises_runnerNonce_key" ON public.engineering_recovery_exercises USING btree ("runnerNonce");

CREATE UNIQUE INDEX "engineering_recovery_exercises_runnerReceiptSha256_key" ON public.engineering_recovery_exercises USING btree ("runnerReceiptSha256");

CREATE INDEX "engineering_recovery_exercises_scenario_createdAt_idx" ON public.engineering_recovery_exercises USING btree (scenario, "createdAt");

CREATE INDEX "engineering_recovery_exercises_targetId_createdAt_idx" ON public.engineering_recovery_exercises USING btree ("targetId", "createdAt");

CREATE INDEX execution_runs_status_idx ON public.execution_runs USING btree (status);

CREATE INDEX "file_patch_tasks_nodeId_status_idx" ON public.file_patch_tasks USING btree ("nodeId", status);

CREATE INDEX "gpu_snapshots_nodeId_sampledAt_idx" ON public.gpu_snapshots USING btree ("nodeId", "sampledAt");

CREATE UNIQUE INDEX "gpu_snapshots_nodeId_sampledAt_key" ON public.gpu_snapshots USING btree ("nodeId", "sampledAt");

CREATE INDEX "health_snapshots_nodeId_timestamp_idx" ON public.health_snapshots USING btree ("nodeId", "timestamp");

CREATE UNIQUE INDEX "hermes_core_rollout_hosts_rolloutId_hostname_key" ON public.hermes_core_rollout_hosts USING btree ("rolloutId", hostname);

CREATE INDEX "hermes_core_rollout_hosts_rolloutId_stage_status_idx" ON public.hermes_core_rollout_hosts USING btree ("rolloutId", stage, status);

CREATE INDEX "hermes_core_rollouts_status_createdAt_idx" ON public.hermes_core_rollouts USING btree (status, "createdAt");

CREATE INDEX "hermes_credential_pool_attachments_installationId_idx" ON public.hermes_credential_pool_attachments USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_credential_pool_attachments_poolId_installationId_pr_key" ON public.hermes_credential_pool_attachments USING btree ("poolId", "installationId", "profileId");

CREATE UNIQUE INDEX hermes_credential_pools_name_key ON public.hermes_credential_pools USING btree (name);

CREATE INDEX "hermes_cron_jobs_installationId_idx" ON public.hermes_cron_jobs USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_cron_jobs_installationId_profileId_name_key" ON public.hermes_cron_jobs USING btree ("installationId", "profileId", name);

CREATE INDEX hermes_hooks_event_idx ON public.hermes_hooks USING btree (event);

CREATE INDEX "hermes_hooks_installationId_idx" ON public.hermes_hooks USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_installations_hostname_hermesHome_key" ON public.hermes_installations USING btree (hostname, "hermesHome");

CREATE INDEX hermes_installations_hostname_idx ON public.hermes_installations USING btree (hostname);

CREATE INDEX "hermes_installations_nodeId_idx" ON public.hermes_installations USING btree ("nodeId");

CREATE INDEX hermes_installations_status_idx ON public.hermes_installations USING btree (status);

CREATE INDEX "hermes_mcp_server_attachments_installationId_idx" ON public.hermes_mcp_server_attachments USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_mcp_server_attachments_serverId_installationId_profi_key" ON public.hermes_mcp_server_attachments USING btree ("serverId", "installationId", "profileId");

CREATE UNIQUE INDEX hermes_mcp_servers_name_key ON public.hermes_mcp_servers USING btree (name);

CREATE INDEX "hermes_messaging_bindings_installationId_idx" ON public.hermes_messaging_bindings USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_messaging_bindings_installationId_profileId_platform_key" ON public.hermes_messaging_bindings USING btree ("installationId", "profileId", platform);

CREATE INDEX "hermes_operation_jobs_createdBy_idx" ON public.hermes_operation_jobs USING btree ("createdBy");

CREATE INDEX "hermes_operation_jobs_installationId_idx" ON public.hermes_operation_jobs USING btree ("installationId");

CREATE INDEX "hermes_operation_jobs_profileId_idx" ON public.hermes_operation_jobs USING btree ("profileId");

CREATE INDEX "hermes_operation_jobs_startedAt_idx" ON public.hermes_operation_jobs USING btree ("startedAt");

CREATE INDEX hermes_operation_jobs_status_idx ON public.hermes_operation_jobs USING btree (status);

CREATE INDEX hermes_operation_jobs_type_idx ON public.hermes_operation_jobs USING btree (type);

CREATE INDEX "hermes_plugin_installs_installationId_idx" ON public.hermes_plugin_installs USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_plugin_installs_installationId_profileId_pluginSlug_key" ON public.hermes_plugin_installs USING btree ("installationId", "profileId", "pluginSlug");

CREATE INDEX "hermes_plugin_installs_pluginType_idx" ON public.hermes_plugin_installs USING btree ("pluginType");

CREATE INDEX "hermes_profiles_gatewayStatus_idx" ON public.hermes_profiles USING btree ("gatewayStatus");

CREATE INDEX "hermes_profiles_installationId_idx" ON public.hermes_profiles USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_profiles_installationId_name_key" ON public.hermes_profiles USING btree ("installationId", name);

CREATE INDEX "hermes_provider_configs_installationId_idx" ON public.hermes_provider_configs USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_provider_configs_installationId_profileId_key" ON public.hermes_provider_configs USING btree ("installationId", "profileId");

CREATE INDEX "hermes_registry_clients_installationId_idx" ON public.hermes_registry_clients USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_registry_clients_nodeId_installationId_key" ON public.hermes_registry_clients USING btree ("nodeId", "installationId");

CREATE UNIQUE INDEX "hermes_registry_clients_tokenSha256_key" ON public.hermes_registry_clients USING btree ("tokenSha256");

CREATE UNIQUE INDEX "hermes_registry_inventory_installationId_profileId_kind_slu_key" ON public.hermes_registry_inventory USING btree ("installationId", "profileId", kind, slug);

CREATE INDEX "hermes_registry_inventory_sourceKind_status_idx" ON public.hermes_registry_inventory USING btree ("sourceKind", status);

CREATE INDEX "hermes_registry_receipts_installationId_kind_slug_createdAt_idx" ON public.hermes_registry_receipts USING btree ("installationId", kind, slug, "createdAt");

CREATE UNIQUE INDEX hermes_registry_revisions_kind_slug_revision_key ON public.hermes_registry_revisions USING btree (kind, slug, revision);

CREATE INDEX hermes_registry_revisions_kind_slug_status_idx ON public.hermes_registry_revisions USING btree (kind, slug, status);

CREATE INDEX "hermes_registry_targets_installationId_enabled_idx" ON public.hermes_registry_targets USING btree ("installationId", enabled);

CREATE UNIQUE INDEX "hermes_registry_targets_kind_slug_installationId_profileId_key" ON public.hermes_registry_targets USING btree (kind, slug, "installationId", "profileId");

CREATE INDEX "hermes_role_applications_installationId_idx" ON public.hermes_role_applications USING btree ("installationId");

CREATE INDEX "hermes_role_applications_profileId_idx" ON public.hermes_role_applications USING btree ("profileId");

CREATE UNIQUE INDEX "hermes_role_applications_roleId_installationId_profileId_key" ON public.hermes_role_applications USING btree ("roleId", "installationId", "profileId");

CREATE UNIQUE INDEX hermes_roles_name_key ON public.hermes_roles USING btree (name);

CREATE INDEX "hermes_skill_assignments_installationId_idx" ON public.hermes_skill_assignments USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_skill_assignments_installationId_profileId_skillSlug_key" ON public.hermes_skill_assignments USING btree ("installationId", "profileId", "skillSlug");

CREATE INDEX "hermes_skill_assignments_profileId_idx" ON public.hermes_skill_assignments USING btree ("profileId");

CREATE INDEX hermes_skill_assignments_status_idx ON public.hermes_skill_assignments USING btree (status);

CREATE INDEX "hermes_toolset_policies_installationId_idx" ON public.hermes_toolset_policies USING btree ("installationId");

CREATE UNIQUE INDEX "hermes_toolset_policies_installationId_profileId_toolset_key" ON public.hermes_toolset_policies USING btree ("installationId", "profileId", toolset);

CREATE INDEX "hermes_toolset_policies_profileId_idx" ON public.hermes_toolset_policies USING btree ("profileId");

CREATE INDEX "incident_lessons_incidentId_expiresAt_idx" ON public.incident_lessons USING btree ("incidentId", "expiresAt");

CREATE UNIQUE INDEX library_categories_name_key ON public.library_categories USING btree (name);

CREATE INDEX "library_files_categoryId_idx" ON public.library_files USING btree ("categoryId");

CREATE INDEX library_files_name_idx ON public.library_files USING btree (name);

CREATE INDEX log_entries_level_idx ON public.log_entries USING btree (level);

CREATE INDEX "log_entries_nodeId_timestamp_idx" ON public.log_entries USING btree ("nodeId", "timestamp");

CREATE INDEX log_entries_source_idx ON public.log_entries USING btree (source);

CREATE INDEX magnus_release_canaries_epoch_idx ON public.magnus_release_canaries USING btree (epoch);

CREATE INDEX "maintenance_windows_startsAt_endsAt_idx" ON public.maintenance_windows USING btree ("startsAt", "endsAt");

CREATE UNIQUE INDEX "managed_cron_definitions_nodeId_jobId_key" ON public.managed_cron_definitions USING btree ("nodeId", "jobId");

CREATE UNIQUE INDEX "managed_cron_occurrences_commandId_key" ON public.managed_cron_occurrences USING btree ("commandId");

CREATE INDEX "managed_cron_occurrences_nodeId_state_idx" ON public.managed_cron_occurrences USING btree ("nodeId", state);

CREATE INDEX "nodes_ipAddress_idx" ON public.nodes USING btree ("ipAddress");

CREATE INDEX "nodes_lastHeartbeatAt_idx" ON public.nodes USING btree ("lastHeartbeatAt");

CREATE UNIQUE INDEX nodes_name_key ON public.nodes USING btree (name);

CREATE INDEX "nodes_roleId_idx" ON public.nodes USING btree ("roleId");

CREATE INDEX nodes_status_idx ON public.nodes USING btree (status);

CREATE UNIQUE INDEX nodes_token_key ON public.nodes USING btree (token);

CREATE UNIQUE INDEX "notification_preferences_userId_channel_category_key" ON public.notification_preferences USING btree ("userId", channel, category);

CREATE INDEX "notification_preferences_userId_idx" ON public.notification_preferences USING btree ("userId");

CREATE INDEX "notifications_isRead_createdAt_idx" ON public.notifications USING btree ("isRead", "createdAt");

CREATE INDEX "notifications_nodeId_createdAt_idx" ON public.notifications USING btree ("nodeId", "createdAt");

CREATE INDEX "notifications_type_createdAt_idx" ON public.notifications USING btree (type, "createdAt");

CREATE INDEX "notifications_type_nodeId_sourceRef_createdAt_idx" ON public.notifications USING btree (type, "nodeId", "sourceRef", "createdAt");

CREATE INDEX "remediation_executions_nodeId_triggeredAt_idx" ON public.remediation_executions USING btree ("nodeId", "triggeredAt");

CREATE INDEX "remediation_executions_ruleId_triggeredAt_idx" ON public.remediation_executions USING btree ("ruleId", "triggeredAt");

CREATE INDEX remediation_executions_status_idx ON public.remediation_executions USING btree (status);

CREATE INDEX remediation_rules_enabled_metric_idx ON public.remediation_rules USING btree (enabled, metric);

CREATE UNIQUE INDEX remediation_rules_name_key ON public.remediation_rules USING btree (name);

CREATE INDEX "remote_commands_correlationId_idx" ON public.remote_commands USING btree ("correlationId");

CREATE INDEX "remote_commands_idempotencyKey_idx" ON public.remote_commands USING btree ("idempotencyKey");

CREATE UNIQUE INDEX "remote_commands_idempotencyKey_key" ON public.remote_commands USING btree ("idempotencyKey");

CREATE INDEX "remote_commands_nodeId_status_idx" ON public.remote_commands USING btree ("nodeId", status);

CREATE INDEX "resource_participant_work_nodeId_participant_state_idx" ON public.resource_participant_work USING btree ("nodeId", participant, state);

CREATE UNIQUE INDEX "resource_participant_work_nodeSessionReceiptSha256_key" ON public.resource_participant_work USING btree ("nodeSessionReceiptSha256");

CREATE UNIQUE INDEX "resource_participant_work_reconciliationDecisionId_key" ON public.resource_participant_work USING btree ("reconciliationDecisionId");

CREATE INDEX "role_applications_nodeId_idx" ON public.role_applications USING btree ("nodeId");

CREATE INDEX "role_applications_roleId_idx" ON public.role_applications USING btree ("roleId");

CREATE INDEX role_applications_status_idx ON public.role_applications USING btree (status);

CREATE UNIQUE INDEX roles_name_key ON public.roles USING btree (name);

CREATE UNIQUE INDEX "rollout_targets_commandId_key" ON public.rollout_targets USING btree ("commandId");

CREATE UNIQUE INDEX "rollout_targets_rolloutId_nodeId_key" ON public.rollout_targets USING btree ("rolloutId", "nodeId");

CREATE INDEX "security_export_outbox_deliveredAt_nextAttemptAt_idx" ON public.security_export_outbox USING btree ("deliveredAt", "nextAttemptAt");

CREATE UNIQUE INDEX "security_fusion_action_approvals_actionId_key" ON public.security_fusion_action_approvals USING btree ("actionId");

CREATE INDEX "security_fusion_action_approvals_expiresAt_idx" ON public.security_fusion_action_approvals USING btree ("expiresAt");

CREATE INDEX "security_fusion_actions_caseId_createdAt_idx" ON public.security_fusion_actions USING btree ("caseId", "createdAt");

CREATE INDEX "security_fusion_actions_status_approvalExpiresAt_idx" ON public.security_fusion_actions USING btree (status, "approvalExpiresAt");

CREATE INDEX "security_fusion_case_activity_caseId_createdAt_idx" ON public.security_fusion_case_activity USING btree ("caseId", "createdAt");

CREATE UNIQUE INDEX "security_fusion_case_entities_caseId_entityId_key" ON public.security_fusion_case_entities USING btree ("caseId", "entityId");

CREATE INDEX "security_fusion_case_entities_entityId_idx" ON public.security_fusion_case_entities USING btree ("entityId");

CREATE UNIQUE INDEX "security_fusion_case_events_caseId_eventId_key" ON public.security_fusion_case_events USING btree ("caseId", "eventId");

CREATE INDEX "security_fusion_case_events_eventId_idx" ON public.security_fusion_case_events USING btree ("eventId");

CREATE UNIQUE INDEX "security_fusion_case_relationships_fromCaseId_toCaseId_kind_key" ON public.security_fusion_case_relationships USING btree ("fromCaseId", "toCaseId", kind);

CREATE INDEX "security_fusion_case_relationships_toCaseId_idx" ON public.security_fusion_case_relationships USING btree ("toCaseId");

CREATE INDEX "security_fusion_cases_archivedAt_lastSeenAt_idx" ON public.security_fusion_cases USING btree ("archivedAt", "lastSeenAt");

CREATE UNIQUE INDEX security_fusion_cases_fingerprint_key ON public.security_fusion_cases USING btree (fingerprint);

CREATE INDEX "security_fusion_cases_status_severity_lastSeenAt_idx" ON public.security_fusion_cases USING btree (status, severity, "lastSeenAt");

CREATE INDEX "security_fusion_collectors_status_lastReceiptAt_idx" ON public.security_fusion_collectors USING btree (status, "lastReceiptAt");

CREATE UNIQUE INDEX "security_fusion_command_outbox_actionId_operation_key" ON public.security_fusion_command_outbox USING btree ("actionId", operation);

CREATE UNIQUE INDEX "security_fusion_command_outbox_remoteCommandId_key" ON public.security_fusion_command_outbox USING btree ("remoteCommandId");

CREATE INDEX "security_fusion_command_outbox_status_nextAttemptAt_idx" ON public.security_fusion_command_outbox USING btree (status, "nextAttemptAt");

CREATE UNIQUE INDEX "security_fusion_deletion_receipts_chainSequence_key" ON public.security_fusion_deletion_receipts USING btree ("chainSequence");

CREATE INDEX "security_fusion_deletion_receipts_deletedAt_idx" ON public.security_fusion_deletion_receipts USING btree ("deletedAt");

CREATE UNIQUE INDEX "security_fusion_deletion_receipts_receiptSha256_key" ON public.security_fusion_deletion_receipts USING btree ("receiptSha256");

CREATE INDEX "security_fusion_deletion_receipts_resourceType_deletedAt_idx" ON public.security_fusion_deletion_receipts USING btree ("resourceType", "deletedAt");

CREATE INDEX "security_fusion_deliveries_caseId_createdAt_idx" ON public.security_fusion_deliveries USING btree ("caseId", "createdAt");

CREATE UNIQUE INDEX "security_fusion_deliveries_revisionKey_key" ON public.security_fusion_deliveries USING btree ("revisionKey");

CREATE INDEX "security_fusion_entities_lastSeenAt_idx" ON public.security_fusion_entities USING btree ("lastSeenAt");

CREATE UNIQUE INDEX security_fusion_entities_type_canonical_key ON public.security_fusion_entities USING btree (type, canonical);

CREATE INDEX "security_fusion_entity_aliases_entityId_idx" ON public.security_fusion_entity_aliases USING btree ("entityId");

CREATE UNIQUE INDEX security_fusion_entity_aliases_source_canonical_key ON public.security_fusion_entity_aliases USING btree (source, canonical);

CREATE INDEX "security_fusion_event_entities_entityId_idx" ON public.security_fusion_event_entities USING btree ("entityId");

CREATE UNIQUE INDEX "security_fusion_event_entities_eventId_entityId_key" ON public.security_fusion_event_entities USING btree ("eventId", "entityId");

CREATE UNIQUE INDEX "security_fusion_events_eventId_key" ON public.security_fusion_events USING btree ("eventId");

CREATE INDEX "security_fusion_events_kind_observedAt_idx" ON public.security_fusion_events USING btree (kind, "observedAt");

CREATE INDEX "security_fusion_events_observedAt_idx" ON public.security_fusion_events USING btree ("observedAt");

CREATE INDEX "security_fusion_events_severity_observedAt_idx" ON public.security_fusion_events USING btree (severity, "observedAt");

CREATE INDEX "security_fusion_events_source_observedAt_idx" ON public.security_fusion_events USING btree (source, "observedAt");

CREATE UNIQUE INDEX "security_fusion_events_source_sourceEventId_key" ON public.security_fusion_events USING btree (source, "sourceEventId");

CREATE INDEX "security_fusion_evidence_caseId_preservedAt_idx" ON public.security_fusion_evidence USING btree ("caseId", "preservedAt");

CREATE INDEX security_fusion_evidence_sha256_idx ON public.security_fusion_evidence USING btree (sha256);

CREATE INDEX "security_fusion_investigations_caseId_createdAt_idx" ON public.security_fusion_investigations USING btree ("caseId", "createdAt");

CREATE UNIQUE INDEX "security_fusion_investigations_caseId_revision_key" ON public.security_fusion_investigations USING btree ("caseId", revision);

CREATE INDEX "security_fusion_nonces_expiresAt_idx" ON public.security_fusion_nonces USING btree ("expiresAt");

CREATE INDEX security_fusion_rule_versions_enabled_idx ON public.security_fusion_rule_versions USING btree (enabled);

CREATE UNIQUE INDEX "security_fusion_rule_versions_ruleId_version_key" ON public.security_fusion_rule_versions USING btree ("ruleId", version);

CREATE UNIQUE INDEX security_fusion_source_state_source_key ON public.security_fusion_source_state USING btree (source);

CREATE UNIQUE INDEX shared_resource_lease_resources_active_resource ON public.shared_resource_lease_resources USING btree ("resourceKey") WHERE (state = ANY (ARRAY['reserved'::text, 'running'::text, 'unknown'::text]));

CREATE UNIQUE INDEX "shared_resource_lease_resources_resourceKey_fenceGeneration_key" ON public.shared_resource_lease_resources USING btree ("resourceKey", "fenceGeneration");

CREATE INDEX "shared_resource_lease_resources_resourceKey_state_idx" ON public.shared_resource_lease_resources USING btree ("resourceKey", state);

CREATE INDEX "shared_resource_leases_missionRootId_missionRevision_idx" ON public.shared_resource_leases USING btree ("missionRootId", "missionRevision");

CREATE UNIQUE INDEX "shared_resource_leases_operationId_key" ON public.shared_resource_leases USING btree ("operationId");

CREATE UNIQUE INDEX "shared_resource_leases_reconciliationDecisionId_key" ON public.shared_resource_leases USING btree ("reconciliationDecisionId");

CREATE UNIQUE INDEX "shared_resource_leases_settlementRecordSha256_key" ON public.shared_resource_leases USING btree ("settlementRecordSha256");

CREATE INDEX "shared_resource_leases_taskId_state_idx" ON public.shared_resource_leases USING btree ("taskId", state);

CREATE INDEX "skill_installations_registryEntryId_idx" ON public.skill_installations USING btree ("registryEntryId");

CREATE UNIQUE INDEX "skill_installations_skillName_nodeId_key" ON public.skill_installations USING btree ("skillName", "nodeId");

CREATE UNIQUE INDEX "skill_installations_workflowCommandId_key" ON public.skill_installations USING btree ("workflowCommandId");

CREATE UNIQUE INDEX "skill_installations_workflowReceiptSha256_key" ON public.skill_installations USING btree ("workflowReceiptSha256");

CREATE UNIQUE INDEX skill_registry_entries_slug_key ON public.skill_registry_entries USING btree (slug);

CREATE INDEX skill_registry_entries_source_idx ON public.skill_registry_entries USING btree (source);

CREATE INDEX skill_registry_entries_status_idx ON public.skill_registry_entries USING btree (status);

CREATE UNIQUE INDEX "skill_tags_skillId_tag_key" ON public.skill_tags USING btree ("skillId", tag);

CREATE INDEX "skill_versions_skillId_createdAt_idx" ON public.skill_versions USING btree ("skillId", "createdAt");

CREATE UNIQUE INDEX "skill_versions_skillId_version_key" ON public.skill_versions USING btree ("skillId", version);

CREATE UNIQUE INDEX "team_approval_decisions_executionId_key" ON public.team_approval_decisions USING btree ("executionId");

CREATE UNIQUE INDEX "team_approval_decisions_proposalId_key" ON public.team_approval_decisions USING btree ("proposalId");

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);

CREATE INDEX "webhook_deliveries_endpointId_createdAt_idx" ON public.webhook_deliveries USING btree ("endpointId", "createdAt");

CREATE INDEX webhook_deliveries_status_idx ON public.webhook_deliveries USING btree (status);

CREATE INDEX webhook_endpoints_active_idx ON public.webhook_endpoints USING btree (active);

CREATE TRIGGER command_resource_leases_authority_immutable BEFORE UPDATE ON public.command_resource_leases FOR EACH ROW EXECUTE FUNCTION public.magnus_reject_command_resource_authority_update();

CREATE TRIGGER engineering_recovery_exercises_no_truncate BEFORE TRUNCATE ON public.engineering_recovery_exercises FOR EACH STATEMENT EXECUTE FUNCTION public.magnus_reject_recovery_exercise_update();

CREATE TRIGGER engineering_recovery_exercises_no_update BEFORE UPDATE ON public.engineering_recovery_exercises FOR EACH ROW EXECUTE FUNCTION public.magnus_reject_recovery_exercise_update();

CREATE TRIGGER managed_cron_clear_acknowledgement_on_disable BEFORE UPDATE OF enabled ON public.managed_cron_definitions FOR EACH ROW WHEN (((old.enabled IS TRUE) AND (new.enabled IS FALSE))) EXECUTE FUNCTION public.managed_cron_clear_acknowledgement_on_disable();

CREATE TRIGGER resource_participant_work_identity_immutable BEFORE UPDATE ON public.resource_participant_work FOR EACH ROW EXECUTE FUNCTION public.magnus_reject_resource_participant_identity_update();

CREATE CONSTRAINT TRIGGER shared_resource_claim_consistency AFTER INSERT OR DELETE OR UPDATE ON public.shared_resource_lease_resources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.magnus_check_shared_resource_claim_consistency();

CREATE TRIGGER shared_resource_claim_delete_guard BEFORE DELETE ON public.shared_resource_lease_resources FOR EACH ROW EXECUTE FUNCTION public.magnus_reject_shared_resource_claim_delete();

CREATE TRIGGER shared_resource_claim_insert_guard BEFORE INSERT ON public.shared_resource_lease_resources FOR EACH ROW EXECUTE FUNCTION public.magnus_enforce_shared_resource_claim_insert();

CREATE TRIGGER shared_resource_claim_transition_guard BEFORE UPDATE ON public.shared_resource_lease_resources FOR EACH ROW EXECUTE FUNCTION public.magnus_enforce_shared_resource_claim_transition();

CREATE TRIGGER shared_resource_claim_truncate_guard BEFORE TRUNCATE ON public.shared_resource_lease_resources FOR EACH STATEMENT EXECUTE FUNCTION public.magnus_reject_shared_resource_claim_delete();

CREATE TRIGGER shared_resource_fence_delete_guard BEFORE DELETE ON public.shared_resource_fences FOR EACH ROW EXECUTE FUNCTION public.magnus_reject_shared_resource_fence_delete();

CREATE TRIGGER shared_resource_fence_generation_monotonic BEFORE UPDATE ON public.shared_resource_fences FOR EACH ROW EXECUTE FUNCTION public.magnus_enforce_shared_resource_fence_generation();

CREATE TRIGGER shared_resource_fence_insert_guard BEFORE INSERT ON public.shared_resource_fences FOR EACH ROW EXECUTE FUNCTION public.magnus_enforce_shared_resource_fence_insert();

CREATE TRIGGER shared_resource_fence_truncate_guard BEFORE TRUNCATE ON public.shared_resource_fences FOR EACH STATEMENT EXECUTE FUNCTION public.magnus_reject_shared_resource_fence_delete();

CREATE CONSTRAINT TRIGGER shared_resource_lease_consistency AFTER INSERT OR DELETE OR UPDATE ON public.shared_resource_leases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.magnus_check_shared_resource_lease_consistency();

CREATE TRIGGER shared_resource_lease_insert_guard BEFORE INSERT ON public.shared_resource_leases FOR EACH ROW EXECUTE FUNCTION public.magnus_enforce_shared_resource_lease_insert();

CREATE TRIGGER shared_resource_lease_transition_guard BEFORE UPDATE ON public.shared_resource_leases FOR EACH ROW EXECUTE FUNCTION public.magnus_enforce_shared_resource_lease_transition();

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT "agents_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT "ai_conversations_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.ai_conversations(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES public.ai_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.alert_condition_states
    ADD CONSTRAINT "alert_condition_states_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.alert_condition_states
    ADD CONSTRAINT "alert_condition_states_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES public.alert_rules(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.alert_violations
    ADD CONSTRAINT "alert_violations_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.alert_violations
    ADD CONSTRAINT "alert_violations_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES public.alert_rules(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.anomaly_events
    ADD CONSTRAINT "anomaly_events_healthSnapshotId_fkey" FOREIGN KEY ("healthSnapshotId") REFERENCES public.health_snapshots(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.anomaly_events
    ADD CONSTRAINT "anomaly_events_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.ardent_installations
    ADD CONSTRAINT "ardent_installations_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.ardent_profiles
    ADD CONSTRAINT "ardent_profiles_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES public.ardent_installations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.ardent_scope_enrollments
    ADD CONSTRAINT "ardent_scope_enrollments_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.command_results
    ADD CONSTRAINT "command_results_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES public.remote_commands(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.council_admission_fences
    ADD CONSTRAINT "council_admission_fences_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.cron_job_executions
    ADD CONSTRAINT "cron_job_executions_cronJobId_fkey" FOREIGN KEY ("cronJobId") REFERENCES public.cron_jobs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.cron_job_executions
    ADD CONSTRAINT "cron_job_executions_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.cron_jobs
    ADD CONSTRAINT "cron_jobs_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.drift_scans
    ADD CONSTRAINT "drift_scans_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.engineering_metric_samples
    ADD CONSTRAINT "engineering_metric_samples_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.file_patch_tasks
    ADD CONSTRAINT "file_patch_tasks_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.gpu_snapshots
    ADD CONSTRAINT "gpu_snapshots_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.health_snapshots
    ADD CONSTRAINT "health_snapshots_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.hermes_core_rollout_hosts
    ADD CONSTRAINT "hermes_core_rollout_hosts_rolloutId_fkey" FOREIGN KEY ("rolloutId") REFERENCES public.hermes_core_rollouts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.hermes_credential_pool_attachments
    ADD CONSTRAINT "hermes_credential_pool_attachments_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES public.hermes_credential_pools(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.hermes_installations
    ADD CONSTRAINT "hermes_installations_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.hermes_mcp_server_attachments
    ADD CONSTRAINT "hermes_mcp_server_attachments_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES public.hermes_mcp_servers(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.hermes_operation_jobs
    ADD CONSTRAINT "hermes_operation_jobs_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES public.hermes_installations(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.hermes_operation_jobs
    ADD CONSTRAINT "hermes_operation_jobs_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES public.hermes_profiles(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.hermes_profiles
    ADD CONSTRAINT "hermes_profiles_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES public.hermes_installations(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.hermes_role_applications
    ADD CONSTRAINT "hermes_role_applications_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES public.hermes_roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.library_files
    ADD CONSTRAINT "library_files_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES public.library_categories(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.log_entries
    ADD CONSTRAINT "log_entries_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT "nodes_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT "notifications_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.remediation_executions
    ADD CONSTRAINT "remediation_executions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES public.remediation_rules(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.remote_commands
    ADD CONSTRAINT "remote_commands_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.resource_drain_participants
    ADD CONSTRAINT "resource_drain_participants_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.resource_enrollments("nodeId") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.resource_enrollments
    ADD CONSTRAINT "resource_enrollments_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.resource_participant_work
    ADD CONSTRAINT "resource_participant_work_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.role_applications
    ADD CONSTRAINT "role_applications_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.role_applications
    ADD CONSTRAINT "role_applications_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.rollout_targets
    ADD CONSTRAINT "rollout_targets_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.rollout_targets
    ADD CONSTRAINT "rollout_targets_rolloutId_fkey" FOREIGN KEY ("rolloutId") REFERENCES public.execution_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_resource_lease_resources
    ADD CONSTRAINT "shared_resource_lease_resources_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES public.shared_resource_leases(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.skill_installations
    ADD CONSTRAINT "skill_installations_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.skill_installations
    ADD CONSTRAINT "skill_installations_registryEntryId_fkey" FOREIGN KEY ("registryEntryId") REFERENCES public.skill_registry_entries(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.skill_tags
    ADD CONSTRAINT "skill_tags_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES public.skill_registry_entries(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT "skill_versions_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES public.skill_registry_entries(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES public.webhook_endpoints(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Base rows the server expects to exist.
INSERT INTO public.security_fusion_receipt_chain_heads ("id", "headSha256", "chainSequence", "updatedAt")
VALUES ('security-fusion', NULL, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO public.alert_rules (
  "id", "name", "metric", "operator", "threshold", "durationSeconds",
  "severity", "nodeFilter", "active", "cooldownMinutes", "createdBy", "createdAt", "updatedAt"
) VALUES (
  'system-gpu-fan-100-8h', 'GPU fan saturated for 8 hours', 'gpu_fan', 'gte', 100, 28800,
  'critical', '*', true, 480, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
