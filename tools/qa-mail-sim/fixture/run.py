#!/usr/bin/env python3
"""Run a previously built fixture only; never build, download, or contact a device service."""
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import signal
import subprocess
import tempfile
import time
from uuid import UUID

BUNDLE = 'au.fintex.multies.mailsmoke'
HERE = Path(__file__).resolve().parent


class Blocked(Exception):
    pass


def load_plist(path):
    return plistlib.loads(path.read_bytes())


def fixture_executable(app):
    try:
        info = load_plist(app / 'Info.plist')
        if (app.suffix != '.app' or info.get('CFBundleIdentifier') != BUNDLE
                or info.get('MultiesMailSmokeFixtureVersion') != '2'
                or info.get('DTPlatformName') != 'iphonesimulator'
                or info.get('CFBundleVersion') != '2' or not (app / 'main.jsbundle').is_file()):
            raise ValueError()
        for expo_file in app.rglob('Expo.plist'):
            if load_plist(expo_file).get('EXUpdatesEnabled') is not False:
                raise ValueError()
        name = info['CFBundleExecutable']
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or not (app / name).is_file():
            raise ValueError()
        return name
    except (OSError, ValueError, TypeError, KeyError, plistlib.InvalidFileException) as exc:
        raise Blocked('Expected the v2 embedded-JS iPhoneSimulator fixture .app with OTA disabled; refusing this artifact.') from exc


