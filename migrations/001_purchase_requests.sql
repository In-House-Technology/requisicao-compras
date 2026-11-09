CREATE TABLE IF NOT EXISTS purchase_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  description TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  estimated_value NUMERIC(14,2) NOT NULL CHECK (estimated_value >= 0),
  justification TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  requester_name TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovada', 'recusada')),
  decided_by TEXT,
  decided_by_name TEXT,
  decision_note TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_epoch BIGINT NOT NULL DEFAULT floor(extract(epoch FROM now())),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at_epoch BIGINT NOT NULL DEFAULT floor(extract(epoch FROM now())),
  deleted_at TIMESTAMPTZ,
  deleted_at_epoch BIGINT
);

CREATE OR REPLACE FUNCTION maintain_purchase_request_timestamps() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.modified_at := statement_timestamp();
  ELSE
    NEW.created_at := coalesce(NEW.created_at, statement_timestamp());
    NEW.modified_at := NEW.created_at;
  END IF;
  NEW.created_at_epoch := floor(extract(epoch FROM NEW.created_at));
  NEW.modified_at_epoch := floor(extract(epoch FROM NEW.modified_at));
  NEW.deleted_at_epoch := floor(extract(epoch FROM NEW.deleted_at));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS purchase_requests_timestamps ON purchase_requests;
CREATE TRIGGER purchase_requests_timestamps BEFORE INSERT OR UPDATE ON purchase_requests
FOR EACH ROW EXECUTE FUNCTION maintain_purchase_request_timestamps();

CREATE INDEX IF NOT EXISTS purchase_requests_active_status_idx
ON purchase_requests (status, created_at DESC) WHERE deleted_at IS NULL;
