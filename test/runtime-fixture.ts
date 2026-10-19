import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ZCodeRuntimeConfig } from "../src/interfaces.js";
import { TEMP_TREE_REMOVE_OPTIONS, validReport } from "./helpers.js";

export async function runtimeFixture(options: { interaction?: boolean; replay?: boolean; output?: string; fail?: boolean; cancel?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-regression-"));
  const home = path.join(root, "home");
  const settingsDirectory = path.join(home, ".test-host", "bridge");
  const personal = path.join(home, ".zcode", "v2", "provider_config.json");
  await mkdir(path.dirname(personal), { recursive: true });
  await mkdir(settingsDirectory, { recursive: true });
  const builtin = path.join(root, "builtin.json");
  await writeFile(builtin, JSON.stringify({ config: {} }));
  await writeFile(personal, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: "fake" }] } } }));
  const entrypoint = path.join(root, "runtime.cjs");
  const log = path.join(root, "requests.jsonl");
  const script = `const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin});
    const opts=${JSON.stringify(options)},report=${JSON.stringify(validReport())};
    const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    const event=(seq,type,payload,sessionId='current-session')=>out({method:'session/event',params:{sessionId,seq,type,payload}});
    const snapshot=()=>({session:{sessionId:'current-session'},settings:{model:{current:{providerId:'fake',modelId:'fake'},available:[{ref:{providerId:'fake',modelId:'fake'},label:'Fake model',contextWindow:1234}]}},runtime:{eventSeq:20}});
    function finish(){if(opts.fail){event(24,'turn.failed',{error:{message:'PRIVATE_RUNTIME_ERROR'}});return;} event(24,'turn.completed',{turnId:'current-turn',response:JSON.stringify(report),resultType:opts.cancel?'cancelled':'success',usage:{totalTokens:9,reasoning:{text:'PRIVATE_REASONING'},debug:'PRIVATE_METADATA'}});}
    rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
      if(m.method==='session/create'||m.method==='session/resume')out({id:m.id,result:snapshot()});
      else if(m.method==='session/subscribe'){out({id:m.id,result:{}});if(opts.replay)event(21,'turn.completed',{response:'PRIVATE_REPLAY',resultType:'success'});}
      else if(m.method==='session/send'){out({id:m.id,result:{}});
        if(opts.replay){event(300,'turn.completed',{response:'PRIVATE_FOREIGN'},'foreign-session');event(20,'turn.completed',{response:'PRIVATE_OLD'});}
        event(21,'turn.started',{turnId:'current-turn'});
        if(opts.replay)event(22,'turn.completed',{turnId:'old-turn',response:'PRIVATE_TURN'});
        if(opts.output)event(23,'model.streaming',{kind:'text_delta',delta:opts.output});
        if(opts.interaction)out({id:'ask-1',method:'interaction/requestPermission',params:{requestId:'repeatable-id',sessionId:'current-session',toolName:'Bash',input:{command:'fake build'},options:[{kind:'allow_once'},{kind:'deny'}]}});else finish();
      }else if(m.id==='ask-1'){finish();}
      else out({id:m.id,result:{}});
    });`;
  await writeFile(entrypoint, script);
  const config: ZCodeRuntimeConfig = { nodeExecutable: process.execPath, zcodeEntrypoint: entrypoint, providerBuiltinConfigFile: builtin, providerPersonalConfigFile: personal, dataRoot: root };
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (key.startsWith("ZCODE_")) delete env[key as keyof typeof env];
  Object.assign(env, { ZCODE_BRIDGE_NODE: process.execPath, ZCODE_BRIDGE_ZCODE_CJS: entrypoint, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal, ZCODE_HOME: path.join(home, ".zcode"), ZCODE_BRIDGE_DATA_DIR: root, ZCODE_BRIDGE_MODE: "build" });
  return { root, home, log, config, env, host: { name: "test-host-bridge", settingsDirectory }, cleanup: () => rm(root, { recursive: true, force: true, ...TEMP_TREE_REMOVE_OPTIONS }) };
}
