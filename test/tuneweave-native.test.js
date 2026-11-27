import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, copyFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

test("source installs verify their own digest and rebuild only the selected dependency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-tune-native-"))
  const cpu = { platform: "linux", arch: "x64", known: true, system: "glibc:2.39", features: ["sse2"] }
  const version = "1.0.0-beta.4"
  const manifest = { version, api_version: "v1", compatibility_profiles: ["tuneweave-http-v1"], artifacts: [{
    platform: "linux", architecture: "x86_64", download_url: `https://github.com/MOPELotus/TuneWeave/releases/download/v${version}/fixture`,
    verification: { algorithm: "sha256", checksum_url: `https://github.com/MOPELotus/TuneWeave/releases/download/v${version}/fixture.sha256` },
  }] }
  let builds = 0
  const root = join(dir, "instance"), cache = join(dir, "cache"), candidate = join(dir, "candidate")
  await writeFile(candidate, "synthetic-built-binary")
  const service = new TuneWeaveService({ root, nativeCacheRoot: cache, platform: "linux", arch: "x64", cpu: async () => cpu,
    fetch: async () => { throw Error("source path must not download a prebuilt binary") },
    buildNative: async options => { builds++; expect(options.component).toBe("tuneweave"); expect(options.version).toBe(version); return candidate },
  })
  try {
    await mkdir(join(root, "bin"), { recursive: true })
    await writeFile(join(root, "bin", "tuneweave"), "previous-prebuilt")
    expect(await service.verifyInstalled(manifest)).toBe(false)
    expect(builds).toBe(0)
    const release = await service.downloadRelease({ ...manifest, artifacts: [] })
    await mkdir(join(root, "bin"), { recursive: true })
    await copyFile(release.file, join(root, "bin", "tuneweave"))
    expect(await service.verifyInstalled(manifest)).toBe(true)
    expect(builds).toBe(1)
    expect(await service.verifyInstalled({ ...manifest, version: "1.0.0-beta.5" })).toBe(false)
    await writeFile(join(root, "bin", "tuneweave"), "corrupted")
    expect(await service.verifyInstalled(manifest)).toBe(false)
    expect((await readdir(cache)).sort()).toEqual(["modes"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
