import Database from 'better-sqlite3';
import type { ConsumedEnrollmentCode, EnrollmentCodeRecord, EnrollmentCodeRepository } from './enrollment-code-types.js';

interface EnrollmentCodeRow {
  owner_id: string;
  project_id: string | null;
}

export class SqliteEnrollmentCodeRepository implements EnrollmentCodeRepository {
  constructor(private readonly db: Database.Database) {}

  async create(input: EnrollmentCodeRecord): Promise<void> {
    this.db.prepare(
      `INSERT INTO enrollment_codes (code_hash, owner_id, project_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.codeHash, input.ownerId, input.projectId ?? null, input.expiresAt, input.createdAt);
  }

  async consume(codeHash: string, at: number): Promise<ConsumedEnrollmentCode | undefined> {
    const row = this.db.prepare(
      `DELETE FROM enrollment_codes
       WHERE code_hash = ? AND expires_at > ?
       RETURNING owner_id, project_id`,
    ).get(codeHash, at) as EnrollmentCodeRow | undefined;
    return row ? { ownerId: row.owner_id, ...(row.project_id ? { projectId: row.project_id } : {}) } : undefined;
  }
}
