// Tests ported from the Rust `semver` crate, version 1.0.28: tests/test_version.rs,
// tests/test_version_req.rs, tests/test_identifier.rs (tests/util/mod.rs supplies the helpers).
// The crate has no inline #[cfg(test)] modules. tests/test_autotrait.rs (Send + Sync) has no
// TypeScript equivalent and is not ported.
import { describe, expect, it } from "vitest";
import {
  BuildMetadata,
  Comparator,
  Prerelease,
  SemverError,
  Version,
  VersionReq,
} from "../../src/core/semver.ts";

// tests/util/mod.rs

function version(text: string): Version {
  return Version.parse(text);
}

function catchError(f: () => unknown): SemverError {
  try {
    f();
  } catch (err) {
    if (err instanceof SemverError) {
      return err;
    }
    throw err;
  }
  throw new Error("expected a SemverError, got Ok");
}

function versionErr(text: string): SemverError {
  return catchError(() => Version.parse(text));
}

function req(text: string): VersionReq {
  return VersionReq.parse(text);
}

function reqErr(text: string): SemverError {
  return catchError(() => VersionReq.parse(text));
}

function comparator(text: string): Comparator {
  return Comparator.parse(text);
}

function comparatorErr(text: string): SemverError {
  return catchError(() => Comparator.parse(text));
}

function prerelease(text: string): Prerelease {
  return Prerelease.new(text);
}

function prereleaseErr(text: string): SemverError {
  return catchError(() => Prerelease.new(text));
}

function buildMetadata(text: string): BuildMetadata {
  return BuildMetadata.new(text);
}

function assertToString(value: { toString(): string } | SemverError, expected: string): void {
  const actual = value instanceof SemverError ? value.message : value.toString();
  expect(actual).toBe(expected);
}

const lt = (a: Version, b: Version) => Version.compare(a, b) < 0;
const le = (a: Version, b: Version) => Version.compare(a, b) <= 0;
const gt = (a: Version, b: Version) => Version.compare(a, b) > 0;
const ge = (a: Version, b: Version) => Version.compare(a, b) >= 0;

function assertVersionEq(a: Version, b: Version): void {
  expect(a.equals(b), `${a} == ${b}`).toBe(true);
}

function assertVersionNe(a: Version, b: Version): void {
  expect(a.equals(b), `${a} != ${b}`).toBe(false);
}

// tests/test_version.rs

