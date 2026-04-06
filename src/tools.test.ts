import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureDb, closeDb, getDb, getProjectProcesses } from "./db.js";
import { setProjectRoot, bgRun, bgList, bgCleanup } from "./tools.js";

// Use a unique temp dir per run to avoid collisions
const TEST_DIR = join(tmpdir(), `bg-manager-test-${Date.now()}`);
const TEST_SUBDIR = join(TEST_DIR, "subdir");

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_SUBDIR, { recursive: true });
  ensureDb();
  setProjectRoot(TEST_DIR);
});

afterAll(() => {
  closeDb();
  // Clean up temp dirs
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// Clean up processes between tests
beforeEach(() => {
  bgCleanup();
});

// ── working_dir ─────────────────────────────────────────────────

describe("bg_run working_dir", () => {
  it("accepts absolute working_dir", () => {
    const result = bgRun("wd-abs", 'node -e "console.log(process.cwd())"', "test cwd", undefined, TEST_SUBDIR);
    expect(result).toContain('Started "wd-abs"');
    expect(result).toContain(`CWD: ${TEST_SUBDIR}`);
  });

  it("rejects relative working_dir", () => {
    const result = bgRun("wd-rel", "node -e 1", "test", undefined, "relative/path");
    expect(result).toContain("Error: working_dir must be an absolute path");
  });

  it("rejects non-existent working_dir", () => {
    const result = bgRun("wd-noexist", "node -e 1", "test", undefined, join(TEST_DIR, "nonexistent"));
    expect(result).toContain("does not exist");
  });

  it("rejects file as working_dir", () => {
    const filePath = join(TEST_DIR, "afile.txt");
    writeFileSync(filePath, "hello");
    const result = bgRun("wd-file", "node -e 1", "test", undefined, filePath);
    expect(result).toContain("is not a directory");
  });

  it("defaults to project root when working_dir omitted", () => {
    const result = bgRun("wd-default", 'node -e "console.log(1)"', "test");
    expect(result).toContain('Started "wd-default"');
    // No CWD line when using default
    expect(result).not.toContain("CWD:");
  });

  it("stores working_dir as cwd in database", () => {
    bgRun("wd-db", 'node -e "console.log(1)"', "test", undefined, TEST_SUBDIR);
    const rows = getProjectProcesses(
      TEST_DIR.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    );
    const entry = rows.find(r => r.name === "wd-db");
    expect(entry).toBeDefined();
    expect(entry!.cwd).toBe(TEST_SUBDIR);
  });
});

// ── env ─────────────────────────────────────────────────────────

describe("bg_run env", () => {
  it("accepts env vars and shows keys in output", () => {
    const result = bgRun("env-basic", 'node -e "console.log(1)"', "test", undefined, undefined, { MY_VAR: "hello", OTHER: "world" });
    expect(result).toContain('Started "env-basic"');
    expect(result).toContain("Env: MY_VAR, OTHER");
  });

  it("stores env as JSON in database", () => {
    const env = { FOO: "bar", BAZ: "123" };
    bgRun("env-db", 'node -e "console.log(1)"', "test", undefined, undefined, env);
    const rows = getProjectProcesses(
      TEST_DIR.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    );
    const entry = rows.find(r => r.name === "env-db");
    expect(entry).toBeDefined();
    expect(entry!.env_vars).toBe(JSON.stringify(env));
  });

  it("stores null env_vars when env is omitted", () => {
    bgRun("env-null", 'node -e "console.log(1)"', "test");
    const rows = getProjectProcesses(
      TEST_DIR.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    );
    const entry = rows.find(r => r.name === "env-null");
    expect(entry).toBeDefined();
    expect(entry!.env_vars).toBeNull();
  });

  it("stores null env_vars when env is empty object", () => {
    bgRun("env-empty", 'node -e "console.log(1)"', "test", undefined, undefined, {});
    const rows = getProjectProcesses(
      TEST_DIR.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    );
    const entry = rows.find(r => r.name === "env-empty");
    expect(entry).toBeDefined();
    expect(entry!.env_vars).toBeNull();
  });

  it("does not show Env line when env omitted", () => {
    const result = bgRun("env-no-line", 'node -e "console.log(1)"', "test");
    expect(result).not.toContain("Env:");
  });
});

// ── working_dir + env combined ──────────────────────────────────

describe("bg_run working_dir + env combined", () => {
  it("accepts both working_dir and env", () => {
    const result = bgRun("combo", 'node -e "console.log(1)"', "test", undefined, TEST_SUBDIR, { PORT: "3000" });
    expect(result).toContain(`CWD: ${TEST_SUBDIR}`);
    expect(result).toContain("Env: PORT");
  });

  it("stores both in database", () => {
    const env = { NODE_ENV: "test" };
    bgRun("combo-db", 'node -e "console.log(1)"', "test", undefined, TEST_SUBDIR, env);
    const rows = getProjectProcesses(
      TEST_DIR.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    );
    const entry = rows.find(r => r.name === "combo-db");
    expect(entry).toBeDefined();
    expect(entry!.cwd).toBe(TEST_SUBDIR);
    expect(entry!.env_vars).toBe(JSON.stringify(env));
  });
});

// ── bg_list output ──────────────────────────────────────────────

describe("bg_list with working_dir and env", () => {
  it("shows CWD in list when non-default", () => {
    bgRun("list-cwd", 'node -e "console.log(1)"', "test", undefined, TEST_SUBDIR);
    const list = bgList();
    expect(list).toContain(`CWD:     ${TEST_SUBDIR}`);
  });

  it("shows Env keys in list when env set", () => {
    bgRun("list-env", 'node -e "console.log(1)"', "test", undefined, undefined, { API_KEY: "secret" });
    const list = bgList();
    expect(list).toContain("Env:     API_KEY");
  });

  it("does not show CWD line when using default dir", () => {
    bgRun("list-default", 'node -e "console.log(1)"', "test");
    const list = bgList();
    // The entry for list-default should not have CWD line
    const lines = list.split("\n\n");
    const entry = lines.find(l => l.includes("list-default"));
    expect(entry).toBeDefined();
    expect(entry).not.toContain("CWD:");
  });

  it("throws on corrupted env_vars JSON", () => {
    bgRun("list-bad", 'node -e "console.log(1)"', "test");
    // Manually corrupt the env_vars in DB
    const project = TEST_DIR.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    getDb().prepare("UPDATE processes SET env_vars = ? WHERE project = ? AND name = ?")
      .run("{invalid json", project, "list-bad");

    expect(() => bgList()).toThrow(/Corrupted env_vars.*list-bad/);

    // Clean up corrupted entry so it doesn't leak into other tests
    getDb().prepare("DELETE FROM processes WHERE project = ? AND name = ?")
      .run(project, "list-bad");
  });
});

// ── backward compatibility ──────────────────────────────────────

describe("backward compatibility", () => {
  it("old-style cd && command still works", () => {
    const result = bgRun("compat", `node -e "console.log('hello')"`, "test compat");
    expect(result).toContain('Started "compat"');
  });

  it("null env_vars in DB is handled gracefully in list", () => {
    bgRun("compat-null", 'node -e "console.log(1)"', "test");
    const list = bgList();
    const entry = list.split("\n\n").find(l => l.includes("compat-null"));
    expect(entry).toBeDefined();
    expect(entry).not.toContain("Env:");
  });
});
