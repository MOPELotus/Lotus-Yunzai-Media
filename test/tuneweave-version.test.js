import { expect, test } from "bun:test"
import { compareTuneWeaveVersions } from "../services/tuneweave/version.ts"

test("TuneWeave 版本按 SemVer 精确排序，发布号、预发行与构建号语义独立", () => {
  const versions = ["1.0.0-alpha", "1.0.0-beta.3", "v1.0.0-beta.4", "1.0.0-beta.10", "1.0.0-beta.a", "1.0.0-rc.1", "1.0.0"]
  for (let index = 1; index < versions.length; index++) {
    expect(compareTuneWeaveVersions(versions[index - 1], versions[index])).toBe(-1)
    expect(compareTuneWeaveVersions(versions[index], versions[index - 1])).toBe(1)
  }
  expect(compareTuneWeaveVersions("1.0.0-beta.4+linux.x86", "v1.0.0-beta.4+dev")).toBe(0)
  expect(compareTuneWeaveVersions("9007199254740992.0.0", "9007199254740993.0.0")).toBe(-1)
  expect(compareTuneWeaveVersions("1.0.0-beta.9007199254740992", "1.0.0-beta.9007199254740993")).toBe(-1)
})

test("TuneWeave 无效版本拒绝比较，错误回执无需包含服务回包", () => {
  for (const version of [undefined, "latest", "v01.0.0", "1.0.0-beta.04", "1.0.0-beta..4", "1.0.0+build.", "1.0.0\n", "1".repeat(129)]) {
    expect(() => compareTuneWeaveVersions(version, "1.0.0-beta.4")).toThrow(/^无法识别 TuneWeave 版本。$/u)
  }
})
