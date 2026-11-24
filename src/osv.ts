import semver from "semver";

// OSV (https://osv.dev) is free and needs no key. /v1/querybatch returns advisory ids only (paginated per query);
// /v1/vulns/{id} returns the full record: severity, affected ranges, fixed versions, aliases.

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type Severity = "low" | "moderate" | "high" | "critical";
const SEVERITY_ORDER: Severity[] = ["low", "moderate", "high", "critical"];
export const severityRank = (severity: Severity): number => SEVERITY_ORDER.indexOf(severity);

/** Advisory records that are aliases of each other, reported as one issue. */
export type AdvisoryGroup = {
  /** OSV ids returned for the package version, then their aliases. */
  ids: string[];
  summary: string;
  severity: Severity;
  /** True when no record in the group states a severity (treated as moderate). */
  severityDefaulted: boolean;
  /** A malicious-package record (MAL- id or alias). Classified separately from severity. */
  malicious: boolean;
  /** Earliest publication date in the group. */
  published?: string;
  /** Nearest version above the locked one that fixes every record in the group. */
  fixedIn?: string;
  /** A record could not be retrieved; the group is reported from its id alone. */
  detailsMissing: boolean;
};

export type PackageVersion = { name: string; version: string };

export type AdvisoryCheck = {
  /** Advisories per "name@version"; a checked package without advisories has an empty list. */
  advisories: Map<string, AdvisoryGroup[]>;
  /** Packages whose lookup did not complete, with the reason. Never treated as clean. */
  notChecked: Map<string, string>;
  /** Advisory ids whose full record could not be retrieved. */
  detailsMissing: string[];
};

type OsvRecord = {
  id: string;
  aliases?: string[] | null;
  summary?: string;
  details?: string;
  published?: string;
  withdrawn?: string;
  database_specific?: { severity?: string };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { type?: string; events?: { introduced?: string; fixed?: string; last_affected?: string }[] }[];
    database_specific?: { severity?: string };
    ecosystem_specific?: { severity?: string };
  }[];
};

const OSV_API = "https://api.osv.dev/v1";
const BATCH_SIZE = 1000;
const DETAIL_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 30_000;

export const packageKey = ({ name, version }: PackageVersion): string => `${name}@${version}`;

