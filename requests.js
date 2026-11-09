export const STATUS = { pendente: "Pendente", aprovada: "Aprovada", recusada: "Recusada" };
export const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export function isApprover(email, groups, config) {
  return config.approver_emails.some((value) => value.toLowerCase() === email.toLowerCase()) ||
    groups.some((group) => config.approver_groups.includes(group));
}

export function requestStore(pool) {
  return {
    async list(status) {
      const filtered = Object.hasOwn(STATUS, status);
      return (await pool.query(
        `SELECT * FROM purchase_requests WHERE deleted_at IS NULL${filtered ? " AND status = $1" : ""}
         ORDER BY (status = 'pendente') DESC, created_at DESC LIMIT 500`, filtered ? [status] : [],
      )).rows;
    },
    async create({ description, quantity, value, justification }, person) {
      await pool.query(`INSERT INTO purchase_requests (description, quantity, estimated_value, justification, requester_email, requester_name)
        VALUES ($1, $2, $3, $4, $5, $6)`, [description, quantity, value, justification, person.email, person.name]);
    },
    async decide(id, status, note, person) {
      if (!person.isApprover || !["aprovada", "recusada"].includes(status)) return false;
      const { rowCount } = await pool.query(`UPDATE purchase_requests
        SET status=$1, decided_by=$2, decided_by_name=$3, decision_note=$4, decided_at=statement_timestamp()
        WHERE id=$5 AND status='pendente' AND requester_email <> $2 AND deleted_at IS NULL`,
      [status, person.email, person.name, note, id]);
      return rowCount > 0;
    },
    async softDelete(id, person) {
      // Only the requester may withdraw a pending request; keep decisions as history.
      const { rowCount } = await pool.query(`UPDATE purchase_requests SET deleted_at=statement_timestamp()
        WHERE id=$1 AND requester_email=$2 AND status='pendente' AND deleted_at IS NULL`, [id, person.email]);
      return rowCount > 0;
    },
  };
}
