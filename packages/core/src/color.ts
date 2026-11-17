/**
 * Colour parsing for the harness-neutral protocol.
 *
 * Mol*'s uniform theme and canvas renderer take a 24-bit `0xRRGGBB` integer.
 * Agents naturally write CSS colours instead (`"red"`, `"#ff0000"`,
 * `"rgb(255, 0, 0)"`), so normalize every accepted form here. The parser is
 * pure and Node-safe: core tests and adapter tool handlers share it without
 * pulling in Mol* or a DOM.
 *
 * @module @gcszhn/mol4agent-core/color
 */

/** Syntax accepted by {@link parseColor}; also used in model-facing errors. */
export const COLOR_SYNTAX =
  'a CSS color name (red, lightgrey), #rgb, #rrggbb, #rrggbbaa, 0xRRGGBB, '
  + 'a bare hex value (B0B0B0), rgb()/rgba(), or a 24-bit integer (16711680)'

/**
 * Parse one agent-supplied colour into a 24-bit `0xRRGGBB` integer.
 *
 * Alpha is accepted syntactically (`#rrggbbaa`, 4-digit hex, `rgba()`) but
 * dropped because Mol* colours and the canvas background are opaque.
 *
 * @throws Error naming the offending value and {@link COLOR_SYNTAX} when the
 *   value is not a recognizable colour.
 */
export function parseColor(value: unknown): number {
  if (typeof value === 'number') return parseNumericColor(value)
  if (typeof value !== 'string') throw invalidColor(value)

  const text = value.trim().toLowerCase()
  if (text.length === 0) throw invalidColor(value)

  const named = CSS_COLOR_NAMES[text]
  if (named !== undefined) return named

  if (text.startsWith('#')) return parseHexDigits(text.slice(1), value)
  if (text.startsWith('0x')) return parseHexDigits(text.slice(2), value)
  if (text.startsWith('rgb')) return parseRgbFunction(text, value)
  if ((text.length === 3 || text.length === 6 || text.length === 8) && /^[0-9a-f]+$/u.test(text)) {
    return parseHexDigits(text, value)
  }
  throw invalidColor(value)
}

