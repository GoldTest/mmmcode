import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "snapshot.mjs");
const USAGE = /usage: node snapshot\.mjs/;
const NO_BROWSER = /Playwright is not installed|Executable doesn't exist/;

const page = `<!doctype html><html><head><meta charset="utf-8">` + `<style>body{margin:0;background:#141415;color:#ededed}.card{padding:24px}</style>` + `</head><body><div class="card"><h1>Hello</h1></div></body></html>`;

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "unslop-snapshot-"));
  const file = join(dir, "page.html");
  writeFileSync(file, page);
  return { dir, file };
};

const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 60_000 });

// A run that needs a real browser: skip instead of failing when this
// machine has no Playwright or Chromium to launch. Returns true when it
// skipped, so the test must return right after calling it — t.skip() marks
// the test skipped but does not stop the test function.
const skipIfNoBrowser = (t, result) => {
  if (NO_BROWSER.test(result.stderr ?? "")) {
    t.skip("Playwright or Chromium is not installed here");
    return true;
  }
  return false;
};

const pngSize = (file) => {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

test("no arguments prints the usage and exits 1", () => {
  const result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, USAGE);
});

const badSizes = [
  ["--width=abc", "a non-number width"],
  ["--width=0", "a zero width"],
  ["--width=-5", "a negative width"],
  ["--width=1.5", "a fractional width"],
  ["--height=abc", "a non-number height"],
  ["--height=0", "a zero height"],
];

for (const [flag, label] of badSizes) {
  test(`${label} (${flag}) fails with a clear error, not a stack trace`, () => {
    const { file } = fixture();
    const result = run([`file://${file}`, "out.html", flag]);
    assert.equal(result.status, 1, `expected a fast failure, got status ${result.status}`);
    assert.match(result.stderr, /must be a whole number above 0/);
    assert.doesNotMatch(result.stderr, /browser\.newPage/);
  });
}

test("--width with no value fails with a clear error", () => {
  const { file } = fixture();
  const result = run([`file://${file}`, "out.html", "--width"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--width needs a value/);
});

test("a local file path is snapshotted, not rejected as an invalid URL", (t) => {
  const { dir, file } = fixture();
  const out = join(dir, "out.html");
  const result = run([file, out]);
  if (skipIfNoBrowser(t, result)) return;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(out), "saved html is missing");
  assert.ok(existsSync(join(dir, "out.live.png")), "live screenshot is missing");
  assert.deepEqual(pngSize(join(dir, "out.live.png")), { width: 1440, height: 810 });
});

test("--width 800 in space form sets the viewport to 800 wide", (t) => {
  const { dir, file } = fixture();
  const out = join(dir, "out.html");
  const result = run([`file://${file}`, out, "--width", "800"]);
  if (skipIfNoBrowser(t, result)) return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /saved .*out\.html\n?$/);
  assert.doesNotMatch(result.stdout, /as 800/, "800 leaked into the pass label instead of the width");
  assert.deepEqual(pngSize(join(dir, "out.live.png")), { width: 800, height: 810 });
});

test("--width=800 in equals form still sets the viewport to 800 wide", (t) => {
  const { dir, file } = fixture();
  const out = join(dir, "out.html");
  const result = run([`file://${file}`, out, "--width=800"]);
  if (skipIfNoBrowser(t, result)) return;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(pngSize(join(dir, "out.live.png")), { width: 800, height: 810 });
});

test("--height 600 in space form sets the viewport height", (t) => {
  const { dir, file } = fixture();
  const out = join(dir, "out.html");
  const result = run([`file://${file}`, out, "--height", "600"]);
  if (skipIfNoBrowser(t, result)) return;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(pngSize(join(dir, "out.live.png")), { width: 1440, height: 600 });
});
