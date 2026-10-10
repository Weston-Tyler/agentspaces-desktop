#!/usr/bin/env python3
"""Run an explicitly supplied Linux command through the companion's fair queue.
No credentials are printed. Existing machine locks remain the execution fence.
"""
import argparse, fcntl, json, os, re, signal, stat, subprocess, sys, time, urllib.request, urllib.error, uuid

class ApiError(Exception): pass

def request(config, path, value):
    data = json.dumps(value).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request(config['address'] + '/api/' + path, data=data,
                headers={'Host': config['authority'], 'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=12) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try: message = json.load(error).get('error', 'Request denied')
            except Exception: message = 'Request denied'
            raise ApiError(message) from None
        except (OSError, TimeoutError):
            if attempt == 2: raise ApiError('Transport outcome uncertain; inspect queue before retrying') from None
            time.sleep(1)

def change(config, action, **data):
    return request(config, 'machines/change', dict(action=action, deliveryId=str(uuid.uuid4()), **data))

def stop_group(process):
    # Always signal the group, including descendants left after the leader exits.
    for sig, pause in [(signal.SIGTERM, .5), (signal.SIGKILL, 0)]:
        try: os.killpg(process.pid, sig)
        except ProcessLookupError: pass
        if pause: time.sleep(pause)
    process.wait()

def run_locked(admission, command, gate=None):
    deadline = time.monotonic() + max(0, min(admission['minutes'] * 60, (admission['deadline'] / 1000) - time.time()))
    locks, process = [], None
    try:
        while time.monotonic() < deadline:
            try:
                for path in admission['lockPaths']:
                    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
                    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except Exception: os.close(fd); raise
                    locks.append(fd)
                break
            except BlockingIOError:
                for fd in locks: os.close(fd)
                locks.clear(); time.sleep(.25)
        if len(locks) != len(admission['lockPaths']): raise ApiError('Actual machine locks unavailable before reservation deadline')
        # Run the existing hold/memory admission check after taking the actual locks.
        if gate:
            process = subprocess.Popen(gate, start_new_session=True, pass_fds=tuple(locks))
            try: code = process.wait(timeout=max(.01, min(15, deadline-time.monotonic())))
            finally: stop_group(process)
            process = None
            if code: raise ApiError('Existing host admission gate refused this run')
        if time.monotonic() >= deadline: raise ApiError('Reservation deadline passed before execution')
        process = subprocess.Popen(command, start_new_session=True, pass_fds=tuple(locks))
        try: return process.wait(timeout=max(.01, deadline-time.monotonic()))
        except subprocess.TimeoutExpired: return 124
    finally:
        if process: stop_group(process)
        for fd in locks: os.close(fd)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', required=True, help='Private source-bound participant JSON on this host')
    p.add_argument('--source', required=True, help='Exact native thread ID matching the participant configuration')
    p.add_argument('--machine', required=True); p.add_argument('--title', required=True)
    p.add_argument('--minutes', type=int, default=15, choices=range(1,16));p.add_argument('--exclusive', action='store_true')
    p.add_argument('--wait-minutes', type=int, default=60, choices=range(1,1441))
    p.add_argument('command', nargs=argparse.REMAINDER); args=p.parse_args()
    command=args.command[1:] if args.command[:1]==['--'] else args.command
    if not command: p.error('Supply -- command [arguments]')
    metadata=os.lstat(args.config)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=os.getuid() or stat.S_IMODE(metadata.st_mode)!=0o600: p.error('Participant configuration must be owner-private (chmod 600)')
    with open(args.config) as file: config=json.load(file)
    if config.get('nativeThreadId')!=args.source or not re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}',args.source): p.error('Exact source identity required')
    if not re.fullmatch(r'127\.0\.0\.1:[1-9][0-9]{0,4}',config.get('authority','')) or int(config['authority'].split(':')[1])>65535 or not re.fullmatch(r'[a-f0-9]{64}',config.get('token','')): p.error('Invalid participant capability')
    from urllib.parse import urlsplit
    url=urlsplit(config.get('address',''))
    if url.scheme!='http' or url.hostname!='127.0.0.1' or not url.port or url.path or url.query or url.fragment or url.username or url.password: p.error('Literal loopback companion address required')
    def interrupted(_sig,_frame): raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM,interrupted)
    entry=None;admitted=False;result=1
    try:
        entry=change(config,'machine_request',machineId=args.machine,title=args.title,minutes=args.minutes,exclusive=args.exclusive)['entryId']
        wait_until=time.monotonic()+args.wait_minutes*60;heartbeat=time.monotonic()
        while time.monotonic()<wait_until:
            try:
                admission=change(config,'machine_acquire',entryId=entry);admitted=True;break
            except ApiError as error:
                if not any(s in str(error) for s in ['queue position','slots busy','Resource claim is still held','requires owner reconciliation']): raise
            if time.monotonic()-heartbeat>120:
                change(config,'machine_heartbeat',entryId=entry);heartbeat=time.monotonic()
            time.sleep(5)
        if not admitted: raise ApiError('Queue wait deadline reached')
        if admission['host']!=config.get('host'): raise ApiError('Reservation host differs from participant host')
        result=run_locked(admission,command,admission.get('gateCommand'))
        return result
    finally:
        if entry:
            try: change(config,'machine_release' if admitted else 'machine_cancel',entryId=entry,summary=f'Runner exited; command status {result}; owned process group stopped and file descriptors closed')
            except ApiError: print('Queue cleanup unconfirmed; inspect reservation before retrying.',file=sys.stderr)
if __name__=='__main__':
    try: sys.exit(main())
    except (ApiError,KeyboardInterrupt) as error:
        print(str(error) or 'Runner interrupted',file=sys.stderr);sys.exit(1)
