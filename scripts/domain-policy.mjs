import { PUBLIC_DOMAINS, WORKER_NAME } from "./deploy-policy.mjs";

function routeOverlaps(pattern, hostname) {
  if (typeof pattern !== "string")
    throw new Error("Worker route inventory is malformed.");
  const host = pattern.replace(/^https?:\/\//, "").split("/")[0];
  const escaped = host
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(hostname);
}

export function validateDomains(domains, zoneId, deployed = false) {
  if (!Array.isArray(domains))
    throw new Error("Custom Domain inventory is malformed.");
  for (const domain of domains) {
    if (
      PUBLIC_DOMAINS.includes(domain.hostname) &&
      (domain.service !== WORKER_NAME || domain.zone_id !== zoneId)
    )
      throw new Error(
        "A production hostname belongs to another Worker or zone.",
      );
    if (
      domain.service === WORKER_NAME &&
      !PUBLIC_DOMAINS.includes(domain.hostname)
    )
      throw new Error("The Worker has an unapproved Custom Domain.");
  }
  for (const hostname of PUBLIC_DOMAINS) {
    const matches = domains.filter((domain) => domain.hostname === hostname);
    if (
      matches.length > 1 ||
      (deployed &&
        (matches.length !== 1 ||
          matches[0].enabled !== true ||
          matches[0].environment !== "production" ||
          matches[0].previews_enabled !== false))
    )
      throw new Error(
        "Production Custom Domain readback is incomplete or ambiguous.",
      );
  }
}

export function validateDomainPreflight({ domains, routes, records, zoneId }) {
  validateDomains(domains, zoneId);
  if (!Array.isArray(routes))
    throw new Error("Worker route inventory is malformed.");
  if (
    routes.some(
      (route) =>
        route.script === WORKER_NAME ||
        PUBLIC_DOMAINS.some((hostname) =>
          routeOverlaps(route.pattern, hostname),
        ),
    )
  )
    throw new Error(
      "An existing Worker route conflicts with production Custom Domains.",
    );
  for (const hostname of PUBLIC_DOMAINS) {
    const rows = records[hostname];
    if (
      !Array.isArray(rows) ||
      rows.length >= 5000 ||
      rows.some((record) => record.name !== hostname)
    )
      throw new Error("Target DNS inventory is malformed.");
    const owned = domains.some(
      (domain) =>
        domain.hostname === hostname && domain.service === WORKER_NAME,
    );
    // TXT verification/SPF and CAA records coexist with Custom Domains. Never
    // replace address, alias or delegation records on an unbound hostname.
    if (
      !owned &&
      rows.some((record) => ["A", "AAAA", "CNAME", "NS"].includes(record.type))
    )
      throw new Error(
        "A production hostname has conflicting DNS; no record was replaced.",
      );
  }
}