describe("test_version", () => {
  it("test_parse", () => {
    let err = versionErr("");
    assertToString(err, "empty string, expected a semver version");

    err = versionErr("  ");
    assertToString(err, "unexpected character ' ' while parsing major version number");

    err = versionErr("1");
    assertToString(err, "unexpected end of input while parsing major version number");

    err = versionErr("1.2");
    assertToString(err, "unexpected end of input while parsing minor version number");

    err = versionErr("1.2.3-");
    assertToString(err, "empty identifier segment in pre-release identifier");

    err = versionErr("a.b.c");
    assertToString(err, "unexpected character 'a' while parsing major version number");

    err = versionErr("1.2.3 abc");
    assertToString(err, "unexpected character ' ' after patch version number");

    err = versionErr("1.2.3-01");
    assertToString(err, "invalid leading zero in pre-release identifier");

    err = versionErr("1.2.3++");
    assertToString(err, "empty identifier segment in build metadata");

    err = versionErr("07");
    assertToString(err, "invalid leading zero in major version number");

    err = versionErr("111111111111111111111.0.0");
    assertToString(err, "value of major version number exceeds u64::MAX");

    err = versionErr("8\0");
    assertToString(err, "unexpected character '\\0' after major version number");

    let parsed = version("1.2.3");
    let expected = new Version(1n, 2n, 3n);
    assertVersionEq(parsed, expected);
    expected = new Version(1n, 2n, 3n, Prerelease.EMPTY, BuildMetadata.EMPTY);
    assertVersionEq(parsed, expected);

    parsed = version("1.2.3-alpha1");
    expected = new Version(1n, 2n, 3n, prerelease("alpha1"), BuildMetadata.EMPTY);
    assertVersionEq(parsed, expected);

    parsed = version("1.2.3+build5");
    expected = new Version(1n, 2n, 3n, Prerelease.EMPTY, buildMetadata("build5"));
    assertVersionEq(parsed, expected);

    parsed = version("1.2.3+5build");
    expected = new Version(1n, 2n, 3n, Prerelease.EMPTY, buildMetadata("5build"));
    assertVersionEq(parsed, expected);

    parsed = version("1.2.3-alpha1+build5");
    expected = new Version(1n, 2n, 3n, prerelease("alpha1"), buildMetadata("build5"));
    assertVersionEq(parsed, expected);

    parsed = version("1.2.3-1.alpha1.9+build5.7.3aedf");
    expected = new Version(1n, 2n, 3n, prerelease("1.alpha1.9"), buildMetadata("build5.7.3aedf"));
    assertVersionEq(parsed, expected);

    parsed = version("1.2.3-0a.alpha1.9+05build.7.3aedf");
    expected = new Version(1n, 2n, 3n, prerelease("0a.alpha1.9"), buildMetadata("05build.7.3aedf"));
    assertVersionEq(parsed, expected);

    parsed = version("0.4.0-beta.1+0851523");
    expected = new Version(0n, 4n, 0n, prerelease("beta.1"), buildMetadata("0851523"));
    assertVersionEq(parsed, expected);

    // for https://nodejs.org/dist/index.json, where some older npm versions are "1.1.0-beta-10"
    parsed = version("1.1.0-beta-10");
    expected = new Version(1n, 1n, 0n, prerelease("beta-10"), BuildMetadata.EMPTY);
    assertVersionEq(parsed, expected);
  });

  it("test_eq", () => {
    assertVersionEq(version("1.2.3"), version("1.2.3"));
    assertVersionEq(version("1.2.3-alpha1"), version("1.2.3-alpha1"));
    assertVersionEq(version("1.2.3+build.42"), version("1.2.3+build.42"));
    assertVersionEq(version("1.2.3-alpha1+42"), version("1.2.3-alpha1+42"));
  });

  it("test_ne", () => {
    assertVersionNe(version("0.0.0"), version("0.0.1"));
    assertVersionNe(version("0.0.0"), version("0.1.0"));
    assertVersionNe(version("0.0.0"), version("1.0.0"));
    assertVersionNe(version("1.2.3-alpha"), version("1.2.3-beta"));
    assertVersionNe(version("1.2.3+23"), version("1.2.3+42"));
  });

  it("test_display", () => {
    assertToString(version("1.2.3"), "1.2.3");
    assertToString(version("1.2.3-alpha1"), "1.2.3-alpha1");
    assertToString(version("1.2.3+build.42"), "1.2.3+build.42");
    assertToString(version("1.2.3-alpha1+42"), "1.2.3-alpha1+42");
  });

  it("test_lt", () => {
    expect(lt(version("0.0.0"), version("1.2.3-alpha2"))).toBe(true);
    expect(lt(version("1.0.0"), version("1.2.3-alpha2"))).toBe(true);
    expect(lt(version("1.2.0"), version("1.2.3-alpha2"))).toBe(true);
    expect(lt(version("1.2.3-alpha1"), version("1.2.3"))).toBe(true);
    expect(lt(version("1.2.3-alpha1"), version("1.2.3-alpha2"))).toBe(true);
    expect(!lt(version("1.2.3-alpha2"), version("1.2.3-alpha2"))).toBe(true);
    expect(lt(version("1.2.3+23"), version("1.2.3+42"))).toBe(true);
  });

  it("test_le", () => {
    expect(le(version("0.0.0"), version("1.2.3-alpha2"))).toBe(true);
    expect(le(version("1.0.0"), version("1.2.3-alpha2"))).toBe(true);
    expect(le(version("1.2.0"), version("1.2.3-alpha2"))).toBe(true);
    expect(le(version("1.2.3-alpha1"), version("1.2.3-alpha2"))).toBe(true);
    expect(le(version("1.2.3-alpha2"), version("1.2.3-alpha2"))).toBe(true);
    expect(le(version("1.2.3+23"), version("1.2.3+42"))).toBe(true);
  });

  it("test_gt", () => {
    expect(gt(version("1.2.3-alpha2"), version("0.0.0"))).toBe(true);
    expect(gt(version("1.2.3-alpha2"), version("1.0.0"))).toBe(true);
    expect(gt(version("1.2.3-alpha2"), version("1.2.0"))).toBe(true);
    expect(gt(version("1.2.3-alpha2"), version("1.2.3-alpha1"))).toBe(true);
    expect(gt(version("1.2.3"), version("1.2.3-alpha2"))).toBe(true);
    expect(!gt(version("1.2.3-alpha2"), version("1.2.3-alpha2"))).toBe(true);
    expect(!gt(version("1.2.3+23"), version("1.2.3+42"))).toBe(true);
  });

  it("test_ge", () => {
    expect(ge(version("1.2.3-alpha2"), version("0.0.0"))).toBe(true);
    expect(ge(version("1.2.3-alpha2"), version("1.0.0"))).toBe(true);
    expect(ge(version("1.2.3-alpha2"), version("1.2.0"))).toBe(true);
    expect(ge(version("1.2.3-alpha2"), version("1.2.3-alpha1"))).toBe(true);
    expect(ge(version("1.2.3-alpha2"), version("1.2.3-alpha2"))).toBe(true);
    expect(!ge(version("1.2.3+23"), version("1.2.3+42"))).toBe(true);
  });

  it("test_spec_order", () => {
    const vs = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    let i = 1;
    while (i < vs.length) {
      const a = version(vs[i - 1]!);
      const b = version(vs[i]!);
      expect(lt(a, b), `nope ${a} < ${b}`).toBe(true);
      i += 1;
    }
  });

  it("test_align", () => {
    const v = version("1.2.3-rc1");
    expect(v.toString({ width: 20 })).toBe("1.2.3-rc1           ");
    expect(v.toString({ width: 20, align: "^", fill: "*" })).toBe("*****1.2.3-rc1******");
    expect(v.toString({ width: 20, align: ">" })).toBe("           1.2.3-rc1");
  });
});

