/** The newest part of an email body: everything above the quoted history. */
export function latestOnly(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex((l) => /^>/.test(l) || /^On .+ wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l));
  return (cut >= 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}
