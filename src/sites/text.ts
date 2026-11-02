/** Half of a character outside the Basic Multilingual Plane (an emoji, say) without its other half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Replace lone surrogates with U+FFFD. `JSON.stringify` writes them as `\ud83d`, which strict
 * JSON parsers (the Anthropic API's among them) reject, failing the whole request.
 */
export const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, '�');

/** The first `length` UTF-16 units, one fewer when that would split a surrogate pair. */
export function cut(text: string, length: number): string {
  if (text.length <= length) return text;
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

/** At most `max` units, with `…` when shortened. */
export const clip = (text: string, max: number): string =>
  text.length > max ? `${cut(text, max - 1)}…` : text;
