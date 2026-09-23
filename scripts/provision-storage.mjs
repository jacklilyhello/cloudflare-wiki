import { inspectD1, provisionD1 } from "./d1-provision.mjs";
import { ensureR2, validateR2Config } from "./r2-provision.mjs";

// Inspect existing D1 ownership before touching R2. A failed R2 provision must
// leave D1 creation/migrations and the caller's bootstrap/deploy unstarted.
export async function provisionStorage(input, dependencies) {
  validateR2Config(input.config);
  await inspectD1(input, dependencies);
  await ensureR2(input, dependencies);
  // Reinspect D1 immediately before mutation; do not trust an earlier snapshot
  // after network I/O against another resource.
  return provisionD1(input, dependencies);
}
