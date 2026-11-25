import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("custom media text preserves legacy blacklist, QR protocol types and subscription command labels", async () => {
  const fixture = fileURLToPath(new URL("./i18n-controls.fixture.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  expect(JSON.parse(output)).toEqual({ enabled: false, site: "rewritten", qrType: "mobile", qrName: "rewritten", commandLabel: "视频", displayLabel: "rewritten" });
});
