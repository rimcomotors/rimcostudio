export type AnimationSubmitState = 'queued' | 'submitting' | 'submitted' | 'failed' | 'reconciliation';

export function canSubmitAnimation(state: AnimationSubmitState | null | undefined, requestId: string | null | undefined): boolean {
  return state === 'queued' && !requestId;
}

export function animationSubmitStateAfterFailure(statusCode: number | null): 'failed' | 'reconciliation' {
  return statusCode === null || statusCode >= 500 ? 'reconciliation' : 'failed';
}
