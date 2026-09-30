import json, os, pathlib, queue, subprocess, threading, time, uuid, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

project = pathlib.Path(r'D:\gpt-workspace\octocode')
audit = project / 'verification/release-20260921'
root = audit / ('steer-probe-' + uuid.uuid4().hex)
root.mkdir()
requests, events = [], []
needle = 'PRIORITY_MESSAGE_73291'
started = root / 'step-started.txt'
finished = root / 'step-finished.txt'
issued = False
cancel_probe = '--cancel' in sys.argv

class Model(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        global issued
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        tools = [t['function'] for t in body.get('tools', [])]
        tool = next((t for t in tools if t['name'] in ('run_terminal_command', 'bash', 'shell', 'run_shell_command', 'execute_command')), None)
        if tool and not issued:
            issued = True
            delay = 30 if cancel_probe else 5
            command = f'powershell -NoProfile -Command "Set-Content -LiteralPath \'{started}\' -Value start; Start-Sleep -Seconds {delay}; Set-Content -LiteralPath \'{finished}\' -Value (Get-Location).Path"'
            properties = tool.get('parameters', {}).get('properties', {})
            arg = 'command' if 'command' in properties else 'cmd'
            args = {arg: command}
            if 'description' in properties: args['description'] = 'Verify safe step boundary'
            message = {'role':'assistant', 'content':None, 'tool_calls':[{'id':'step1', 'type':'function', 'function':{'name':tool['name'], 'arguments':json.dumps(args)}}]}
            stop = 'tool_calls'
        else:
            message = {'role':'assistant', 'content': 'STEER_SEEN' if needle in json.dumps(body['messages']) else 'DONE'}
            stop = 'stop'
        response = {'id':'probe', 'created':int(time.time()), 'object':'chat.completion', 'model':'probe', 'choices':[{'index':0, 'message':message, 'finish_reason':stop}], 'usage':{'prompt_tokens':50,'completion_tokens':10,'total_tokens':60}}
        self.send_response(200)
        if body.get('stream'):
            self.send_header('Content-Type','text/event-stream'); self.end_headers()
            delta = dict(message)
            if 'tool_calls' in delta: delta['tool_calls'][0]['index'] = 0
            chunk = {'id':'probe','created':int(time.time()),'object':'chat.completion.chunk','model':'probe','choices':[{'index':0,'delta':delta,'finish_reason':None}]}
            self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            chunk['choices'] = [{'index':0,'delta':{},'finish_reason':stop}]
            self.wfile.write(('data: '+json.dumps(chunk)+'\n\ndata: [DONE]\n\n').encode()); self.wfile.flush()
        else:
            data=json.dumps(response).encode(); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)

