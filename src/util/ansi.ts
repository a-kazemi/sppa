/** Tiny ANSI helper. No dependency; honours NO_COLOR and non-TTY output. */

const enabled =
  !process.env['NO_COLOR'] &&
  process.env['TERM'] !== 'dumb' &&
  Boolean(process.stdout.isTTY);

function wrap(open: number, close: number): (s: string) => string {
  return (s: string): string => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const color = {
  enabled,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function heading(text: string): string {
  return color.bold(color.cyan(text));
}

/** Left-pad/truncate a string to a fixed display width. */
export function pad(text: string, width: number): string {
  if (text.length === width) return text;
  if (text.length > width) return width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + '…';
  return text + ' '.repeat(width - text.length);
}
