export const TUNEWEAVE_REQUIRED_VERSION = "1.0.0-beta.3"

export function compareTuneWeaveVersions(left: unknown, right: unknown) {
  const parse = (value: unknown) => {
    const match = typeof value === "string" && value.length <= 128
      ? /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value)
      : null
    const pre = match?.[4]?.split(".")
    if (!match || match[0] !== value || pre?.some(identifier => /^0[0-9]+$/u.test(identifier))) throw new Error("无法识别 TuneWeave 版本。")
    return { numbers: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)] as const, pre }
  }
  const a = parse(left), b = parse(right)
  for (const i of [0, 1, 2] as const) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] < b.numbers[i] ? -1 : 1
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}
