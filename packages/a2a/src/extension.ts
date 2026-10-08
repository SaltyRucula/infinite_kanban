/**
 * Board-specific A2A protocol extension.
 *
 * A2A carries opaque `metadata` maps on messages, tasks, status updates and
 * artifacts. The board uses them to round-trip its own richer event model
 * (`AgentEvent`) without inventing non-standard top-level fields: a generic
 * A2A client sees plain text/data parts, while another board instance can
 * reconstruct the exact event.
 */
export const BOARD_EXTENSION_URI = 'https://github.com/SaltyRucula/infinite_kanban/a2a/board/v1';

/** Metadata key holding a serialized `AgentEvent` envelope. */
export const EXT_AGENT_EVENT = `${BOARD_EXTENSION_URI}#agentEvent`;

/** Metadata key holding the board task assignment (worker handoff payload). */
export const EXT_ASSIGNMENT = `${BOARD_EXTENSION_URI}#assignment`;

/** Metadata key holding board-side task coordinates (project, column, deep link). */
export const EXT_TASK_CONTRACT = `${BOARD_EXTENSION_URI}#taskContract`;

/** Metadata key holding worker consent data (accepted projects/labels). */
export const EXT_WORKER_CONSENT = `${BOARD_EXTENSION_URI}#workerConsent`;

/** Media type used for the board's structured data parts. */
export const BOARD_DATA_MEDIA_TYPE = 'application/json';
