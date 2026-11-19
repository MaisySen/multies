/** Runtime checks for the fields read by native Mail detail. Do not repair or log the original payload. */
type Bag = Record<string, unknown>;
const record = (value: unknown): value is Bag => typeof value === "object" && value !== null && !Array.isArray(value);
const textOrAbsent = (value: unknown): boolean => value == null || typeof value === "string";
function address(value: unknown): boolean {
  return record(value) && typeof value.address === "string" && textOrAbsent(value.name);
}
function attachment(value: unknown): boolean {
  return record(value) && typeof value.id === "string" && typeof value.filename === "string"
    && typeof value.contentType === "string" && typeof value.sizeBytes === "number"
    && Number.isFinite(value.sizeBytes) && value.sizeBytes >= 0;
}
function message(value: unknown): boolean {
  return record(value) && typeof value.id === "string" && value.id.length > 0
    && typeof value.threadId === "string" && value.threadId.length > 0 && address(value.from)
    && Array.isArray(value.to) && value.to.every(address) && Array.isArray(value.cc) && value.cc.every(address)
    && typeof value.date === "string" && Number.isFinite(Date.parse(value.date))
    && textOrAbsent(value.subject) && textOrAbsent(value.text) && textOrAbsent(value.html)
    && Array.isArray(value.attachments) && value.attachments.every(attachment);
}
export function canRenderThreadView(value: unknown): boolean {
  return record(value) && message(value.message) && Array.isArray(value.thread) && value.thread.every(message);
}