// tests/test_version_req.rs

function assertMatchAll(r: VersionReq, versions: string[]): void {
  for (const string of versions) {
    const parsed = version(string);
    expect(r.matches(parsed), `did not match ${string}`).toBe(true);
  }
}

function assertMatchNone(r: VersionReq, versions: string[]): void {
  for (const string of versions) {
    const parsed = version(string);
    expect(r.matches(parsed), `matched ${string}`).toBe(false);
  }
}

function assertReqEq(a: VersionReq, b: VersionReq): void {
  expect(a.equals(b), `${a} == ${b}`).toBe(true);
}

describe("test_version_req", () => {
  it("test_basic", () => {
    const r = req("1.0.0");
    assertToString(r, "^1.0.0");
    assertMatchAll(r, ["1.0.0", "1.1.0", "1.0.1"]);
    assertMatchNone(r, ["0.9.9", "0.10.0", "0.1.0", "1.0.0-pre", "1.0.1-pre"]);
  });

  it("test_default", () => {
    const r = new VersionReq();
    assertReqEq(r, VersionReq.STAR);
  });

  it("test_exact", () => {
    let r = req("=1.0.0");
    assertToString(r, "=1.0.0");
    assertMatchAll(r, ["1.0.0"]);
    assertMatchNone(r, ["1.0.1", "0.9.9", "0.10.0", "0.1.0", "1.0.0-pre"]);

    r = req("=0.9.0");
    assertToString(r, "=0.9.0");
    assertMatchAll(r, ["0.9.0"]);
    assertMatchNone(r, ["0.9.1", "1.9.0", "0.0.9", "0.9.0-pre"]);

    r = req("=0.0.2");
    assertToString(r, "=0.0.2");
    assertMatchAll(r, ["0.0.2"]);
    assertMatchNone(r, ["0.0.1", "0.0.3", "0.0.2-pre"]);

    r = req("=0.1.0-beta2.a");
    assertToString(r, "=0.1.0-beta2.a");
    assertMatchAll(r, ["0.1.0-beta2.a"]);
    assertMatchNone(r, ["0.9.1", "0.1.0", "0.1.1-beta2.a", "0.1.0-beta2"]);

    r = req("=0.1.0+meta");
    assertToString(r, "=0.1.0");
    assertMatchAll(r, ["0.1.0", "0.1.0+meta", "0.1.0+any"]);
  });

  it("test_greater_than", () => {
    let r = req(">= 1.0.0");
    assertToString(r, ">=1.0.0");
    assertMatchAll(r, ["1.0.0", "2.0.0"]);
    assertMatchNone(r, ["0.1.0", "0.0.1", "1.0.0-pre", "2.0.0-pre"]);

    r = req(">= 2.1.0-alpha2");
    assertToString(r, ">=2.1.0-alpha2");
    assertMatchAll(r, ["2.1.0-alpha2", "2.1.0-alpha3", "2.1.0", "3.0.0"]);
    assertMatchNone(r, ["2.0.0", "2.1.0-alpha1", "2.0.0-alpha2", "3.0.0-alpha2"]);
  });

  it("test_less_than", () => {
    let r = req("< 1.0.0");
    assertToString(r, "<1.0.0");
    assertMatchAll(r, ["0.1.0", "0.0.1"]);
    assertMatchNone(r, ["1.0.0", "1.0.0-beta", "1.0.1", "0.9.9-alpha"]);

    r = req("<= 2.1.0-alpha2");
    assertMatchAll(r, ["2.1.0-alpha2", "2.1.0-alpha1", "2.0.0", "1.0.0"]);
    assertMatchNone(r, ["2.1.0", "2.2.0-alpha1", "2.0.0-alpha2", "1.0.0-alpha2"]);

    r = req(">1.0.0-alpha, <1.0.0");
    assertMatchAll(r, ["1.0.0-beta"]);

    r = req(">1.0.0-alpha, <1.0");
    assertMatchNone(r, ["1.0.0-beta"]);

    r = req(">1.0.0-alpha, <1");
    assertMatchNone(r, ["1.0.0-beta"]);
  });

  it("test_multiple", () => {
    let r = req("> 0.0.9, <= 2.5.3");
    assertToString(r, ">0.0.9, <=2.5.3");
    assertMatchAll(r, ["0.0.10", "1.0.0", "2.5.3"]);
    assertMatchNone(r, ["0.0.8", "2.5.4"]);

    r = req("0.3.0, 0.4.0");
    assertToString(r, "^0.3.0, ^0.4.0");
    assertMatchNone(r, ["0.0.8", "0.3.0", "0.4.0"]);

    r = req("<= 0.2.0, >= 0.5.0");
    assertToString(r, "<=0.2.0, >=0.5.0");
    assertMatchNone(r, ["0.0.8", "0.3.0", "0.5.1"]);

    r = req("0.1.0, 0.1.4, 0.1.6");
    assertToString(r, "^0.1.0, ^0.1.4, ^0.1.6");
    assertMatchAll(r, ["0.1.6", "0.1.9"]);
    assertMatchNone(r, ["0.1.0", "0.1.4", "0.2.0"]);

    let err = reqErr("> 0.1.0,");
    assertToString(err, "unexpected end of input while parsing major version number");

    err = reqErr("> 0.3.0, ,");
    assertToString(err, "unexpected character ',' while parsing major version number");

    r = req(">=0.5.1-alpha3, <0.6");
    assertToString(r, ">=0.5.1-alpha3, <0.6");
    assertMatchAll(r, ["0.5.1-alpha3", "0.5.1-alpha4", "0.5.1-beta", "0.5.1", "0.5.5"]);
    assertMatchNone(r, ["0.5.1-alpha1", "0.5.2-alpha3", "0.5.5-pre", "0.5.0-pre"]);
    assertMatchNone(r, ["0.6.0", "0.6.0-pre"]);

    // https://github.com/steveklabnik/semver/issues/56
    err = reqErr("1.2.3 - 2.3.4");
    assertToString(err, "expected comma after patch version number, found '-'");

    err = reqErr(
      ">1, >2, >3, >4, >5, >6, >7, >8, >9, >10, >11, >12, >13, >14, >15, >16, >17, >18, >19, >20, >21, >22, >23, >24, >25, >26, >27, >28, >29, >30, >31, >32, >33",
    );
    assertToString(err, "excessive number of version comparators");
  });

  it("test_whitespace_delimited_comparator_sets", () => {
    // https://github.com/steveklabnik/semver/issues/55
    const err = reqErr("> 0.0.9 <= 2.5.3");
    assertToString(err, "expected comma after patch version number, found '<'");
  });

  it("test_tilde", () => {
    let r = req("~1");
    assertMatchAll(r, ["1.0.0", "1.0.1", "1.1.1"]);
    assertMatchNone(r, ["0.9.1", "2.9.0", "0.0.9"]);

    r = req("~1.2");
    assertMatchAll(r, ["1.2.0", "1.2.1"]);
    assertMatchNone(r, ["1.1.1", "1.3.0", "0.0.9"]);

    r = req("~1.2.2");
    assertMatchAll(r, ["1.2.2", "1.2.4"]);
    assertMatchNone(r, ["1.2.1", "1.9.0", "1.0.9", "2.0.1", "0.1.3"]);

    r = req("~1.2.3-beta.2");
    assertMatchAll(r, ["1.2.3", "1.2.4", "1.2.3-beta.2", "1.2.3-beta.4"]);
    assertMatchNone(r, ["1.3.3", "1.1.4", "1.2.3-beta.1", "1.2.4-beta.2"]);
  });

  it("test_caret", () => {
    let r = req("^1");
    assertMatchAll(r, ["1.1.2", "1.1.0", "1.2.1", "1.0.1"]);
    assertMatchNone(r, ["0.9.1", "2.9.0", "0.1.4"]);
    assertMatchNone(r, ["1.0.0-beta1", "0.1.0-alpha", "1.0.1-pre"]);

    r = req("^1.1");
    assertMatchAll(r, ["1.1.2", "1.1.0", "1.2.1"]);
    assertMatchNone(r, ["0.9.1", "2.9.0", "1.0.1", "0.1.4"]);

    r = req("^1.1.2");
    assertMatchAll(r, ["1.1.2", "1.1.4", "1.2.1"]);
    assertMatchNone(r, ["0.9.1", "2.9.0", "1.1.1", "0.0.1"]);
    assertMatchNone(r, ["1.1.2-alpha1", "1.1.3-alpha1", "2.9.0-alpha1"]);

    r = req("^0.1.2");
    assertMatchAll(r, ["0.1.2", "0.1.4"]);
    assertMatchNone(r, ["0.9.1", "2.9.0", "1.1.1", "0.0.1"]);
    assertMatchNone(r, ["0.1.2-beta", "0.1.3-alpha", "0.2.0-pre"]);

    r = req("^0.5.1-alpha3");
    assertMatchAll(r, ["0.5.1-alpha3", "0.5.1-alpha4", "0.5.1-beta", "0.5.1", "0.5.5"]);
    assertMatchNone(r, ["0.5.1-alpha1", "0.5.2-alpha3", "0.5.5-pre", "0.5.0-pre", "0.6.0"]);

    r = req("^0.0.2");
    assertMatchAll(r, ["0.0.2"]);
    assertMatchNone(r, ["0.9.1", "2.9.0", "1.1.1", "0.0.1", "0.1.4"]);

    r = req("^0.0");
    assertMatchAll(r, ["0.0.2", "0.0.0"]);
    assertMatchNone(r, ["0.9.1", "2.9.0", "1.1.1", "0.1.4"]);

    r = req("^0");
    assertMatchAll(r, ["0.9.1", "0.0.2", "0.0.0"]);
    assertMatchNone(r, ["2.9.0", "1.1.1"]);

    r = req("^1.4.2-beta.5");
    assertMatchAll(r, ["1.4.2", "1.4.3", "1.4.2-beta.5", "1.4.2-beta.6", "1.4.2-c"]);
    assertMatchNone(r, ["0.9.9", "2.0.0", "1.4.2-alpha", "1.4.2-beta.4", "1.4.3-beta.5"]);
  });

  it("test_wildcard", () => {
    const err = reqErr("");
    assertToString(err, "unexpected end of input while parsing major version number");

    let r = req("*");
    assertMatchAll(r, ["0.9.1", "2.9.0", "0.0.9", "1.0.1", "1.1.1"]);
    assertMatchNone(r, ["1.0.0-pre"]);

    for (const s of ["x", "X"]) {
      assertReqEq(r, req(s));
    }

    r = req("1.*");
    assertMatchAll(r, ["1.2.0", "1.2.1", "1.1.1", "1.3.0"]);
    assertMatchNone(r, ["0.0.9", "1.2.0-pre"]);

    for (const s of ["1.x", "1.X", "1.*.*"]) {
      assertReqEq(r, req(s));
    }

    r = req("1.2.*");
    assertMatchAll(r, ["1.2.0", "1.2.2", "1.2.4"]);
    assertMatchNone(r, ["1.9.0", "1.0.9", "2.0.1", "0.1.3", "1.2.2-pre"]);

    for (const s of ["1.2.x", "1.2.X"]) {
      assertReqEq(r, req(s));
    }
  });

  it("test_logical_or", () => {
    // https://github.com/steveklabnik/semver/issues/57
    let err = reqErr("=1.2.3 || =2.3.4");
    assertToString(err, "expected comma after patch version number, found '|'");

    err = reqErr("1.1 || =1.2.3");
    assertToString(err, "expected comma after minor version number, found '|'");

    err = reqErr("6.* || 8.* || >= 10.*");
    assertToString(err, "expected comma after minor version number, found '|'");
  });

  it("test_any", () => {
    const r = VersionReq.STAR;
    assertMatchAll(r, ["0.0.1", "0.1.0", "1.0.0"]);
  });

  it("test_pre", () => {
    const r = req("=2.1.1-really.0");
    assertMatchAll(r, ["2.1.1-really.0"]);
  });

  it("test_parse", () => {
    let err = reqErr("\0");
    assertToString(err, "unexpected character '\\0' while parsing major version number");

    err = reqErr(">= >= 0.0.2");
    assertToString(err, "unexpected character '>' while parsing major version number");

    err = reqErr(">== 0.0.2");
    assertToString(err, "unexpected character '=' while parsing major version number");

    err = reqErr("a.0.0");
    assertToString(err, "unexpected character 'a' while parsing major version number");

    err = reqErr("1.0.0-");
    assertToString(err, "empty identifier segment in pre-release identifier");

    err = reqErr(">=");
    assertToString(err, "unexpected end of input while parsing major version number");
  });

  it("test_comparator_parse", () => {
    let parsed = comparator("1.2.3-alpha");
    assertToString(parsed, "^1.2.3-alpha");

    parsed = comparator("2.X");
    assertToString(parsed, "2.*");

    parsed = comparator("2");
    assertToString(parsed, "^2");

    parsed = comparator("2.x.x");
    assertToString(parsed, "2.*");

    let err = comparatorErr("1.2.3-01");
    assertToString(err, "invalid leading zero in pre-release identifier");

    err = comparatorErr("1.2.3+4.");
    assertToString(err, "empty identifier segment in build metadata");

    err = comparatorErr(">");
    assertToString(err, "unexpected end of input while parsing major version number");

    err = comparatorErr("1.");
    assertToString(err, "unexpected end of input while parsing minor version number");

    err = comparatorErr("1.*.");
    assertToString(err, "unexpected character after wildcard in version req");

    err = comparatorErr("1.2.3+4ÿ");
    assertToString(err, "unexpected character 'ÿ' after build metadata");
  });

  it("test_cargo3202", () => {
    let r = req("0.*.*");
    assertToString(r, "0.*");
    assertMatchAll(r, ["0.5.0"]);

    r = req("0.0.*");
    assertToString(r, "0.0.*");
  });

  it("test_digit_after_wildcard", () => {
    let err = reqErr("*.1");
    assertToString(err, "unexpected character after wildcard in version req");

    err = reqErr("1.*.1");
    assertToString(err, "unexpected character after wildcard in version req");

    err = reqErr(">=1.*.1");
    assertToString(err, "unexpected character after wildcard in version req");
  });

  // Rust also checks that equal reqs hash equally; there is no Hash in this port, so only the
  // equality half is ported.
  it("test_eq_hash", () => {
    expect(req("^1").equals(req("^1"))).toBe(true);
    expect(!req("^1").equals(req("^2"))).toBe(true);
  });

  it("test_leading_digit_in_pre_and_build", () => {
    for (const op of ["=", ">", ">=", "<", "<=", "~", "^"]) {
      // digit then alpha
      req(`${op} 1.2.3-1a`);
      req(`${op} 1.2.3+1a`);

      // digit then alpha (leading zero)
      req(`${op} 1.2.3-01a`);
      req(`${op} 1.2.3+01`);

      // multiple
      req(`${op} 1.2.3-1+1`);
      req(`${op} 1.2.3-1-1+1-1-1`);
      req(`${op} 1.2.3-1a+1a`);
      req(`${op} 1.2.3-1a-1a+1a-1a-1a`);
    }
  });

  it("test_wildcard_and_another", () => {
    let err = reqErr("*, 0.20.0-any");
    assertToString(err, "wildcard req (*) must be the only comparator in the version req");

    err = reqErr("0.20.0-any, *");
    assertToString(err, "wildcard req (*) must be the only comparator in the version req");

    err = reqErr("0.20.0-any, *, 1.0");
    assertToString(err, "wildcard req (*) must be the only comparator in the version req");
  });
});

