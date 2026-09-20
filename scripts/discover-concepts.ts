/** Manual/cron entry for the standing discovery loop: npm run discover */
import "../lib/env";
import { runDiscovery, promoteOrphans } from "../lib/discovery";

async function main() {
  const orphans = promoteOrphans();
  console.log(`Orphan promotion: +${orphans.added.length} registered, ${Object.keys(orphans.merged).length} folded into existing concepts`);
  if (orphans.added.length) console.log("  " + orphans.added.join(", "));
  const r = await runDiscovery();
  console.log(`Discovery: scanned ${r.scanned} unmatched messages → ${r.proposed} proposals → +${r.added.length} new concepts, ${r.merged} merged`);
  if (r.added.length) console.log("  " + r.added.join(", "));
}

main().catch((e) => { console.error(e); process.exit(1); });
