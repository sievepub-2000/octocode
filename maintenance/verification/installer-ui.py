"""Inspect only the OctoCode installer on machine 3's interactive desktop."""
if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import argparse
import json
import pathlib
import time
import sys
sys.path.insert(0, r'D:\gpt-workspace\octocode\verification\audit-tools')
import win32gui
import win32process
import win32con
import psutil

parser = argparse.ArgumentParser()
parser.add_argument('--click', type=int)
parser.add_argument('--set', type=int)
parser.add_argument('--text', default='')
args = parser.parse_args()
root = pathlib.Path(r'D:\gpt-workspace\octocode\verification\release-20260921')
def belongs(handle):
    try:
        p = psutil.Process(win32process.GetWindowThreadProcessId(handle)[1])
        return 'octocodesetup' in p.name().lower() or (p.name().lower().endswith('.tmp') and any('octocodesetup' in a.name().lower() for a in p.parents()))
    except (psutil.Error, OSError):
        return False
if args.click is not None:
    assert belongs(args.click) and win32gui.IsWindowEnabled(args.click)
    win32gui.SendMessage(args.click, win32con.BM_CLICK, 0, 0)
if args.set is not None:
    assert belongs(args.set) and win32gui.IsWindowEnabled(args.set)
    win32gui.SendMessage(args.set, win32con.WM_SETTEXT, 0, args.text)
time.sleep(1)
windows = []
def visit(handle, _):
    if belongs(handle) and win32gui.IsWindowVisible(handle):
        controls = []
        def child(control, _):
            if win32gui.IsWindowVisible(control):
                controls.append({'handle': control, 'class': win32gui.GetClassName(control), 'text': win32gui.GetWindowText(control), 'enabled': bool(win32gui.IsWindowEnabled(control))})
        win32gui.EnumChildWindows(handle, child, None)
        windows.append({'handle': handle, 'title': win32gui.GetWindowText(handle), 'controls': controls})
win32gui.EnumWindows(visit, None)
(root / 'installer-ui.json').write_text(json.dumps(windows, ensure_ascii=False, indent=2), 'utf-8')
