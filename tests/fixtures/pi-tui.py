import os,sys,pty,select,fcntl,termios,struct,signal,time,json

def diagnostic(event, **data):
 path=os.environ.get('PI_HUB_TEST_PROCESS_LOG')
 if path:
  with open(path,'a') as f:f.write(json.dumps(dict(at=time.time(),event=event,**data))+'\n')

pid,fd=pty.fork()
if pid==0:
 os.chdir(sys.argv[1]);os.execv(sys.argv[2],sys.argv[2:])
diagnostic('spawn',pid=pid,harness=os.getpid())
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
reaped=False
try:
 while True:
  ready,_,_=select.select([fd,sys.stdin],[],[],0.2)
  if fd in ready:
   try:data=os.read(fd,65536)
   except OSError as error:
    diagnostic('pty-read-error',error=str(error));break
   if not data:diagnostic('pty-eof');break
   sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
   if b'\x1b[6n' in data:os.write(fd,b'\x1b[1;1R')
   if b'\x1b[c' in data:os.write(fd,b'\x1b[?1;2c')
  if sys.stdin in ready:
   data=os.read(sys.stdin.fileno(),65536)
   if not data:diagnostic('stdin-eof');break
   os.write(fd,data)
finally:
 found,status=os.waitpid(pid,os.WNOHANG)
 if found:
  reaped=True;diagnostic('child-exit',pid=pid,status=status,exit=os.waitstatus_to_exitcode(status))
 if not reaped:
  diagnostic('cleanup-term',pid=pid)
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
  for _ in range(120):
   found,status=os.waitpid(pid,os.WNOHANG)
   if found:
    reaped=True;diagnostic('child-exit',pid=pid,status=status,exit=os.waitstatus_to_exitcode(status));break
   time.sleep(0.05)
 if not reaped:
  diagnostic('cleanup-kill',pid=pid)
  try:os.kill(pid,signal.SIGKILL)
  except ProcessLookupError:pass
  os.close(fd)
  for _ in range(20):
   found,status=os.waitpid(pid,os.WNOHANG)
   if found:diagnostic('child-exit',pid=pid,status=status,exit=os.waitstatus_to_exitcode(status));break
   time.sleep(0.05)
