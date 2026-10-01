export const supportedLanguages = ["zh", "en"] as const;
export type Language = (typeof supportedLanguages)[number];

export interface HealthResponse {
  ok: true;
  timestamp: string;
}