def command(args, deadline, capture=False):
    # The arguments can contain local paths and identifiers; report only fixed phase labels.
    if args[:2] == ['xcrun', 'simctl'] and len(args) > 2:
        phase = {
            'list': 'list booted simulators',
            'listapps': 'list installed apps',
            'install': 'install fixture',
            'launch': 'launch fixture',
            'terminate': 'terminate fixture',
        }.get(args[2], 'simulator command')
    else:
        phase = 'inspect fixture process' if args[:1] == ['ps'] else 'local fixture command'
    announce = phase not in ('inspect fixture process', 'local fixture command')
    if announce:
        print(f'Mail simulator setup started: {phase}.', flush=True)
    try:
        result = subprocess.run(args, text=True, errors='replace', check=False, timeout=deadline,
                                stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise Blocked(f'{phase} timed out after {deadline}s.') from None
    except OSError:
        raise Blocked(f'{phase}: tool could not start.') from None
    if announce:
        print(f'Mail simulator setup finished: {phase} (exit {result.returncode}).', flush=True)
    return result


def inspect_process(pid, executable):
    r = command(['ps', '-p', str(pid), '-o', 'comm='], 3, True)
    if r.returncode == 1 and not r.stdout.strip():
        return 'not-running'
    if r.returncode == 0:
        proc = r.stdout.strip()
        if proc == executable or proc.endswith(f'.app/{executable}'):
            return 'running'
    return 'unconfirmed'


# Read new crash records locally; print only fixed categories and numeric codes, no raw logs/paths.
ALLOWED_NAMESPACES = {'SIGNAL', 'FRONTBOARD', 'SPRINGBOARD', 'WATCHDOG', 'RUNNINGBOARD', 'CODESIGNING', 'DYLD', 'JETSAM'}
ALLOWED_EXCEPTIONS = {'EXC_BAD_ACCESS', 'EXC_CRASH', 'EXC_BREAKPOINT', 'EXC_RESOURCE', 'EXC_GUARD', 'EXC_BAD_INSTRUCTION', 'EXC_ARITHMETIC'}


def summarize_ips(content, pid):
    try:
        header, rest = content.split('\n', 1)
        meta, report = json.loads(header), json.loads(rest)
        if not isinstance(meta, dict) or not isinstance(report, dict):
            return None
        bundle = report.get('bundleInfo') or {}
        if not isinstance(bundle, dict) or BUNDLE not in {meta.get('bundleID'), bundle.get('CFBundleIdentifier')} or report.get('pid') != pid:
            return None
        term = report.get('termination') or {}
        exc = report.get('exception') or {}
        if not isinstance(term, dict) or not isinstance(exc, dict):
            return None
        namespace = term.get('namespace')
        kind = exc.get('type')
        code = term.get('code')
        return {'exception': kind if kind in ALLOWED_EXCEPTIONS else 'other',
                'termination': namespace if namespace in ALLOWED_NAMESPACES else 'other',
                'code': code if type(code) is int else None}
    except (TypeError, ValueError):
        return None


def records(roots):
    return {f for root in roots for f in root.glob('*.ips') if f.is_file() and not f.is_symlink()}


def new_summaries(roots, before, pid):
    summaries = []
    for f in records(roots) - before:
        try:
            if f.stat().st_size < 4_000_000:
                hit = summarize_ips(f.read_text(encoding='utf8', errors='replace'), pid)
                if hit:
                    summaries.append(hit)
        except OSError:
            continue
    return summaries


def run_case(sim, udid, maestro, scenario, executable, roots, debug):
    before = records(roots)
    launch = command(sim + ['launch', udid, BUNDLE], 25, True)
    match = re.fullmatch(re.escape(BUNDLE) + r':\s*([1-9]\d*)', launch.stdout.strip())
    if launch.returncode or not match:
        print(f'{scenario}: simctl launch not confirmed; no tap result', flush=True)
        return False
    pid = int(match.group(1))
    print(f'{scenario}: initial launch accepted', flush=True)
    env = {**os.environ, 'MAESTRO_CLI_NO_ANALYTICS': '1', 'MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED': 'true'}
    proc = subprocess.Popen(
        [maestro, '--device', udid, 'test', '--debug-output', str(debug), str(HERE / f'{scenario}.yaml')],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    lost = False
    expired = False
    deadline = time.monotonic() + 100
    try:
        while proc.poll() is None and time.monotonic() < deadline:
            if inspect_process(pid, executable) == 'not-running':
                lost = True
                break
            time.sleep(0.75)
        expired = time.monotonic() >= deadline and proc.poll() is None
    finally:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=5)
    end = inspect_process(pid, executable)
    print(f'{scenario}: assertions exit={proc.returncode}, timeout={expired}, original-process={end}, observed-exit={lost or end == "not-running"}', flush=True)
    if lost or end != 'running' or proc.returncode != 0:
        time.sleep(4)  # .ips writes are asynchronous; absence is not proof of no termination.
        summaries = new_summaries(roots, before, pid)
        print(f'{scenario}: matching new crash records: {json.dumps(summaries)}')
        return False
    return not expired


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--offline-disposable-simulator', action='store_true', required=True,
                   help='confirm fresh dedicated simulator and host outbound networking disabled')
    p.add_argument('udid', type=UUID)
    p.add_argument('app', type=Path)
    a = p.parse_args()
    if platform.system() != 'Darwin' or not shutil.which('xcrun') or not (maestro := shutil.which('maestro')):
        raise Blocked('A local Mac with Xcode Simulator and the installed Maestro CLI is required.')
    app = a.app.resolve()
    executable = fixture_executable(app)
    udid = str(a.udid).upper()
    sim = ['xcrun', 'simctl']
    device_list = command(sim + ['list', 'devices', 'booted', '-j'], 15, True)
    if device_list.returncode:
        raise Blocked('Cannot read the local Simulator device list.')
    ios = {str(d.get('udid')).upper() for runtime, devices in json.loads(device_list.stdout)['devices'].items()
           if runtime.startswith('com.apple.CoreSimulator.SimRuntime.iOS-')
           for d in devices if d.get('state') == 'Booted' and d.get('isAvailable') and d.get('name', '').startswith('iPhone')}
    if udid not in ios:
        raise Blocked('Explicit UDID must name the booted, disposable iPhone Simulator.')
    apps = command(sim + ['listapps', udid], 15, True)
    if apps.returncode or not apps.stdout.strip():
        raise Blocked('Cannot verify installed-app inventory on the selected simulator.')
    if re.search(r'\bau\.fintex\.multies(?:\.mailsmoke)?\b', apps.stdout):
        raise Blocked('A Multies app is already installed. Use a fresh dedicated simulator; nothing will be reset.')
    if command(sim + ['install', udid, str(app)], 45).returncode:
        raise Blocked('simctl refused fixture installation.')
    home = Path.home()
    roots = [home / 'Library/Logs/DiagnosticReports', home / 'Library/Developer/CoreSimulator/Devices' / udid / 'data/Library/Logs/DiagnosticReports']
    with tempfile.TemporaryDirectory(prefix='multies-mail-smoke-') as tmp:
        passed = []
        for case in ('inbox', 'search'):
            debug = Path(tmp) / case
            debug.mkdir(mode=0o700)
            try:
                passed.append(run_case(sim, udid, maestro, case, executable, roots, debug))
            finally:
                # Only our uniquely identified fixture on the selected temporary simulator.
                command(sim + ['terminate', udid, BUNDLE], 10)
    return 0 if all(passed) else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (Blocked, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f'BLOCKED: {error}' if isinstance(error, Blocked) else 'BLOCKED: unable to complete local tool check.')
        raise SystemExit(2)
