export class ApiError extends Error {
  constructor(readonly status: number) {
    super("Admin request failed");
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export function mutation(
  method: string,
  body: unknown,
  csrfToken?: string,
): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify(body),
  };
}
