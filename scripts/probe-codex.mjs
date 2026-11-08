// Protocol smoke test using the installed Codex binary and a local fake Responses provider.
// No OpenAI requests, credentials, or subscription credits are used.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const home=resolve('.tools/codex-probe');mkdirSync(resolve(home,'workspace'),{recursive:true});
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/v1/models')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:[]}));return;}
  if(req.url!=='/v1/responses'){res.writeHead(404);res.end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const request=JSON.parse(Buffer.concat(chunks).toString());
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  let sequence=0;const send=(event)=>res.write(`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number:sequence++})}\n\n`);
  const item={id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'通信テストです。 [ref:b0s0]',annotations:[]}]};
  const response={id:'resp_test',object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:request.model,output:[]};
  send({type:'response.created',response});send({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
  send({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  send({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
  send({type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:item.content[0].text});
  send({type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
  send({type:'response.output_item.done',output_index:0,item});send({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}});res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const settings=[
  'model_provider="study_chatgpt"','model_providers.study_chatgpt.name="ChatGPT plan"',
  `model_providers.study_chatgpt.base_url="http://127.0.0.1:${server.address().port}/v1"`,
  'model_providers.study_chatgpt.env_key="STUDY_GATE_TOKEN"','model_providers.study_chatgpt.wire_api="responses"',
  'model_providers.study_chatgpt.requires_openai_auth=false','model_providers.study_chatgpt.supports_websockets=false',
  'sandbox_mode="read-only"','approval_policy="never"','web_search="disabled"',
  'features.shell_tool=false','features.unified_exec=false','features.apps=false','features.browser_use=false','features.computer_use=false',
  'features.multi_agent=false','features.skill_search=false','features.skip_host_skill_discovery=true','features.enable_request_compression=false','mcp_servers={}'
];
let child;let timer;
try{
  child=spawn(process.argv[2]||'codex.exe',['app-server','--listen','stdio://',...settings.flatMap(s=>['-c',s])],{windowsHide:true,cwd:resolve(home,'workspace'),env:{...process.env,CODEX_HOME:home,STUDY_GATE_TOKEN:'local-test-not-a-real-token',OPENAI_API_KEY:'',CODEX_API_KEY:''},stdio:['pipe','pipe','pipe']});
  let id=1;const pending=new Map();const events=[];const waiters=[];
  const fatal=new Promise((_,reject)=>{child.on('error',reject);child.on('exit',code=>{if(code)reject(new Error(`Codex exited: ${code}`));});timer=setTimeout(()=>reject(new Error('Codex protocol timeout')),45000);});
  const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',c=>{stderr+=c.toString();});
  lines.on('line',line=>{const event=JSON.parse(line);if(event.id&&pending.has(event.id)){const {resolve,reject}=pending.get(event.id);pending.delete(event.id);if(event.error)reject(new Error(JSON.stringify(event.error)));else resolve(event.result);}
    else if(event.method&&event.id)child.stdin.write(JSON.stringify({id:event.id,error:{code:-32601,message:'Tools disabled in test'}})+'\n');
    else if(waiters.length)waiters.shift()(event);else events.push(event);
  });
  const rpc=(method,params)=>Promise.race([fatal,new Promise((resolve,reject)=>{const request=id++;pending.set(request,{resolve,reject});child.stdin.write(JSON.stringify({id:request,method,params})+'\n');})]);
  const next=()=>Promise.race([fatal,events.length?Promise.resolve(events.shift()):new Promise(resolve=>waiters.push(resolve))]);
  const init=await rpc('initialize',{clientInfo:{name:'study-tool',title:'Study Tool',version:'0.1.0'},capabilities:{experimentalApi:false}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const thread=await rpc('thread/start',{sandbox:'read-only',approvalPolicy:'never',developerInstructions:'Use no tools. Answer the attached study question.'});
  const turn=await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:JSON.stringify({question:'テスト',references:[{id:'b0s0',text:'Memory has an owner.'}]})}]});
  let answer='';let status;
  while(!status){const e=await next();if(e.method==='item/agentMessage/delta')answer+=e.params.delta;if(e.method==='turn/completed')status=e.params.turn.status;}
  if(status!=='completed'||!answer.includes('通信テスト'))throw new Error(`Unexpected result: ${status}; ${stderr.slice(-1000)}`);
  const resumed=await rpc('thread/resume',{threadId:thread.thread.id,sandbox:'read-only',approvalPolicy:'never'});
  if(resumed.thread.id!==thread.thread.id)throw new Error('Thread resume mismatch');
  console.log(JSON.stringify({initialize:'passed',threadStart:'passed',turnStart:'passed',streaming:'passed',completion:status,resume:'passed',answer},null,2));
}finally{clearTimeout(timer);child?.stdin.end();child?.kill();server.close();}
