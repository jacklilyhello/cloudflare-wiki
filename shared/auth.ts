export const AUTH_LIMITS = {
  passwordMin: 12,
  passwordMax: 128,
  passwordBytes: 512,
  absoluteMs: 8 * 60 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
  touchMs: 60 * 1000,
  rateWindowMs: 10 * 60 * 1000,
  perIpAttempts: 5,
  globalAttempts: 30,
} as const;

export type Administrator = { id: 1; username: string; version: number };
export type BootstrapStatus = { initialized: boolean; setupAvailable: boolean };
export type AuthSession = {
  user: Administrator;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  idleExpiresAt: string;
};
// The server must place token in an HttpOnly cookie, never a JSON response.
export type AuthGrant = { token: string; session: AuthSession };
export type LoginInput = { username: string; password: string };
export type SetupInput = LoginInput & { token: string };
export type PasswordChangeInput = {
  currentPassword: string;
  newPassword: string;
  expectedVersion: number;
};
export type UsernameChangeInput = {
  username: string;
  currentPassword: string;
  expectedVersion: number;
};

export class AuthError extends Error {
  readonly status: 400 | 401 | 403 | 409 | 429 | 503;
  constructor(status: AuthError["status"], message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}
