import { discover } from "./lockfiles.js";
import { checkAdvisories, type Fetcher } from "./osv.js";
import { lookupPackages } from "./registry.js";
import { decide, isDirect, type Assessment } from "./verdict.js";

/**
 * Runs the free assessment of a checkout: reads lockfiles and manifests (never runs repository code), checks every
 * locked version against OSV, and looks up the latest releases of direct dependencies and of malicious findings.
 */
export const assess = async (root: string, keyPackages: string[], fetcher: Fetcher): Promise<Assessment> => {
  const discovery = discover(root);
  const packages = discovery.lockfiles.flatMap((report) => (report.status === "assessed" ? report.packages : []));
  const advisoryCheck = await checkAdvisories(fetcher, packages);
  const malicious = packages.filter((locked) =>
    advisoryCheck.advisories.get(`${locked.name}@${locked.version}`)?.some((group) => group.malicious),
  );
  const registry = await lookupPackages(fetcher, [
    ...packages.filter((locked) => isDirect(locked.usages)).map((locked) => locked.name),
    ...malicious.map((locked) => locked.name),
  ]);
  return decide(discovery, advisoryCheck, registry, keyPackages);
};
