/** Versioned, harness-neutral public execution contract. No host paths or credentials. */
export type ExecutionRole = 'implementation' | 'review';
export interface ExecutionAssignment {
 schemaVersion: 1; taskId: string; projectId: string; workflowRunId: string; assignmentId: string; attempt: number;
 role: ExecutionRole; endpointId: string; repository: string; baseRevision: string; targetRevision?: string;
 requirements: string; requiredCapabilities: string[]; constraints: { deadline: number; readOnly?: boolean };
 parentImplementationAssignmentId?: string;
}
export interface ExecutionEvidence { check: string; revision: string; outcome: 'passed' | 'failed'; artifact: string }
export interface ExecutionFinding { severity: 'info' | 'warning' | 'error'; explanation: string; location?: string }
export interface ExecutionResult {
 schemaVersion: 1; taskId: string; workflowRunId: string; assignmentId: string; attempt: number;
 role: ExecutionRole; endpointId: string; revision: string; summary: string;
 evidence: ExecutionEvidence[]; verdict?: 'approved' | 'changes_requested'; findings?: ExecutionFinding[];
}
export function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected structured object');
 const record = value as Record<string, unknown>;
 for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`unexpected field: ${key}`);
 return record;
}
function text(value: unknown, name: string): asserts value is string {
 if (typeof value !== 'string' || !value.trim() || value.length > 100000) throw new Error(`invalid ${name}`);
}
export function immutableRevision(value: unknown): asserts value is string {
 if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(value)) throw new Error('immutable revision required');
}
function identity(record: Record<string, unknown>): void {
 if (record.schemaVersion !== 1) throw new Error('unsupported schemaVersion');
 for (const key of ['taskId','workflowRunId','assignmentId','endpointId']) text(record[key], key);
 if (typeof record.assignmentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.assignmentId)) throw new Error('invalid assignmentId');
 if (!Number.isSafeInteger(record.attempt) || Number(record.attempt) < 1) throw new Error('invalid attempt');
 if (record.role !== 'implementation' && record.role !== 'review') throw new Error('invalid role');
}
export const EXECUTION_ASSIGNMENT_KEYS = ['schemaVersion','taskId','projectId','workflowRunId','assignmentId','attempt','role','endpointId','repository','baseRevision','targetRevision','requirements','requiredCapabilities','constraints','parentImplementationAssignmentId'] as const satisfies readonly (keyof ExecutionAssignment)[];
export function validateAssignment(value: unknown): ExecutionAssignment {
 const record = strictRecord(value, EXECUTION_ASSIGNMENT_KEYS); identity(record); text(record.projectId, 'projectId');
 text(record.repository, 'repository');
 // Portable remote URL only; credentials and local filesystem identities never cross this boundary.
 if (!/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(record.repository)) throw new Error('portable repository required');
 if (record.repository.includes('://')) { const url = new URL(record.repository); if (url.password || url.search || url.hash || (url.protocol === 'https:' && url.username) || !url.hostname || !url.pathname.replace(/\//g,'')) throw new Error('invalid repository'); }
 immutableRevision(record.baseRevision); text(record.requirements, 'requirements');
 if (!Array.isArray(record.requiredCapabilities) || record.requiredCapabilities.some(c => typeof c !== 'string' || !c)) throw new Error('invalid requiredCapabilities');
 const constraints = strictRecord(record.constraints, ['deadline','readOnly']);
 if (!Number.isSafeInteger(constraints.deadline) || Number(constraints.deadline) <= 0 || (constraints.readOnly !== undefined && typeof constraints.readOnly !== 'boolean')) throw new Error('invalid constraints');
 if (record.role === 'review') immutableRevision(record.targetRevision);
 else if (record.targetRevision !== undefined) throw new Error('implementation cannot set targetRevision');
 if (record.parentImplementationAssignmentId !== undefined) text(record.parentImplementationAssignmentId, 'parentImplementationAssignmentId');
 return record as unknown as ExecutionAssignment;
}
export function validateResult(value: unknown, assignment: ExecutionAssignment): ExecutionResult {
 const record = strictRecord(value, ['schemaVersion','taskId','workflowRunId','assignmentId','attempt','role','endpointId','revision','summary','evidence','verdict','findings']); identity(record);
 for (const key of ['taskId','workflowRunId','assignmentId','attempt','role','endpointId'] as const) if (record[key] !== assignment[key]) throw new Error(`result ${key} does not match active dispatch`);
 immutableRevision(record.revision); text(record.summary, 'summary');
 if (assignment.role === 'review' && record.revision !== assignment.targetRevision) throw new Error('wrong reviewed revision');
 if (!Array.isArray(record.evidence) || !record.evidence.length) throw new Error('missing evidence');
 for (const value of record.evidence) {
  const evidence = strictRecord(value, ['check','revision','outcome','artifact']); text(evidence.check,'check');
  if (evidence.revision !== record.revision) throw new Error('evidence revision mismatch');
  if (evidence.outcome !== 'passed' && evidence.outcome !== 'failed') throw new Error('invalid evidence outcome');
  text(evidence.artifact,'artifact');
  if (!/^(?:urn:sha256:[a-f0-9]{64}|https:\/\/[^\s]+)$/.test(evidence.artifact)) throw new Error('retrievable content-addressed artifact required');
 }
 if (assignment.role === 'review') {
  if (record.verdict !== 'approved' && record.verdict !== 'changes_requested') throw new Error('structured review verdict required');
  if (!Array.isArray(record.findings)) throw new Error('findings required');
  for (const value of record.findings) { const f = strictRecord(value,['severity','explanation','location']); if (!['info','warning','error'].includes(String(f.severity))) throw new Error('invalid severity'); text(f.explanation,'explanation'); if (f.location !== undefined) text(f.location,'location'); }
  if (record.verdict === 'changes_requested' && !record.findings.length) throw new Error('changes require actionable findings');
  if (record.verdict === 'approved' && (record.findings.some(f => (f as ExecutionFinding).severity === 'error') || record.evidence.some(e => (e as ExecutionEvidence).outcome !== 'passed'))) throw new Error('approval conflicts with evidence/findings');
 } else if (record.verdict !== undefined || record.findings !== undefined) throw new Error('implementation cannot settle review');
 return record as unknown as ExecutionResult;
}
