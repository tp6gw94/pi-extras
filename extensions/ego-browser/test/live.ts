import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import type { Report, Request } from "../schema.ts";
import { verifyOwnershipStop } from "./ownership-check.ts";

const mode = process.argv[2] ?? "manual";
assert.ok(["manual","fake","done","jev","ref","limit","cancel","finish","ownership","hidden-text"].includes(mode));
const space = Number(process.env.EGO_SPACE_ID);
assert.ok(Number.isInteger(space) && space > 0,"EGO_SPACE_ID must name the authorized space");
const origin = "http://127.0.0.1:4317";
const evidenceDir = resolve(process.env.EGO_EVIDENCE_DIR ?? `extensions/ego-browser/test/.artifacts/live-${mode}-${Date.now()}`);
await mkdir(evidenceDir,{recursive:true});
const settingsManager = SettingsManager.inMemory({defaultTools:[]});
let classifierCalls=0;
const loader = new DefaultResourceLoader({cwd:process.cwd(),agentDir:getAgentDir(),settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi => {
  const wrapped = Object.create(pi) as ExtensionAPI;
  wrapped.registerTool = definition => pi.registerTool({ ...definition, async execute(id,args,signal,update,ctx) {
    if (!["fake","done","limit"].includes(mode)) return definition.execute(id,args,signal,update,ctx);
    const registry = Object.create(ctx.modelRegistry) as typeof ctx.modelRegistry;
    registry.findOfType = (() => ({provider:"fake",id:"fake",type:"classifier"})) as typeof registry.findOfType;
    registry.classify = async (_model, context) => {
      classifierCalls++;
      const facts = context.state.facts as {controls:Record<string,{value:string}>};
      const choice = mode === "done" ? "DONE" : facts.controls.email?.value !== "test@example.invalid" ? "email" : "submit";
      return {provider:"fake",model:"fake",api:"typesafe-system-one",timestamp:Date.now(),stopReason:"stop",answers:{action:{type:"choice",choice,confidence:1,probabilities:{[choice]:1}}}};
    };
    return definition.execute(id,args,signal,update,{...ctx,modelRegistry:registry});
  }});
  extension(wrapped);
}]});
await loader.reload();
const {session} = await createAgentSession({resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(),tools:["ego_browser"]});
await session.bindExtensions({});
const tool = session.agent.state.tools.find(tool=>tool.name==="ego_browser");
assert.ok(tool,"Registered ego_browser must be active");
const records: any[]=[];
const started=performance.now();
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const serverState=()=>fetch(`${origin}/state`).then(r=>r.json());
const serverPost=(path:string)=>fetch(`${origin}${path}`,{method:"POST"}).then(r=>r.text());
const call = async (request: Request, signal = new AbortController().signal) => {
  const start=performance.now();
  try {
    const result=await tool.execute(crypto.randomUUID(),{request},signal);
    const report=result.details as Report;
    records.push({request,result,wallMs:performance.now()-start});
    console.log(JSON.stringify(report));
    return report;
  } catch (error) {
    records.push({request,thrown:String(error),wallMs:performance.now()-start});
    throw error;
  } finally {
    await writeFile(join(evidenceDir,"calls.json"),JSON.stringify(records,null,2));
  }
};
const condition={kind:"text",selector:"#confirmation",includes:"Order confirmed"} as const;
const checks=[{id:"confirmed",condition}];
const emailValue={kind:"value",selector:"#email",equals:"test@example.invalid"} as const;
const candidates=[{id:"email",action:{kind:"fill",selector:"#email",textKey:"email"},after:emailValue},{id:"submit",action:{kind:"click",selector:"#submit"},after:condition}] as const;
const extra:Record<string,any>={};
let failure:unknown;
try {
  const allowedActions=mode==="ref"||mode==="limit"?["navigate","fill","click"] as const:["navigate","fill","click","select"] as const;
  const begun=await call({op:"begin",space:{attach:space},contract:{goal:"Local checkout verification",allowedOrigins:[origin],allowedActions:[...allowedActions],text:{email:"test@example.invalid"},evidenceDir,deadline:new Date(Date.now()+600000).toISOString(),maxActions:12}});
  if (mode === "ownership") assert.ok(["begun", "ownership_lost"].includes(begun.reason));
  else assert.equal(begun.reason,"begun");
  const task=begun.task;
  const navigate=()=>call({op:"act",task,page:"p1",action:{kind:"navigate",url:origin},after:{kind:"visible",selector:"#checkout"}});
  const fillEmail=(observation?:string)=>call({op:"act",task,page:"p1",observation,action:{kind:"fill",target:observation?{ref:extra.emailRef as string}:{selector:"#email"},textKey:"email"},after:emailValue});
  const submit=(signal?:AbortSignal)=>call({op:"act",task,page:"p1",action:{kind:"click",target:{selector:"#submit"}},after:condition},signal);
  const prepare=async()=>{
    await serverPost("/reset");
    assert.equal((await navigate()).reason,"acted");
    const before=await call({op:"observe",task,page:"p1",checks});
    assert.equal(before.checks[0]?.status,"fail","Success must start absent");
    return before;
  };
  if(mode==="ownership") {
    await verifyOwnershipStop(begun, () => call({op:"observe",task,page:"p1",checks}));
    assert.equal(records.some(record => ["act", "run", "finish"].includes(record.request.op)), false);
  } else if (mode === "hidden-text") {
    await serverPost("/reset");
    const navigated = await call({op:"act",task,page:"p1",action:{kind:"navigate",url:`${origin}/?hidden-text=1`},after:{kind:"visible",selector:"#checkout"}});
    assert.equal(navigated.reason, "acted");
    const observed = await call({op:"observe",task,page:"p1",checks});
    assert.equal(observed.reason, "observed");
    assert.equal(observed.checks[0]?.status, "fail");
    assert.equal(observed.checks[0]?.actual, "Pending");
    const finished = await call({op:"finish",task,reviewedObservation:observed.observation!.id});
    assert.equal(finished.reason, "check_failed");
    assert.equal(finished.actionsUsed, navigated.actionsUsed);
    assert.equal((await serverState()).received, 0);
    assert.equal((await serverState()).mutations, 0);
  } else if(mode==="finish") {
    const observed=await call({op:"observe",task,page:"p1",checks});
    assert.equal(observed.reason,"checks_passed","Finish requires the known checks to pass on the attached page");
    assert.equal((await call({op:"finish",task,reviewedObservation:observed.observation!.id})).reason,"finished");
  } else if(mode==="ref") {
    const before=await prepare();
    const snapshot=await readFile(before.observation!.snapshotPath,"utf8");
    const match=snapshot.match(/text "Email"\s*\n\s*textbox \[(ref=\d+)\]/);
    assert.ok(match,"Snapshot must expose a textbox ref directly after the Email label");
    extra.emailRef=match[1];
    extra.snapshotPath=before.observation!.snapshotPath;
    const filled=await fillEmail(before.observation!.id);
    assert.equal(filled.reason,"acted");
    const verified=await call({op:"observe",task,page:"p1",checks:[{id:"email",condition:emailValue}]});
    assert.equal(verified.checks[0]?.status,"pass");
    assert.equal((await call({op:"act",task,page:"p1",observation:before.observation!.id,action:{kind:"fill",target:{ref:extra.emailRef as string},textKey:"email"},after:emailValue})).reason,"stale");
    assert.equal((await serverState()).mutations,0);
  } else if(mode==="limit") {
    const prepared=await prepare();
    const result=await call({op:"run",task,page:"p1",goal:"Fill email then place one order",candidates:[...candidates],checks,budget:{maxActions:1,timeoutMs:60000}});
    assert.equal(result.reason,"action_limit");
    assert.equal(result.actionsUsed-prepared.actionsUsed,1);
    assert.equal((await serverState()).mutations,0);
    assert.equal((await call({op:"observe",task,page:"p1",checks:[{id:"email",condition:emailValue}]})).checks[0]?.status,"pass");
  } else if(mode==="cancel") {
    await prepare();
    const delayMs=4000;
    await serverPost(`/delay?ms=${delayMs}`);
    assert.equal((await fillEmail()).reason,"acted");
    const controller=new AbortController();
    let settled=false;
    const pending=submit(controller.signal).finally(()=>{settled=true;});
    while(!settled && !(await serverState()).received) await sleep(25);
    extra.stateAtAbort=await serverState();
    controller.abort();
    const cancelled=await pending;
    assert.equal(cancelled.reason,"uncertain_effect");
    assert.equal(cancelled.mayHaveLateEffects,true);
    assert.equal(extra.stateAtAbort.received,1);
    const until=Date.now()+delayMs+5000;
    while(Date.now()<until && (await serverState()).mutations<1) await sleep(100);
    extra.stateAfterLateEffect=await serverState();
    assert.equal(extra.stateAfterLateEffect.mutations,1);
    assert.equal((await submit()).reason,"uncertain_effect");
    extra.stateAfterRetryAttempt=await serverState();
    assert.equal(extra.stateAfterRetryAttempt.mutations,1);
    assert.equal(extra.stateAfterRetryAttempt.received,1);
    await serverPost("/delay?ms=0");
  } else {
    await prepare();
    let final: Report;
    if(mode==="manual") {
      assert.equal((await fillEmail()).reason,"acted");
      assert.equal((await submit()).reason,"acted");
      final=await call({op:"observe",task,page:"p1",checks,screenshot:"now"});
    } else {
      final=await call({op:"run",task,page:"p1",goal:"Fill email then place one order",candidates:[...candidates],checks,budget:{maxActions:3,timeoutMs:60000},screenshot:"final"});
    }
    const server=await serverState();
    if(mode==="done") { assert.equal(final.reason,"check_failed");assert.equal(server.mutations,0); }
    else { assert.equal(final.reason,"checks_passed");assert.equal(server.mutations,1);assert.equal(server.orders[0].email,"test@example.invalid"); }
  }
} catch (error) {
  failure=error;
  throw error;
} finally {
  const reports=records.filter(r=>r.result).map(r=>r.result.details as Report);
  const last=reports.at(-1);
  const server=await serverState().catch(error=>({unavailable:String(error)}));
  await writeFile(join(evidenceDir,"summary.json"),JSON.stringify({mode,space,page:"p1",ok:failure===undefined,failure:failure===undefined?undefined:String(failure),wallMs:performance.now()-started,calls:records.length,reasons:reports.map(r=>r.reason),errors:records.filter(r=>r.thrown||r.result.isError).length,actions:last?.actionsUsed,classifierCalls:last?.classifierCalls,fakeClassifierCalls:classifierCalls,checks:last?.checks,server,...extra,evidenceDir},null,2));
  await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
  session.dispose();
}
