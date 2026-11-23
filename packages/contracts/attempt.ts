// Experimental application metadata. Business arguments remain identical on retry.
export const attemptMetaKey = 'mcp-reliability-kit/attempt-id';
export function attemptId(key: string, ordinal: number) {
  return key + '.' + ordinal;
}

export interface PendingAttempt {
  caseId: string;
  tool: string;
  operationKey: string;
  ordinal: number;
}
