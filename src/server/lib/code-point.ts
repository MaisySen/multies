/**
 * B4: the text for a numeric character reference (&#N; or &#xN;) read from outside input. String.fromCodePoint throws
 * a RangeError past U+10FFFF and on a non integer, so any value that is not a Unicode scalar value reads as U+FFFD,
 * the way HTML and XML readers show it.
 */
export function codePointText(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return String.fromCodePoint(n);
}
