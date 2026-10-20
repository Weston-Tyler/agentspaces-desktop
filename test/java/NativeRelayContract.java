import java.net.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.*;
import ai.badmonkey.agentspaces.api.spi.*;
import ai.badmonkey.agentspaces.common.id.PeerId;
import ai.badmonkey.agentspaces.identity.PeerIdentity;

/** Binary stream, admission, bounded replay and fallback contracts; no native models. */
public final class NativeRelayContract {
 static void check(boolean v,String why){if(!v)throw new AssertionError(why);}
 static final class Wire implements TransportConnection {
  Wire other; Consumer<byte[]> receive; Runnable close=()->{}; boolean ended; final PeerId peer;
  final BlockingQueue<byte[]> inbox=new LinkedBlockingQueue<>();
  Wire(PeerId peer){this.peer=peer;}
  public String remoteAddress(){return "fixture";}
  public Optional<PeerId> attestedPeer(){return Optional.ofNullable(peer);}
  public void send(byte[] b)throws IOException{if(ended)throw new IOException();other.inbox.add(b.clone());}
  public void onReceive(Consumer<byte[]> r){receive=r;Thread.startVirtualThread(()->{try{while(!ended){byte[] b=inbox.take();r.accept(b);}}catch(InterruptedException ignored){}});}
  public void onClose(Runnable r){close=r;}
  public void close(){if(ended)return;ended=true;close.run();if(other!=null&&!other.ended)other.close();}
 }
 public static void main(String[] args)throws Exception {
  PeerId a=PeerIdentity.generate().peerId(),b=PeerIdentity.generate().peerId();
  try(var target=new ServerSocket(0,8,InetAddress.getLoopbackAddress());var fallback=new ServerSocket(0,8,InetAddress.getLoopbackAddress());
      var left=new NativeTransportRelay(a,b,true);var right=new NativeTransportRelay(b,a,false)){
   right.target("echo",target.getLocalPort());
   var accepted=new AtomicInteger();
   Thread.startVirtualThread(()->{try{while(!target.isClosed()){var s=target.accept();accepted.incrementAndGet();Thread.startVirtualThread(()->{try(s){s.getInputStream().transferTo(s.getOutputStream());s.shutdownOutput();}catch(Exception ignored){}});}}catch(Exception ignored){}});
   var x=new Wire(b);var y=new Wire(a);x.other=y;y.other=x;left.attach(x,"quic");right.attach(y,"quic");
   var health=java.nio.file.Files.createTempDirectory("relay-health-");
   check(!left.publishHealth(health.resolve("missing/health.json")),"health file failure is advisory");
   check(!left.link.ended,"health write failure preserves native transport");
   check(left.publishHealth(health.resolve("health.json")),"health publishing recovers");
   java.nio.file.Files.delete(health.resolve("health.json"));java.nio.file.Files.delete(health);
   int port=left.forward(0,"echo",null);
   byte[] data=new byte[512*1024];new Random(23).nextBytes(data);
   try(var s=new Socket("127.0.0.1",port)){s.setSoTimeout(10000);var send=CompletableFuture.runAsync(()->{try{s.getOutputStream().write(data);s.shutdownOutput();}catch(IOException e){throw new RuntimeException(e);}});byte[] result=s.getInputStream().readAllBytes();send.get();check(Arrays.equals(data,result),"binary order, credit flow and half-close");}
   check(accepted.get()==1,"one remote connection");
   int refused=left.forward(0,"missing",null);
   try(var s=new Socket("127.0.0.1",refused)){s.setSoTimeout(4000);s.getOutputStream().write(1);check(s.getInputStream().read()==-1,"unknown route refused");}
   check(accepted.get()==1,"denied route opened no target");
   try(var saved=new ServerSocket(0,8,InetAddress.getLoopbackAddress())){
    Thread.startVirtualThread(()->{try(var s=saved.accept()){s.getInputStream().transferTo(s.getOutputStream());}catch(Exception ignored){}});
    int p=left.forward(0,"missing",new NativeTransportRelay.Fallback("127.0.0.1",saved.getLocalPort(),null));
    try(var s=new Socket("127.0.0.1",p)){s.setSoTimeout(4000);s.getOutputStream().write(31);check(s.getInputStream().read()==31,"explicit pre-byte refusal can fall back");}
   }
   // Independent concurrent duplex streams must not mix bytes or consume unbounded credit.
   var jobs=new ArrayList<CompletableFuture<Void>>();
   for(int n=0;n<12;n++){final int value=n;jobs.add(CompletableFuture.runAsync(()->{try(var socket=new Socket("127.0.0.1",port)){socket.setSoTimeout(5000);socket.getOutputStream().write(value);socket.shutdownOutput();check(socket.getInputStream().read()==value,"stream isolation");check(socket.getInputStream().read()==-1,"concurrent half-close");}catch(Exception e){throw new RuntimeException(e);}}));}
   CompletableFuture.allOf(jobs.toArray(CompletableFuture[]::new)).get(10,TimeUnit.SECONDS);

   var duplicate=new Wire(b);check(!left.attach(duplicate,"quic")&&duplicate.ended,"replacement cannot interrupt active link");
   var evil=new Wire(PeerIdentity.generate().peerId());check(!left.attach(evil,"quic")&&evil.ended,"exact peer pin");
   var unattested=new Wire(null);check(!left.attach(unattested,"tls")&&unattested.ended,"unattested refused");
   // An accepted stream never falls back after a link failure, even with unread data.
   Thread.startVirtualThread(()->{try(var s=fallback.accept()){accepted.addAndGet(1000);}catch(Exception ignored){}});
   int guarded=left.forward(0,"echo",new NativeTransportRelay.Fallback("127.0.0.1",fallback.getLocalPort(),null));
   try(var s=new Socket("127.0.0.1",guarded)){s.setSoTimeout(4000);s.getOutputStream().write(42);check(s.getInputStream().read()==42,"real stream accepted");x.close();check(s.getInputStream().read()==-1,"broken stream closes");}
   Thread.sleep(100);check(accepted.get()==14,"no replay to fallback after acceptance");
   // Before forwarding bytes, an unavailable link may use the saved SSH route.
   try(var echo=new ServerSocket(0,8,InetAddress.getLoopbackAddress())){
    Thread.startVirtualThread(()->{try(var s=echo.accept()){s.getInputStream().transferTo(s.getOutputStream());}catch(Exception ignored){}});
    int p=left.forward(0,"echo",new NativeTransportRelay.Fallback("127.0.0.1",echo.getLocalPort(),null));
    try(var s=new Socket("127.0.0.1",p)){s.setSoTimeout(4000);s.getOutputStream().write(17);check(s.getInputStream().read()==17,"pre-submission fallback");}
   }
   boolean bad=false;try{right.target("bad",0);}catch(IllegalArgumentException e){bad=true;}check(bad,"invalid target refused");
   check(((Number)left.health().get("rejectedPeers")).longValue()==2,"admission counters");
   System.out.println("Native relay contracts passed: binary/half-close, exact peer pin, unattested refusal, route allowlist, no uncertain replay, pre-byte fallback, bounds");
  }
 }
}
