"""Run the production parent watcher in real isolated Python processes."""
import ast
import json
import subprocess
import sys
import unittest
from pathlib import Path

tree = ast.parse(Path(__file__).with_name('octocode_api.py').read_text(encoding='utf-8'))
watcher = ast.unparse(next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'watch_parent'))
# Module-level constants the watcher references must ride along or the child hits NameError.
constants = ast.unparse(next(node for node in tree.body if isinstance(node, ast.Assign)
                             and any(getattr(t, 'id', '') == 'MAX_COMMAND_BYTES' for t in node.targets)))


class ParentPipeTests(unittest.TestCase):
    def start(self, body):
        script = 'import os,sys,time,threading,json\nstopped=[]\ndef shutdown(): stopped.append(True)\n' + constants + '\n' + watcher + '\n' + body
        child = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        self.addCleanup(child.stdin.close)
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.stderr.close)
        return child

    def finish(self, child):
        code = child.wait(timeout=10)
        error = child.stderr.read().decode('utf-8', errors='replace')
        self.assertEqual(code, 0, error)
        self.assertEqual(error, '')
        return child.stdout.read().decode('utf-8')

    def test_interpreter_exit_while_parent_pipe_stays_open(self):
        child = self.start('threading.Thread(target=watch_parent,daemon=True).start()\ntime.sleep(.25)\n')
        self.finish(child)  # Keep stdin open through interpreter finalization.

    def test_stop_line_requests_shutdown(self):
        child = self.start('watch_parent()\nprint(json.dumps(stopped))\n')
        child.stdin.write(b'stop\r\n')
        child.stdin.flush()
        self.assertEqual(json.loads(self.finish(child)), [True])

    def test_eof_leaves_detached_supervision_running(self):
        child = self.start('watch_parent()\nprint(json.dumps(stopped))\n')
        child.stdin.close()
        self.assertEqual(json.loads(self.finish(child)), [])

    def test_invalid_overlong_command_never_requests_shutdown(self):
        child = self.start('watch_parent()\nprint(json.dumps(stopped))\n')
        child.stdin.write(b'x' * 64)
        child.stdin.flush()
        self.assertEqual(json.loads(self.finish(child)), [])


if __name__ == '__main__':
    unittest.main()
