import {
  createAnsiSequenceParser,
  createColorPalette,
  type Color,
  type ParseToken,
  type DecorationType,
} from 'ansi-sequence-parser'

// CSS var names for the 16 named ANSI colors — theme switches automatically
const namedColorVar: Record<string, string> = {
  black: 'var(--ansi-black)',
  red: 'var(--ansi-red)',
  green: 'var(--ansi-green)',
  yellow: 'var(--ansi-yellow)',
  blue: 'var(--ansi-blue)',
  magenta: 'var(--ansi-magenta)',
  cyan: 'var(--ansi-cyan)',
  white: 'var(--ansi-white)',
  brightBlack: 'var(--ansi-bright-black)',
  brightRed: 'var(--ansi-bright-red)',
  brightGreen: 'var(--ansi-bright-green)',
  brightYellow: 'var(--ansi-bright-yellow)',
  brightBlue: 'var(--ansi-bright-blue)',
  brightMagenta: 'var(--ansi-bright-magenta)',
  brightCyan: 'var(--ansi-bright-cyan)',
  brightWhite: 'var(--ansi-bright-white)',
}

// Fallback palette for 256-color table and RGB — only used for non-named colors
const tablePalette = createColorPalette()

function resolveColor(color: Color): string {
  if (color.type === 'named') return namedColorVar[color.name] ?? tablePalette.value(color)
  return tablePalette.value(color)
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const decorationCss: Partial<Record<DecorationType, string>> = {
  bold: 'font-weight:bold',
  dim: 'opacity:0.7',
  italic: 'font-style:italic',
  underline: 'text-decoration:underline',
  hidden: 'visibility:hidden',
  strikethrough: 'text-decoration:line-through',
}

function tokensToHtml(tokens: ParseToken[]): string {
  let html = ''
  for (const token of tokens) {
    const styles: string[] = []
    if (token.foreground) styles.push(`color:${resolveColor(token.foreground)}`)
    if (token.background) styles.push(`background-color:${resolveColor(token.background)}`)
    for (const dec of token.decorations) {
      const css = decorationCss[dec]
      if (css) styles.push(css)
    }
    const text = escHtml(token.value)
    html += styles.length ? `<span style="${styles.join(';')}">${text}</span>` : text
  }
  return html
}

// Strip CSI sequences that aren't SGR (color/style) — cursor movement, erase, scroll, etc.
// Keeps: ESC[...m (SGR)  Strips: ESC[...H, ESC[...J, ESC[...K, ESC[...X, ESC[...A-G, etc.
// Also strips OSC sequences (ESC]...\x07 or ESC]...\x1b\\) and bare \r
function stripNonSgrSequences(text: string): string {
  return text
    // CSI sequences that are NOT SGR (anything ending in a letter other than 'm')
    .replace(/\x1b\[[0-9;]*[A-HJKSTXfhlnr]/g, '')
    // OSC sequences (e.g. title set)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Bare carriage returns (terminal overwrites)
    .replace(/\r(?!\n)/g, '')
}

export function useAnsiRenderer() {
  let parser = createAnsiSequenceParser()

  function renderToHtml(text: string): string {
    return tokensToHtml(parser.parse(stripNonSgrSequences(text)))
  }

  function resetParser() {
    parser = createAnsiSequenceParser()
  }

  return { renderToHtml, resetParser }
}