// tests/test_identifier.rs

describe("test_identifier", () => {
  it("test_new", () => {
    function test(identifier: Prerelease, expected: string): void {
      expect(identifier.isEmpty()).toBe(expected === "");
      expect(identifier.asStr().length).toBe(expected.length);
      expect(identifier.asStr()).toBe(expected);
      expect(identifier.equals(identifier)).toBe(true);
    }

    let string = "";
    const limit = 280;
    for (let i = 0; i < limit; i++) {
      test(prerelease(string), string);
      string += "1";
    }

    const big = string.repeat(20000);
    test(prerelease(big), big);
  });

  it("test_eq", () => {
    expect(prerelease("-").equals(prerelease("-"))).toBe(true);
    expect(prerelease("a").equals(prerelease("aa"))).toBe(false);
    expect(prerelease("aa").equals(prerelease("a"))).toBe(false);
    expect(prerelease("aaaaaaaaa").equals(prerelease("a"))).toBe(false);
    expect(prerelease("a").equals(prerelease("aaaaaaaaa"))).toBe(false);
    expect(prerelease("aaaaaaaaa").equals(prerelease("bbbbbbbbb"))).toBe(false);
    expect(buildMetadata("1").equals(buildMetadata("001"))).toBe(false);
  });

  it("test_prerelease", () => {
    const err = prereleaseErr("1.b\0");
    assertToString(err, "unexpected character in pre-release identifier");
  });
});
