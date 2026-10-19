export type ProviderStatus = 'queued' | 'generating' | 'postprocessing' | 'ready' | 'failed' | 'cancelled';
export interface VideoProvider {
  submit(input: { prompt: string; imageUrl: string; durationS: 3 | 5 | 6 | 10 | 15 | 20 | 30; format: '16:9' | '9:16' | '1:1' | '4:5'; endUserId?: string }, apiKey?: string): Promise<{ requestId: string }>;
  status(requestId: string, apiKey?: string, endpointOverride?: string): Promise<{ status: ProviderStatus; videoUrl?: string; error?: string }>;
}
export interface LlmProvider {
  buildBrief(description: string, options: Record<string, string>): Promise<unknown>;
}
