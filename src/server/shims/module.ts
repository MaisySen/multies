/**
 * Workers have no CommonJS require. email-reply-parser only uses it to look for the optional
 * re2 package; this stand-in reports it missing, so the parser uses built-in regular expressions.
 */
export function createRequire() {
  return (id: string) => { throw new Error(`Cannot require ${id} here`); };
}
export default { createRequire };
