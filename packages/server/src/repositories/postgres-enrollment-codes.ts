import type { Pool } from 'pg';
import type { ConsumedEnrollmentCode, EnrollmentCodeRecord, EnrollmentCodeRepository } from './enrollment-code-types.js';

interface EnrollmentCodeRow {
  owner_id: string;
  project_id: string | null;
}

export class PostgresEnrollmentCodeRepository implements EnrollmentCodeRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: EnrollmentCodeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO enrollment_codes (code_hash, owner_id, project_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.codeHash, input.ownerId, input.projectId ?? null, input.expiresAt, input.createdAt],
    );
  }

  async consume(codeHash: string, at: number): Promise<ConsumedEnrollmentCode | undefined> {
    const { rows } = await this.pool.query<EnrollmentCodeRow>(
      `DELETE FROM enrollment_codes
       WHERE code_hash = $1 AND expires_at > $2
       RETURNING owner_id, project_id`,
      [codeHash, at],
    );
    const row = rows[0];
    return row ? { ownerId: row.owner_id, ...(row.project_id ? { projectId: row.project_id } : {}) } : undefined;
  }
}
