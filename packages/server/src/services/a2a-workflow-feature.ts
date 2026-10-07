export function isA2AWorkflowEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.A2A_WORKFLOW_ENABLED === 'true';
}
