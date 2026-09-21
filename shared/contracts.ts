export const supportedLanguages = ["zh", "en"] as const;
export type Language = (typeof supportedLanguages)[number];

export interface HealthResponse {
  status: "ok";
  service: "cloudflare-wiki";
  environment: "test";
  revision: string;
}
