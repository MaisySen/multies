import { SampleTransport } from "@/sample/transport";
import { endpoints } from "@/api/endpoints";

describe("sample workspace", () => {
  const api = () => endpoints(new SampleTransport());

  it("lists the inbox newest first and opens a thread", async () => {
    const a = api();
    const { messages } = await a.messages({ folder: "inbox" });
    expect(messages.length).toBeGreaterThan(3);
    expect(messages[0].subject).toBe("Wholesale order for Saturday markets");
    const t = await a.message("msg_3");
    expect(t.thread.map((m) => m.id)).toEqual(["msg_3a", "msg_3"]);
  });

  it("approves and rejects agent messages once", async () => {
    const a = api();
    expect((await a.approvals("pending")).approvals).toHaveLength(3);
    const r = await a.approve("apr_1", { subject: "Edited subject" });
    expect(r.approval).toMatchObject({ status: "sent", subject: "Edited subject" });
    await expect(a.approve("apr_1")).rejects.toMatchObject({ status: 409 });
    expect((await a.reject("apr_2", "Already paid")).approval).toMatchObject({ status: "rejected", note: "Already paid" });
    expect((await a.approvals("pending")).approvals).toHaveLength(1);
  });

  it("sends replies into the same thread and searches", async () => {
    const a = api();
    await a.send({ mailboxId: "mbx_mia", to: ["orders@bondibakehouse.com.au"], subject: "Re: Wholesale order", text: "Done", inReplyToId: "msg_1" }, "k");
    const t = await a.message("msg_1");
    expect(t.thread).toHaveLength(2);
    expect((await a.messages({ q: "remittance" })).messages.map((m) => m.id)).toEqual(["msg_3"]);
  });
});
