import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

test("Pi SDK discovers the direct tool without browser or model work", async () => {
  const settingsManager=SettingsManager.inMemory({defaultTools:[]});
  const loader=new DefaultResourceLoader({cwd:process.cwd(),agentDir:getAgentDir(),settingsManager,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:[extension]});
  await loader.reload();
  const {session}=await createAgentSession({resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(),tools:["ego_browser"]});
  try {
    await session.bindExtensions({});
    assert.ok(session.getActiveToolNames().includes("ego_browser"));
    assert.equal(session.getToolDefinition("ego_browser")?.exposure,"direct");
    const definition=session.getToolDefinition("ego_browser");
    assert.equal((definition?.parameters as {type:string}).type,"object");
    assert.deepEqual(Object.keys((definition?.parameters as {properties:object}).properties),["request"]);
    assert.deepEqual((definition?.parameters as {required:string[]}).required,["request"]);
    const tool=session.agent.state.tools.find(t=>t.name==="ego_browser");
    assert.ok(tool);
    const result=await tool.execute("unknown-task",{request:{op:"observe",task:"missing",page:"p1"}},new AbortController().signal);
    assert.equal((result.details as {reason:string}).reason,"unknown_task");
    assert.equal(result.isError,true);
  } finally {
    await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
    session.dispose();
  }
});
