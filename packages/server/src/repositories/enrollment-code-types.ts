export interface EnrollmentCodeRecord {
  readonly codeHash: string;
  readonly ownerId: string;
  readonly projectId?: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

export interface ConsumedEnrollmentCode {
  readonly ownerId: string;
  readonly projectId?: string;
}

export interface EnrollmentCodeRepository {
  create(input: EnrollmentCodeRecord): Promise<void>;
  consume(codeHash: string, at: number): Promise<ConsumedEnrollmentCode | undefined>;
}
