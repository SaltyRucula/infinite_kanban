import type Database from 'better-sqlite3';
import type { Pool } from 'pg';
import type { ExecutionAssignment, ExecutionResult } from '@ai-agent-board/shared/execution.js';
export interface WorkflowDispatch { assignment: ExecutionAssignment; endpoint: string; protocolVersion: '1.0'|'0.3'; state: 'prepared'|'sending'|'running'|'accepted'|'fenced'; remoteTaskId?: string; result?: ExecutionResult }
export interface BoardWorkflowRun {
 id: string; taskId: string; projectId: string; version: number;
 phase: 'implementing'|'reviewing'|'awaiting_approval'|'done'|'escalated'|'dispatch_uncertain'|'canceled';
 repository: string; baseRevision: string; requirements: string; requiredCapabilities: string[];
 policy: { autoFinish: boolean; maxRounds: number; maxDispatches: number; deadline: number; requiredChecks: string[] };
 assignments: WorkflowDispatch[]; diagnostics: { at: number; category: 'dispatch'|'execution'|'acceptance'; reason: string; response?: unknown }[];
 acceptedRevision?: string; approvedRevision?: string; approvedBy?: string; approvedAt?: number;
 /** Terminal projection is replayed until this checkpoint is durably saved. */
 projectedPhase?: BoardWorkflowRun['phase'];
}
export interface WorkflowStore { get(taskId: string): Promise<BoardWorkflowRun|undefined>; list(): Promise<BoardWorkflowRun[]>; save(run: BoardWorkflowRun, expectedVersion: number): Promise<void> }
export const WORKFLOW_SCHEMA = 'CREATE TABLE IF NOT EXISTS board_workflow_runs (task_id TEXT PRIMARY KEY, version INTEGER NOT NULL, document TEXT NOT NULL)';
export class SqliteWorkflowStore implements WorkflowStore {
 constructor(private readonly db: Database.Database) { db.exec(WORKFLOW_SCHEMA); }
 async get(id: string) { const row=this.db.prepare('SELECT document FROM board_workflow_runs WHERE task_id=?').get(id) as {document:string}|undefined;return row?JSON.parse(row.document) as BoardWorkflowRun:undefined; }
 async list() {return (this.db.prepare('SELECT document FROM board_workflow_runs').all() as {document:string}[]).map(r=>JSON.parse(r.document) as BoardWorkflowRun);}
 async save(run: BoardWorkflowRun, expectedVersion: number) {
  const document=JSON.stringify({...run,version:expectedVersion+1});
  const changes=expectedVersion===0?this.db.prepare('INSERT OR IGNORE INTO board_workflow_runs (task_id,version,document) VALUES (?,1,?)').run(run.taskId,document).changes:this.db.prepare('UPDATE board_workflow_runs SET version=?, document=? WHERE task_id=? AND version=?').run(expectedVersion+1,document,run.taskId,expectedVersion).changes;
  if(changes!==1)throw new Error('workflow changed concurrently');run.version=expectedVersion+1;
 }
}
export class PostgresWorkflowStore implements WorkflowStore {
 constructor(private readonly pool: Pool) {}
 async init() {await this.pool.query(WORKFLOW_SCHEMA);}
 async get(id: string) {const {rows}=await this.pool.query('SELECT document FROM board_workflow_runs WHERE task_id=$1',[id]);return rows[0]?JSON.parse(rows[0].document) as BoardWorkflowRun:undefined;}
 async list() {const {rows}=await this.pool.query('SELECT document FROM board_workflow_runs');return rows.map(r=>JSON.parse(r.document) as BoardWorkflowRun);}
 async save(run: BoardWorkflowRun, expectedVersion: number) {
  const document=JSON.stringify({...run,version:expectedVersion+1});
  const result=expectedVersion===0?await this.pool.query('INSERT INTO board_workflow_runs (task_id,version,document) VALUES ($1,1,$2) ON CONFLICT (task_id) DO NOTHING',[run.taskId,document]):await this.pool.query('UPDATE board_workflow_runs SET version=$1, document=$2 WHERE task_id=$3 AND version=$4',[expectedVersion+1,document,run.taskId,expectedVersion]);
  if(result.rowCount!==1)throw new Error('workflow changed concurrently');run.version=expectedVersion+1;
 }
}
