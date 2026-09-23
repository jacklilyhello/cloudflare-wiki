import {
  parseSiteSettingsValues,
  type SiteSettings,
  type SiteSettingsInput,
  type SiteSettingsValues,
} from "../../shared/settings";
import { type ContentWriteAccess, sessionGuard } from "../auth/access";

export class SettingsError extends Error {
  constructor(
    readonly status: 400 | 401 | 412 | 503,
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

type Row = {
  id: number;
  version: number;
  zh_name: string;
  zh_description: string;
  en_name: string;
  en_description: string;
  default_language: string;
  theme: string;
  accent: string;
  logo: string;
  updated_at: string;
};
const columns =
  "s.id,s.version,s.zh_name,s.zh_description,s.en_name,s.en_description,s.default_language,s.theme,s.accent,s.logo,s.updated_at";
const valueKeys = ["locales", "defaultLanguage", "theme", "accent", "logo"];

function invalid(): never {
  throw new SettingsError(400, "Invalid site settings.");
}
function storage(): never {
  throw new SettingsError(503, "Site settings are temporarily unavailable.");
}
function unauthorized(): never {
  throw new SettingsError(401, "Authentication required.");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
}
function validVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid();
  return value;
}
function values(input: Record<string, unknown>): SiteSettingsValues {
  try {
    return parseSiteSettingsValues(input);
  } catch {
    invalid();
  }
}
function decode(row: Row | null | undefined): SiteSettings {
  try {
    if (row?.id !== 1) storage();
    const version = validVersion(row.version);
    if (
      typeof row.updated_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.updated_at) ||
      new Date(row.updated_at).toISOString() !== row.updated_at
    )
      storage();
    const parsed = values({
      locales: {
        zh: { name: row.zh_name, description: row.zh_description },
        en: { name: row.en_name, description: row.en_description },
      },
      defaultLanguage: row.default_language,
      theme: row.theme,
      accent: row.accent,
      logo: row.logo,
    });
    if (
      parsed.locales.zh.name !== row.zh_name ||
      parsed.locales.zh.description !== row.zh_description ||
      parsed.locales.en.name !== row.en_name ||
      parsed.locales.en.description !== row.en_description
    )
      storage();
    return { ...parsed, version, updatedAt: row.updated_at };
  } catch {
    storage();
  }
}

// These presentation values are intentionally public. A missing or invalid row
// is an operational error, never permission to silently restore the seed.
export async function getSiteSettings(db: D1Database): Promise<SiteSettings> {
  try {
    return decode(
      await db
        .prepare(`SELECT ${columns} FROM site_settings s WHERE s.id=1`)
        .first<Row>(),
    );
  } catch {
    storage();
  }
}

export class SettingsService {
  private readonly access: ContentWriteAccess;
  constructor(
    private readonly db: D1Database,
    access: ContentWriteAccess,
  ) {
    this.access = Object.freeze({ ...access });
    this.session();
  }
  private session() {
    try {
      return sessionGuard(this.access);
    } catch {
      unauthorized();
    }
  }
  private statement(sql: string, params: (string | number)[] = []) {
    try {
      return this.db.prepare(sql).bind(...params);
    } catch {
      storage();
    }
  }
  private read(session: ReturnType<typeof sessionGuard>) {
    return this.statement(
      `SELECT ${columns} FROM (SELECT 1) LEFT JOIN site_settings s ON s.id=1 WHERE ${session.sql}`,
      session.values,
    );
  }
  private decodePrivate(row: Row | null | undefined) {
    if (!row) unauthorized();
    return decode(row);
  }
  private failure(error: unknown): never {
    if (error instanceof SettingsError) throw error;
    storage();
  }
  async get(): Promise<SiteSettings> {
    try {
      return this.decodePrivate(await this.read(this.session()).first<Row>());
    } catch (error) {
      this.failure(error);
    }
  }
  async update(input: SiteSettingsInput): Promise<SiteSettings> {
    const raw = object(input, ["expectedVersion", ...valueKeys]);
    const expectedVersion = validVersion(raw.expectedVersion);
    const { expectedVersion: _expectedVersion, ...requestedValues } = raw;
    const next = values(requestedValues);
    // Validate stored values before attempting an update. Concurrent legitimate
    // writers remain governed by the live SQL session/version predicate below.
    await this.get();
    const session = this.session();
    const content = [
      next.locales.zh.name,
      next.locales.zh.description,
      next.locales.en.name,
      next.locales.en.description,
      next.defaultLanguage,
      next.theme,
      next.accent,
      next.logo,
    ];
    try {
      const results = await this.db.batch([
        this.statement(
          `UPDATE site_settings SET zh_name=?,zh_description=?,en_name=?,en_description=?,default_language=?,theme=?,accent=?,logo=?,version=version+1,updated_at=?
          WHERE id=1 AND version=? AND ${session.sql}
          AND (zh_name IS NOT ? OR zh_description IS NOT ? OR en_name IS NOT ? OR en_description IS NOT ? OR default_language IS NOT ? OR theme IS NOT ? OR accent IS NOT ? OR logo IS NOT ?)
          RETURNING id`,
          [
            ...content,
            new Date().toISOString(),
            expectedVersion,
            ...session.values,
            ...content,
          ],
        ),
        this.read(session),
      ]);
      const current = this.decodePrivate(
        results[1]?.results[0] as Row | undefined,
      );
      if (!results[0]?.results.length && current.version !== expectedVersion)
        throw new SettingsError(
          412,
          "Site settings changed. Reload before retrying.",
        );
      return current;
    } catch (error) {
      this.failure(error);
    }
  }
}
