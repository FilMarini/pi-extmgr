import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "../utils/mode.js";

type Target = {
  scope: "global" | "project";
  path?: string;
  package?: string;
  extensions?: string[];
};
type Rule = { model: string; disable: Target[] };
type ObjectValue = Record<string, unknown>;
const OWNER = "piExtmgrModelExclusions";
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
function readObject(path: string): ObjectValue {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!object(value)) throw new Error(`Expected an object in ${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function parseModelRules(value: unknown): Rule[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.rules)) {
    throw new Error("Model rules require version: 1 and a rules array");
  }
  for (const rule of value.rules) {
    if (
      !object(rule) ||
      typeof rule.model !== "string" ||
      !rule.model.includes("/") ||
      !Array.isArray(rule.disable)
    ) {
      throw new Error("Each rule requires model: provider/model-id and disable: []");
    }
    for (const target of rule.disable) {
      if (
        !object(target) ||
        !["global", "project"].includes(String(target.scope)) ||
        (typeof target.path === "string") === (typeof target.package === "string")
      ) {
        throw new Error("Targets require scope and exactly one of path or package");
      }
      if (typeof target.path === "string" && (!target.path.trim() || /^[!+-]/.test(target.path))) {
        throw new Error("Local targets must be paths, not filter expressions");
      }
      if (
        typeof target.package === "string" &&
        (!target.package.trim() ||
          !strings(target.extensions) ||
          !target.extensions.length ||
          target.extensions.some((p) => !p || /^[!+-]/.test(p)))
      ) {
        throw new Error("Package targets require a nonempty extensions array of paths or globs");
      }
      if (
        typeof target.package === "string" &&
        /(?:^|[:/])pi-extmgr(?:\.git)?(?:@|$)/.test(target.package)
      ) {
        throw new Error("Model rules cannot disable pi-extmgr");
      }
    }
  }
  return value.rules as Rule[];
}

/** Only '*' is special; provider and model IDs otherwise match literally. */
export function matchesModel(pattern: string, model: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(model);
}

function exclusions(holder: ObjectValue, desired: string[], emptyMeansDisabled = false): void {
  const old = holder[OWNER] ?? [];
  const entries = holder.extensions ?? [];
  if (!strings(old) || !strings(entries))
    throw new Error("Invalid extension filters or model exclusion ownership");
  // An explicit empty package filter means disabled, not unrestricted.
  if (
    emptyMeansDisabled &&
    Array.isArray(holder.extensions) &&
    entries.length === 0 &&
    old.length === 0
  )
    return;
  const baseline = entries.filter((entry) => !old.includes(entry));
  const added = [...new Set(desired)].filter((entry) => !baseline.includes(entry));
  const hadExtensions = old.length
    ? holder.piExtmgrModelHadExtensions
    : holder.extensions !== undefined;
  if (old.length && typeof hadExtensions !== "boolean")
    throw new Error("Invalid model filter snapshot");
  if (added.length || old.length) holder.extensions = [...baseline, ...added];
  if (added.length) {
    holder[OWNER] = added;
    holder.piExtmgrModelHadExtensions = hadExtensions;
  } else {
    if (old.length && !hadExtensions && !baseline.length) delete holder.extensions;
    delete holder[OWNER];
    delete holder.piExtmgrModelHadExtensions;
  }
}

export function applyModelRules(
  settings: ObjectValue,
  targets: Target[],
  base: string
): ObjectValue {
  const result = structuredClone(settings);
  const local = targets
    .filter((t) => t.path)
    .map((t) => {
      const path = t.path?.replace(/^~\//, `${homedir()}/`) ?? "";
      const absolute = resolve(base, path);
      let canonical = absolute;
      try {
        canonical = realpathSync(absolute);
      } catch {
        // A missing path cannot load.
      }
      const self = realpathSync(SELF);
      if (canonical === self || self.startsWith(`${canonical}/`))
        throw new Error("Model rules cannot disable pi-extmgr");
      return `-${absolute}`;
    });
  exclusions(result, local);
  if (result.packages !== undefined && !Array.isArray(result.packages))
    throw new Error("Invalid packages setting");
  const packages = (result.packages ?? []) as unknown[];
  const found = new Set<string>();
  result.packages = packages.map((entry) => {
    const source = typeof entry === "string" ? entry : object(entry) ? entry.source : undefined;
    const selected = targets.filter((t) => t.package === source);
    if (typeof source === "string") found.add(source);
    if (!selected.length && (!object(entry) || !(OWNER in entry))) return entry;
    const pkg: ObjectValue =
      typeof entry === "string" ? { source: entry } : { ...(entry as ObjectValue) };
    exclusions(
      pkg,
      selected.flatMap((t) =>
        (t.extensions ?? []).map((p) => `${/[?*[{]/.test(p) ? "!" : "-"}${p}`)
      ),
      true
    );
    return pkg;
  });
  for (const target of targets) {
    if (target.package && !found.has(target.package))
      throw new Error(`Package not configured in this scope: ${target.package}`);
  }
  if (settings.packages === undefined) delete result.packages;
  return result;
}

export function registerModelRules(pi: ExtensionAPI): void {
  let pending = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let live = true;
  const dispatch = (ctx: ExtensionContext) => {
    if (!live || !pending || queued || !ctx.isIdle()) return;
    queued = true;
    pi.sendUserMessage("/extmgr-model-reload", { expandPromptTemplates: true });
  };
  const schedule = (ctx: ExtensionContext) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => dispatch(ctx), 0);
  };
  const reconcile = (ctx: ExtensionContext) => {
    if (!ctx.model) return;
    try {
      const agentDir = getAgentDir();
      const config = readObject(join(agentDir, "extmgr-models.json"));
      const rules = Object.keys(config).length ? parseModelRules(config) : [];
      const targets = rules
        .filter((r) => matchesModel(r.model, `${ctx.model?.provider}/${ctx.model?.id}`))
        .flatMap((r) => r.disable);
      const scopes = [
        { scope: "global", base: agentDir },
        ...(isProjectTrusted(ctx) ? [{ scope: "project", base: join(ctx.cwd, ".pi") }] : []),
      ];
      // Validate every scope before writing anything.
      const plans = scopes.map(({ scope, base }) => {
        const path = join(base, "settings.json");
        const before = readObject(path);
        const after = applyModelRules(
          before,
          targets.filter((t) => t.scope === scope),
          base
        );
        return { path, before, after };
      });
      for (const { path, before, after } of plans) {
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const temp = `${path}.extmgr-${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(after, null, 2)}\n`, { mode: 0o600 });
        renameSync(temp, path);
        pending = true;
      }
      if (pending) schedule(ctx);
    } catch (error) {
      ctx.ui.notify(
        `Model extension rules: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  };
  pi.registerCommand("extmgr-model-reload", {
    description: "Apply pending model-specific extension changes",
    handler: async (_args, ctx) => {
      queued = false;
      if (!pending || !ctx.isIdle()) return;
      pending = false;
      await ctx.reload();
    },
  });
  pi.on("session_start", (_event, ctx) => reconcile(ctx));
  pi.on("model_select", (_event, ctx) => reconcile(ctx));
  pi.on("agent_settled", (_event, ctx) => dispatch(ctx));
  pi.on("session_compact", (_event, ctx) => schedule(ctx));
  pi.on("session_compact_failed", (_event, ctx) => schedule(ctx));
  pi.on("session_shutdown", () => {
    live = false;
    if (timer) clearTimeout(timer);
  });
}