class Server(ThreadingHTTPServer):
    def handle_error(self, request, address):
        if not isinstance(sys.exception(), (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            super().handle_error(request, address)

server = Server(('127.0.0.1',0),Model)
threading.Thread(target=server.serve_forever,daemon=True).start()
host = project/'source/octocode-core/target/release/octocode-host.exe'
harness = project/'source/octo-harness/target/release/octocode-harness.exe'
if '--installed' in sys.argv:
    binaries = project/'runtime/data/extensions/octocode.octocode-0.1.0/bin/win32-x64'
    host, harness = binaries/'octocode-host.exe', binaries/'octocode-harness.exe'
env = os.environ | {'NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost'}
proc = subprocess.Popen([str(host),'--db',str(root/'test.db')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env=env,cwd=root,creationflags=0x08000000)
lines = queue.Queue()
def reader():
    for line in proc.stdout:
        item=json.loads(line); lines.put(item)
        if 'kind' in item: events.append(item)
threading.Thread(target=reader,daemon=True).start()
counter = 0
def rpc(method,params):
    global counter
    counter+=1; ident=counter
    proc.stdin.write(json.dumps({'id':ident,'method':method,'params':params})+'\n'); proc.stdin.flush()
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        item=lines.get(timeout=30)
        if item.get('id')==ident:
            assert 'error' not in item, item
            return item['result']
    raise TimeoutError(method)
try:
    base=f'http://127.0.0.1:{server.server_port}/v1'
    prepared=rpc('harness.prepare',{'title':'isolated steering check','workspace':str(root),'prompt':'Run the controlled step then finish.','provider':{'apiProvider':'openai','openAiBaseUrl':base,'openAiApiKey':'test','openAiModelId':'probe'}})
    sid,tid=prepared['session_id'],prepared['task_id']
    model=prepared['route']['model']
    model.update(context_window=32768,max_completion_tokens=4096)
    rpc('agent.run',{'session_id':sid,'task_id':tid,'executable':str(harness),'harness_home':str(root/'home'),'cwd':str(root),'model':model,'prompt':'Run the controlled step then finish.','permission_profile':'full','max_turns':8,'auto_compact_threshold_percent':0,'supervision':{'max_interventions':0}})
    deadline=time.monotonic()+120
    while not started.exists():
        assert time.monotonic()<deadline, 'step never started'
        assert not any(e['kind']=='agent.finished' for e in events), events[-3:]
        time.sleep(.1)
    assert not finished.exists(), 'step ended before steering'
    if cancel_probe:
        before = time.monotonic()
        result = rpc('agent.cancel', {'task_id':tid})
        assert result['cancelled'], result
        while not any(e['kind']=='agent.finished' for e in events):
            assert time.monotonic()-before < 12, 'cancel acknowledgement did not terminate task within 12 seconds'
            time.sleep(.1)
        assert next(e for e in events if e['kind']=='agent.finished')['payload']['cancelled']
        time.sleep(max(0, 32-(time.monotonic()-before)))
        assert not finished.exists(), 'cancelled task left its tool process running'
        print('PASS: cancellation ended task and stopped its active tool', flush=True)
        sys.exit(0)
    rpc('agent.steer',{'task_id':tid,'id':'priority-1','text':needle,'images':[],'content':[{'type':'text','text':needle}]})
    rpc('agent.steer',{'task_id':tid,'id':'priority-1','text':needle,'images':[],'content':[{'type':'text','text':needle}]})
    while not any(e['kind']=='agent.finished' for e in events):
        assert time.monotonic()<deadline, 'agent did not finish'
        time.sleep(.1)
    assert finished.exists(), 'current step was interrupted'
    assert pathlib.Path(finished.read_text().strip()).resolve()==root.resolve(), 'tool cwd differs'
    assert len([e for e in events if e['kind']=='user.message' and e['payload'].get('id')=='priority-1'])==1
    assert any(e['kind']=='agent.steer_ack' and e['payload'].get('id')=='priority-1' for e in events), 'retry not acknowledged'
    after_tool=[r for r in requests if any(m.get('role')=='tool' for m in r['messages'])]
    assert after_tool and needle in json.dumps(after_tool[0]['messages']), 'priority absent from next model step'
    assert json.dumps(after_tool[0]['messages']).count(needle)==1, 'retry duplicated the interjection'
    assert next(e for e in events if e['kind']=='agent.finished')['payload']['success'], events[-3:]
    print('PASS: host RPC -> stdin -> native interjection -> next model step; current tool completed; cwd verified',flush=True)
    # Resume the same conversation with a changed authoritative workspace.
    for round_no, chosen in enumerate([root / 'user-selected-workspace', root / 'user-selected-workspace', root]):
        chosen.mkdir(exist_ok=True)
        started, finished = chosen/f'step-started-{round_no}.txt', chosen/f'step-finished-{round_no}.txt'
        issued = False
        prepared = rpc('harness.continue', {'session_id':sid,'prompt':'Verify the newly selected workspace.','provider':{'apiProvider':'openai','openAiBaseUrl':base,'openAiApiKey':'test','openAiModelId':'probe'}})
        tid = prepared['task_id']
        rpc('agent.run', {'session_id':sid,'task_id':tid,'executable':str(harness),'harness_home':str(root/'home'),'cwd':str(chosen),'model':model,'prompt':'Verify the newly selected workspace.','resume':True,'permission_profile':'full','max_turns':8,'auto_compact_threshold_percent':0,'supervision':{'max_interventions':0}})
        deadline=time.monotonic()+120
        while not any(e['kind']=='agent.finished' and e['task_id']==tid for e in events):
            assert time.monotonic()<deadline, 'resume did not finish'
            time.sleep(.1)
        assert finished.exists(), 'resume did not execute its step'
        assert pathlib.Path(finished.read_text().strip()).resolve()==chosen.resolve(), 'resume reverted to historical cwd'
        print('PASS: resumed session follows changed workspace, not its historical cwd',flush=True)
finally:
    (root/'evidence.json').write_text(json.dumps({'requests':requests,'events':events},ensure_ascii=False,indent=2),encoding='utf-8')
    print('Evidence:',root,flush=True)
    proc.stdin.close()
    try: proc.wait(timeout=8)
    except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    server.shutdown()