const requestJson = async (fetcher: Fetcher, url: string, body?: unknown): Promise<unknown> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return await response.json();
      lastError = new Error(`OSV ${url} answered HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/** Ids of advisories affecting each package version, following next_page_token per query. */
const queryIds = async (
  fetcher: Fetcher,
  packages: PackageVersion[],
  notChecked: Map<string, string>,
): Promise<Map<string, string[]>> => {
  const ids = new Map<string, string[]>();
  const query = (item: PackageVersion, pageToken?: string) => ({
    package: { name: item.name, ecosystem: "npm" },
    version: item.version,
    ...(pageToken ? { page_token: pageToken } : {}),
  });
  for (let start = 0; start < packages.length; start += BATCH_SIZE) {
    let pending = packages.slice(start, start + BATCH_SIZE).map((item) => ({ item, pageToken: undefined as string | undefined }));
    while (pending.length) {
      let answer: { results?: { vulns?: { id: string }[]; next_page_token?: string }[] };
      try {
        answer = (await requestJson(fetcher, `${OSV_API}/querybatch`, {
          queries: pending.map(({ item, pageToken }) => query(item, pageToken)),
        })) as typeof answer;
        if (answer?.results?.length !== pending.length) throw new Error("OSV querybatch returned a different number of results");
      } catch (error) {
        for (const { item } of pending) notChecked.set(packageKey(item), `advisory lookup failed: ${(error as Error).message}`);
        for (const { item } of pending) ids.delete(packageKey(item));
        break;
      }
      const next: typeof pending = [];
      answer.results!.forEach((result, index) => {
        const key = packageKey(pending[index].item);
        ids.set(key, [...(ids.get(key) ?? []), ...(result.vulns ?? []).map((vuln) => vuln.id)]);
        if (result.next_page_token) next.push({ item: pending[index].item, pageToken: result.next_page_token });
      });
      pending = next;
    }
  }
  return ids;
};

const fetchRecords = async (fetcher: Fetcher, ids: string[]): Promise<Map<string, OsvRecord | Error>> => {
  const records = new Map<string, OsvRecord | Error>();
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        records.set(id, (await requestJson(fetcher, `${OSV_API}/vulns/${encodeURIComponent(id)}`)) as OsvRecord);
      } catch (error) {
        records.set(id, error as Error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, worker));
  return records;
};

const normaliseSeverity = (value: string | undefined): Severity | undefined => {
  switch (value?.toLowerCase()) {
    case "low":
      return "low";
    case "moderate":
    case "medium":
      return "moderate";
    case "high":
      return "high";
    case "critical":
      return "critical";
    default:
      return undefined;
  }
};

const recordSeverity = (record: OsvRecord): Severity | undefined =>
  normaliseSeverity(record.database_specific?.severity) ??
  record.affected
    ?.map((affected) => normaliseSeverity(affected.database_specific?.severity ?? affected.ecosystem_specific?.severity))
    .find((severity) => severity !== undefined);

/** Smallest "fixed" version above the locked version among this package's affected ranges. */
const recordFixedIn = (record: OsvRecord, item: PackageVersion): string | undefined =>
  record.affected
    ?.filter((affected) => affected.package?.ecosystem === "npm" && affected.package?.name === item.name)
    .flatMap((affected) => affected.ranges ?? [])
    .flatMap((range) => range.events ?? [])
    .map((event) => event.fixed)
    .filter((fixed): fixed is string => !!fixed && !!semver.valid(fixed) && semver.gt(fixed, item.version))
    .sort(semver.compare)[0];

const isMalicious = (ids: string[]): boolean => ids.some((id) => id.startsWith("MAL-"));

/** Groups a package version's advisory ids so that records which are aliases of each other become one issue. */
const groupAdvisories = (
  item: PackageVersion,
  ids: string[],
  records: Map<string, OsvRecord | Error>,
): AdvisoryGroup[] => {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)!)!);
      id = parent.get(id)!;
    }
    return id;
  };
  const add = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  const union = (a: string, b: string) => {
    add(a);
    add(b);
    parent.set(find(a), find(b));
  };
  const active = ids.filter((id) => {
    const record = records.get(id);
    return !(record && !(record instanceof Error) && record.withdrawn);
  });
  for (const id of active) {
    add(id);
    const record = records.get(id);
    if (record && !(record instanceof Error)) for (const alias of record.aliases ?? []) union(id, alias);
  }
  const groups = new Map<string, string[]>();
  for (const id of active) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()].map((members) => {
    const fetched = members.map((id) => records.get(id)).filter((record): record is OsvRecord => !!record && !(record instanceof Error));
    const aliases = fetched.flatMap((record) => record.aliases ?? []).filter((alias) => !members.includes(alias));
    const allIds = [...members.sort(), ...[...new Set(aliases)].sort()];
    const severities = fetched.map(recordSeverity).filter((severity): severity is Severity => !!severity);
    const fixes = fetched.map((record) => recordFixedIn(record, item));
    return {
      ids: allIds,
      summary: fetched.map((record) => record.summary).find(Boolean) ?? fetched.map((record) => record.details?.slice(0, 200)).find(Boolean) ?? "",
      severity: severities.sort((a, b) => severityRank(b) - severityRank(a))[0] ?? "moderate",
      severityDefaulted: severities.length === 0,
      malicious: isMalicious(allIds),
      published: fetched.map((record) => record.published).filter((date): date is string => !!date).sort()[0],
      // Every record must name a fix; the group is fixed by the highest of them.
      fixedIn: fixes.length === members.length && fixes.every(Boolean) ? (fixes as string[]).sort(semver.rcompare)[0] : undefined,
      detailsMissing: fetched.length < members.length,
    };
  });
};

/** Checks every package version against OSV. Failures are reported per package as "not checked", never as clean. */
export const checkAdvisories = async (fetcher: Fetcher, packages: PackageVersion[]): Promise<AdvisoryCheck> => {
  const unique = [...new Map(packages.map((item) => [packageKey(item), item])).values()];
  const notChecked = new Map<string, string>();
  const ids = await queryIds(fetcher, unique, notChecked);
  const allIds = [...new Set([...ids.values()].flat())].sort();
  const records = await fetchRecords(fetcher, allIds);
  const advisories = new Map<string, AdvisoryGroup[]>();
  for (const item of unique) {
    const found = ids.get(packageKey(item));
    if (found) advisories.set(packageKey(item), groupAdvisories(item, [...new Set(found)], records));
  }
  return {
    advisories,
    notChecked,
    detailsMissing: allIds.filter((id) => records.get(id) instanceof Error),
  };
};
