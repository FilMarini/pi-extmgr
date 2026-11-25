import assert from "node:assert/strict";
import test from "node:test";
import { applyModelRules, matchesModel, parseModelRules } from "../src/extensions/model-rules.js";

test("model matching is anchored and treats punctuation literally", () => {
  assert.ok(matchesModel("anthropic/claude-*", "anthropic/claude-sonnet-4"));
  assert.ok(!matchesModel("a/model.1", "a/modelx1"));
  assert.ok(!matchesModel("a/model", "b/a/model"));
});

test("validates rules before changes", () => {
  assert.throws(() => parseModelRules({ version: 2, rules: [] }));
  assert.throws(() =>
    parseModelRules({
      version: 1,
      rules: [
        {
          model: "a/b",
          disable: [{ scope: "global", package: "npm:pi-extmgr", extensions: ["**"] }],
        },
      ],
    })
  );
  assert.throws(() =>
    parseModelRules({
      version: 1,
      rules: [{ model: "a/b", disable: [{ scope: "global", path: "!foo" }] }],
    })
  );
});

test("local rules preserve manual exclusions and restore absent filters", () => {
  const initial = { extensions: ["-manual.ts"], unrelated: true };
  const target = { scope: "global" as const, path: "extensions/test.ts" };
  const disabled = applyModelRules(initial, [target], "/agent");
  assert.deepEqual(disabled.extensions, ["-manual.ts", "-/agent/extensions/test.ts"]);
  assert.deepEqual(applyModelRules(disabled, [], "/agent"), initial);
  assert.deepEqual(initial.extensions, ["-manual.ts"]);
  const empty = applyModelRules({}, [target], "/agent");
  assert.deepEqual(applyModelRules(empty, [], "/agent"), {});
  assert.deepEqual(applyModelRules(disabled, [target], "/agent"), disabled);
});

test("package rules preserve filters, skills and manual changes", () => {
  const initial = {
    packages: [
      { source: "npm:tools", extensions: ["extensions/**", "!extensions/manual.ts"], skills: [] },
    ],
  };
  const target = {
    scope: "global" as const,
    package: "npm:tools",
    extensions: ["extensions/one.ts"],
  };
  const disabled = applyModelRules(initial, [target], "/agent");
  assert.deepEqual(applyModelRules(disabled, [], "/agent"), initial);
  assert.throws(() => applyModelRules({}, [target], "/agent"));
  const alreadyDisabled = { packages: [{ source: "npm:tools", extensions: [] }] };
  assert.deepEqual(applyModelRules(alreadyDisabled, [target], "/agent"), alreadyDisabled);
  const unrestricted = applyModelRules({ packages: ["npm:tools"] }, [target], "/agent");
  assert.deepEqual(applyModelRules(unrestricted, [], "/agent"), {
    packages: [{ source: "npm:tools" }],
  });
});
