import { canRenderThreadView } from "../src/lib/thread-view-check";

const address={address:"sender@example.test",name:"Sample Sender"};
const basic={id:"sample_msg",threadId:"sample_thread",from:address,to:[address],cc:[],date:"2026-11-18T00:00:00Z",subject:"Hello",text:"Example",attachments:[]};

describe("thread detail payloads",()=>{
  it("keeps complete current or saved threads readable",()=>{
    expect(canRenderThreadView({message:basic,thread:[]})).toBe(true);
    expect(canRenderThreadView({message:{...basic,subject:null,text:null,html:null},thread:[basic]})).toBe(true);
  });
  it("rejects partial details before the renderer touches them",()=>{
    expect(canRenderThreadView(null)).toBe(false);
    expect(canRenderThreadView({message:basic})).toBe(false);
    expect(canRenderThreadView({message:basic,thread:[{...basic,from:null}]})).toBe(false);
    expect(canRenderThreadView({message:{...basic,to:[42]},thread:[]})).toBe(false);
    expect(canRenderThreadView({message:{...basic,date:"bad date"},thread:[]})).toBe(false);
    expect(canRenderThreadView({message:{...basic,text:[]},thread:[]})).toBe(false);
    expect(canRenderThreadView({message:basic,thread:[{...basic,attachments:[{id:"a",filename:"file",contentType:"text/plain",sizeBytes:NaN}]}]})).toBe(false);
  });
});