/** Render a normalized colour as `#rrggbb` for tool results and logs. */
export function formatColor(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`
}

function parseNumericColor(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw invalidColor(value)
  return value & 0xffffff
}

function parseHexDigits(digits: string, original: unknown): number {
  if (!/^[0-9a-f]+$/u.test(digits)) throw invalidColor(original)
  switch (digits.length) {
    case 3: {
      const [r, g, b] = digits
      return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16)
    }
    case 4: {
      // RGBA shorthand; the alpha nibble is ignored.
      const [r, g, b] = digits
      return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16)
    }
    case 6:
      return Number.parseInt(digits, 16)
    case 8:
      // RRGGBBAA; Mol* colours have no alpha channel.
      return Number.parseInt(digits.slice(0, 6), 16)
    default:
      throw invalidColor(original)
  }
}

function parseRgbFunction(text: string, original: unknown): number {
  const match = /^rgba?\(([^)]*)\)$/u.exec(text)
  if (match === null) throw invalidColor(original)
  const body = match[1]!.trim()
  if (body.length === 0) throw invalidColor(original)

  const slash = body.split('/')
  if (slash.length > 2) throw invalidColor(original)
  const channels = slash[0]!.trim().split(/[,\s]+/u).filter(Boolean)
  if (channels.length !== 3 && channels.length !== 4) throw invalidColor(original)
  if (slash.length === 2 && channels.length !== 3) throw invalidColor(original)

  const [r, g, b] = channels.slice(0, 3).map(channel => parseRgbChannel(channel, original))
  if (channels.length === 4) parseAlpha(channels[3]!, original)
  if (slash.length === 2) parseAlpha(slash[1]!.trim(), original)
  return (r! << 16) | (g! << 8) | b!
}

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u

function parseRgbChannel(channel: string, original: unknown): number {
  const percent = channel.endsWith('%')
  const value = parseNumber(percent ? channel.slice(0, -1) : channel)
  if (value === undefined) throw invalidColor(original)
  const channelValue = percent ? (value / 100) * 255 : value
  return Math.max(0, Math.min(255, Math.round(channelValue)))
}

function parseAlpha(alpha: string, original: unknown): void {
  const percent = alpha.endsWith('%')
  if (parseNumber(percent ? alpha.slice(0, -1) : alpha) === undefined) throw invalidColor(original)
}

function parseNumber(text: string): number | undefined {
  if (!NUMBER_PATTERN.test(text)) return undefined
  return Number(text)
}

function invalidColor(value: unknown): Error {
  const shown = typeof value === 'string' ? JSON.stringify(value) : String(value)
  return new Error(`invalid color ${shown}; accepted: ${COLOR_SYNTAX}`)
}

/** CSS Color 4 named colours (the 148-name X11/CSS table). */
const CSS_COLOR_NAMES: Readonly<Record<string, number>> = {
  aliceblue: 0xf0f8ff,
  antiquewhite: 0xfaebd7,
  aqua: 0x00ffff,
  aquamarine: 0x7fffd4,
  azure: 0xf0ffff,
  beige: 0xf5f5dc,
  bisque: 0xffe4c4,
  black: 0x000000,
  blanchedalmond: 0xffebcd,
  blue: 0x0000ff,
  blueviolet: 0x8a2be2,
  brown: 0xa52a2a,
  burlywood: 0xdeb887,
  cadetblue: 0x5f9ea0,
  chartreuse: 0x7fff00,
  chocolate: 0xd2691e,
  coral: 0xff7f50,
  cornflowerblue: 0x6495ed,
  cornsilk: 0xfff8dc,
  crimson: 0xdc143c,
  cyan: 0x00ffff,
  darkblue: 0x00008b,
  darkcyan: 0x008b8b,
  darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9,
  darkgreen: 0x006400,
  darkgrey: 0xa9a9a9,
  darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b,
  darkolivegreen: 0x556b2f,
  darkorange: 0xff8c00,
  darkorchid: 0x9932cc,
  darkred: 0x8b0000,
  darksalmon: 0xe9967a,
  darkseagreen: 0x8fbc8f,
  darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f,
  darkslategrey: 0x2f4f4f,
  darkturquoise: 0x00ced1,
  darkviolet: 0x9400d3,
  deeppink: 0xff1493,
  deepskyblue: 0x00bfff,
  dimgray: 0x696969,
  dimgrey: 0x696969,
  dodgerblue: 0x1e90ff,
  firebrick: 0xb22222,
  floralwhite: 0xfffaf0,
  forestgreen: 0x228b22,
  fuchsia: 0xff00ff,
  gainsboro: 0xdcdcdc,
  ghostwhite: 0xf8f8ff,
  gold: 0xffd700,
  goldenrod: 0xdaa520,
  gray: 0x808080,
  green: 0x008000,
  greenyellow: 0xadff2f,
  grey: 0x808080,
  honeydew: 0xf0fff0,
  hotpink: 0xff69b4,
  indianred: 0xcd5c5c,
  indigo: 0x4b0082,
  ivory: 0xfffff0,
  khaki: 0xf0e68c,
  lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5,
  lawngreen: 0x7cfc00,
  lemonchiffon: 0xfffacd,
  lightblue: 0xadd8e6,
  lightcoral: 0xf08080,
  lightcyan: 0xe0ffff,
  lightgoldenrodyellow: 0xfafad2,
  lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90,
  lightgrey: 0xd3d3d3,
  lightpink: 0xffb6c1,
  lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa,
  lightskyblue: 0x87cefa,
  lightslategray: 0x778899,
  lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de,
  lightyellow: 0xffffe0,
  lime: 0x00ff00,
  limegreen: 0x32cd32,
  linen: 0xfaf0e6,
  magenta: 0xff00ff,
  maroon: 0x800000,
  mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd,
  mediumorchid: 0xba55d3,
  mediumpurple: 0x9370db,
  mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee,
  mediumspringgreen: 0x00fa9a,
  mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585,
  midnightblue: 0x191970,
  mintcream: 0xf5fffa,
  mistyrose: 0xffe4e1,
  moccasin: 0xffe4b5,
  navajowhite: 0xffdead,
  navy: 0x000080,
  oldlace: 0xfdf5e6,
  olive: 0x808000,
  olivedrab: 0x6b8e23,
  orange: 0xffa500,
  orangered: 0xff4500,
  orchid: 0xda70d6,
  palegoldenrod: 0xeee8aa,
  palegreen: 0x98fb98,
  paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093,
  papayawhip: 0xffefd5,
  peachpuff: 0xffdab9,
  peru: 0xcd853f,
  pink: 0xffc0cb,
  plum: 0xdda0dd,
  powderblue: 0xb0e0e6,
  purple: 0x800080,
  rebeccapurple: 0x663399,
  red: 0xff0000,
  rosybrown: 0xbc8f8f,
  royalblue: 0x4169e1,
  saddlebrown: 0x8b4513,
  salmon: 0xfa8072,
  sandybrown: 0xf4a460,
  seagreen: 0x2e8b57,
  seashell: 0xfff5ee,
  sienna: 0xa0522d,
  silver: 0xc0c0c0,
  skyblue: 0x87ceeb,
  slateblue: 0x6a5acd,
  slategray: 0x708090,
  slategrey: 0x708090,
  snow: 0xfffafa,
  springgreen: 0x00ff7f,
  steelblue: 0x4682b4,
  tan: 0xd2b48c,
  teal: 0x008080,
  thistle: 0xd8bfd8,
  tomato: 0xff6347,
  turquoise: 0x40e0d0,
  violet: 0xee82ee,
  wheat: 0xf5deb3,
  white: 0xffffff,
  whitesmoke: 0xf5f5f5,
  yellow: 0xffff00,
  yellowgreen: 0x9acd32,
}
