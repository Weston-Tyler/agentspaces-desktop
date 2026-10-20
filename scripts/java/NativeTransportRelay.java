import ai.badmonkey.agentspaces.api.spi.*;
import ai.badmonkey.agentspaces.common.id.PeerId;
import ai.badmonkey.agentspaces.identity.*;
import ai.badmonkey.agentspaces.peering.transport.TlsTcpTransport;
import ai.badmonkey.agentspaces.transport.quic.QuicTransport;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.net.*;
import java.nio.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.security.cert.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Optional byte carrier over the owning AgentSpaces reliable Transport SPI.
 * No tasks, native commands, source enrollment, grants or content replication.
 * Fixed named loopback targets only; source authentication remains end-to-end.
 */
public final class NativeTransportRelay implements AutoCloseable {
 static final int OPEN=1,READY=2,DATA=3,ACK=4,FIN=5,CLOSE=6,PING=7,PONG=8;
 static final int CHUNK=16384,MAX_STREAMS=64,HEADER=21;
 static final ObjectMapper JSON=new ObjectMapper();
 record Fallback(String host,int port,String bind) {
  Fallback {if(host==null||host.isBlank()||port<1||port>65535||!(bind==null||bind.equals("127.0.0.2")))throw new IllegalArgumentException("Invalid fallback");}
 }
 final PeerId self,remote; final boolean initiator;
 final Map<String,Integer> targets=new ConcurrentHashMap<>();
 final Map<String,AtomicLong> counters=new ConcurrentHashMap<>();
 final List<ServerSocket> listeners=new CopyOnWriteArrayList<>();
 volatile Link link; volatile boolean closed;
 final AtomicLong rejectedPeers=new AtomicLong();
 NativeTransportRelay(PeerId self,PeerId remote,boolean initiator){this.self=self;this.remote=remote;this.initiator=initiator;}
 static boolean route(String name){return name!=null&&name.matches("[a-z][a-z0-9-]{0,47}");}
 void count(String key,long n){counters.computeIfAbsent(key,k->new AtomicLong()).addAndGet(n);}
 void target(String name,int port){if(!route(name)||port<1||port>65535)throw new IllegalArgumentException("Invalid fixed loopback target");targets.put(name,port);}
 synchronized boolean attach(TransportConnection c,String scheme){
  if(closed||!List.of("quic","tls").contains(scheme)||c.attestedPeer().filter(remote::equals).isEmpty()){
   rejectedPeers.incrementAndGet();c.close();return false;
  }
  // A replacement connection cannot abandon active streams.
  if(link!=null&&!link.ended){c.close();return false;}
  Link next=new Link(c,scheme);link=next;next.start();return true;
 }
 int forward(int port,String name,Fallback fallback)throws IOException {
  if(closed||!route(name)||port<0||port>65535)throw new IllegalArgumentException("Invalid loopback forward");
  ServerSocket server=new ServerSocket();server.bind(new InetSocketAddress("127.0.0.1",port),32);listeners.add(server);
  var permits=new Semaphore(MAX_STREAMS);
  Thread.startVirtualThread(()->{while(!closed&&!server.isClosed())try{
   Socket socket=server.accept();socket.setTcpNoDelay(true);
   if(!permits.tryAcquire()){socket.close();continue;}
   Thread.startVirtualThread(()->{try{forward(socket,name,fallback);}finally{permits.release();}});
  }catch(IOException ignored){break;}});return server.getLocalPort();
 }
 void forward(Socket local,String name,Fallback fallback){
  Stream stream=null;Link active=link;
  try{
   if(active!=null&&!active.ended){
    stream=active.open(local,name);
    if(stream.ready.get(8,TimeUnit.SECONDS)){
     count(name+"."+active.scheme+".connections",1);synchronized(stream){if(stream.closed)throw new IOException("Stream closed before activation");stream.activated=true;}stream.startWriter();stream.pump();return;
    }
   }
  }catch(Exception ignored){}
  // Local bytes have not been read or forwarded. Never enter here after pump.
  if(stream!=null){stream.socket=null;stream.abandon(true);}
  if(closed||fallback==null){try{local.close();}catch(IOException ignored){}return;}
  count(name+".ssh-fallback.connections",1);
  try(local;Socket saved=new Socket()){
   if(fallback.bind!=null)saved.bind(new InetSocketAddress(fallback.bind,0));
   saved.connect(new InetSocketAddress(fallback.host,fallback.port),3000);saved.setTcpNoDelay(true);
   var reply=CompletableFuture.runAsync(()->{try{localCopy(saved,local);}catch(IOException ignored){try{local.close();}catch(IOException ignoredAgain){}}});
   localCopy(local,saved);reply.join();
  }catch(Exception ignored){}
 }
 static void localCopy(Socket from,Socket to)throws IOException{from.getInputStream().transferTo(to.getOutputStream());to.shutdownOutput();}
 final class Link {
  final TransportConnection connection;final String scheme;
  final Map<UUID,Stream> streams=new ConcurrentHashMap<>();
  final BlockingQueue<byte[]> inbox=new ArrayBlockingQueue<>(256);
  volatile boolean ended;volatile long lastReceive=System.nanoTime();
  Link(TransportConnection c,String scheme){connection=c;this.scheme=scheme;}
  void start(){
   connection.onClose(this::close);
   connection.onReceive(bytes->{if(bytes.length<HEADER||bytes.length>HEADER+CHUNK||!inbox.offer(bytes))close();});
   Thread.startVirtualThread(()->{try{while(!ended){byte[] bytes=inbox.poll(1,TimeUnit.SECONDS);if(bytes!=null)receive(bytes);}}catch(Exception e){close();}});
   Thread.startVirtualThread(()->{try{while(!ended){Thread.sleep(10000);if(System.nanoTime()-lastReceive>TimeUnit.SECONDS.toNanos(35)){close();break;}send(PING,new UUID(0,0),0,new byte[0]);}}catch(Exception e){close();}});
  }
  synchronized void send(int kind,UUID id,int seq,byte[] payload)throws IOException {
   if(ended||payload.length>CHUNK)throw new IOException("Link closed or frame exceeds bound");
   ByteBuffer b=ByteBuffer.allocate(HEADER+payload.length);b.put((byte)kind).putLong(id.getMostSignificantBits()).putLong(id.getLeastSignificantBits()).putInt(seq).put(payload);
   connection.send(b.array());count(scheme+".bytesOut",b.capacity());
  }
  Stream open(Socket local,String name)throws IOException {
   synchronized(streams){if(ended||streams.size()>=MAX_STREAMS)throw new IOException("Stream limit");
    UUID id=UUID.randomUUID(); // Separate UUID namespaces for each opener role.
    id=new UUID((id.getMostSignificantBits()&Long.MAX_VALUE)|(initiator?Long.MIN_VALUE:0),id.getLeastSignificantBits());
    Stream s=new Stream(this,id,local,name);streams.put(id,s);
    try{send(OPEN,id,0,name.getBytes(java.nio.charset.StandardCharsets.US_ASCII));return s;}
    catch(IOException e){streams.remove(id);throw e;}
   }
  }
  void receive(byte[] bytes)throws IOException {
   lastReceive=System.nanoTime();count(scheme+".bytesIn",bytes.length);
   ByteBuffer b=ByteBuffer.wrap(bytes);int kind=b.get()&255;UUID id=new UUID(b.getLong(),b.getLong());int seq=b.getInt();byte[] payload=new byte[b.remaining()];b.get(payload);
   if(kind==PING||kind==PONG){if(!id.equals(new UUID(0,0))||seq!=0||payload.length!=0)throw new IOException("Invalid heartbeat");if(kind==PING)send(PONG,id,0,new byte[0]);return;}
   if(kind==OPEN){
    String name=new String(payload,java.nio.charset.StandardCharsets.US_ASCII);
    if(seq!=0||!route(name)||!targets.containsKey(name)||(id.getMostSignificantBits()<0)==initiator){send(CLOSE,id,0,new byte[0]);return;}
    Stream s;
    synchronized(streams){if(streams.size()>=MAX_STREAMS||streams.containsKey(id)){send(CLOSE,id,0,new byte[0]);return;}s=new Stream(this,id,null,name);streams.put(id,s);}
    Thread.startVirtualThread(()->{try{
     Socket target=new Socket();s.socket=target;target.connect(new InetSocketAddress("127.0.0.1",targets.get(name)),3000);target.setTcpNoDelay(true);
     if(s.closed||ended){target.close();return;}
     s.ready.complete(true);s.startWriter();send(READY,id,0,new byte[0]);count(name+"."+scheme+".accepted",1);s.pump();
    }catch(Exception e){s.abandon(true);}});return;
   }
   Stream s=streams.get(id);if(s==null)return; // A late close/ack after local disposal is inert.
   if(kind==READY){if(payload.length!=0||seq!=0||!s.ready.complete(true))throw new IOException("Invalid ready");}
   else if(kind==ACK){if(payload.length!=0||seq!=s.waitingAck||!s.ack.offer(seq))throw new IOException("Invalid credit");}
   else if(kind==DATA||kind==FIN){
    if(!s.ready.isDone()||s.receivedFin||seq!=s.receiveSequence++||kind==FIN&&payload.length!=0||!s.received.offer(new Frame(kind,seq,payload)))throw new IOException("Invalid stream sequence or credit");
    if(kind==FIN)s.receivedFin=true;
   }else if(kind==CLOSE){if(payload.length!=0||seq!=0)throw new IOException("Invalid close");s.abandon(false);}
   else throw new IOException("Unknown frame");
  }
  void close(){if(ended)return;ended=true;connection.close();for(Stream s:streams.values())s.abandon(false);inbox.clear();}
 }
 record Frame(int kind,int seq,byte[] payload){}
 final class Stream {
  final Link owner;final UUID id;final String name;final boolean localOrigin;
  volatile Socket socket;final CompletableFuture<Boolean> ready=new CompletableFuture<>();
  final BlockingQueue<Frame> received=new ArrayBlockingQueue<>(2);final BlockingQueue<Integer> ack=new ArrayBlockingQueue<>(1);
  volatile boolean closed,receivedFin,writeFin,readFin,activated;volatile int waitingAck=-1;int receiveSequence=1,sendSequence=1;
  Stream(Link owner,UUID id,Socket socket,String name){this.owner=owner;this.id=id;this.socket=socket;this.name=name;localOrigin=socket!=null;activated=!localOrigin;}
  void startWriter(){Thread.startVirtualThread(()->{try{
   while(!closed){Frame frame=received.poll(1,TimeUnit.SECONDS);if(frame==null)continue;
    if(frame.kind==DATA){socket.getOutputStream().write(frame.payload);count(name+"."+owner.scheme+".received",frame.payload.length);}
    else{socket.shutdownOutput();writeFin=true;}
    owner.send(ACK,id,frame.seq,new byte[0]);
    if(writeFin){if(readFin)abandon(false);return;}
   }
  }catch(Exception e){abandon(true);}});}
  void transmit(int kind,byte[] payload)throws Exception {
   int seq=sendSequence++;waitingAck=seq;owner.send(kind,id,seq,payload);
   Integer got=ack.poll(30,TimeUnit.SECONDS);if(got==null||got!=seq||closed)throw new IOException("Stream credit expired");waitingAck=-1;
  }
  void pump(){try{
   byte[] bytes=new byte[CHUNK];int size;
   while(!closed&&(size=socket.getInputStream().read(bytes))!=-1){transmit(DATA,Arrays.copyOf(bytes,size));count(name+"."+owner.scheme+".sent",size);}
   if(!closed){transmit(FIN,new byte[0]);readFin=true;if(writeFin)abandon(false);}
  }catch(Exception e){abandon(true);}}
  synchronized void abandon(boolean notify){
   if(closed)return;closed=true;owner.streams.remove(id,this);ready.complete(false);ack.offer(-1);
   if(socket!=null&&(!localOrigin||activated))try{socket.close();}catch(IOException ignored){}
   if(notify)try{owner.send(CLOSE,id,0,new byte[0]);}catch(IOException ignored){}
  }
 }
 Map<String,Object> health(){
  Link l=link;var counts=new TreeMap<String,Long>();counters.forEach((k,v)->counts.put(k,v.get()));
  return Map.of("at",Instant.now().toString(),"pid",ProcessHandle.current().pid(),"connected",l!=null&&!l.ended,"scheme",l!=null&&!l.ended?l.scheme:"unavailable","activeStreams",l!=null?l.streams.size():0,"counters",counts,"rejectedPeers",rejectedPeers.get(),"nativeTurnsCancelled",0,"contentStored",false);
 }
 public void close(){closed=true;for(var s:listeners)try{s.close();}catch(IOException ignored){}if(link!=null)link.close();}
 boolean publishHealth(Path path){try{save(path,health());return true;}catch(IOException e){count("healthWriteFailures",1);return false;}}
 static void save(Path path,Object value)throws IOException {
  Path tmp=path.resolveSibling(path.getFileName()+".tmp");JSON.writeValue(tmp.toFile(),value);
  try{Files.move(tmp,path,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException e){Files.move(tmp,path,StandardCopyOption.REPLACE_EXISTING);}
 }
 public static void main(String[] args)throws Exception {
  if(args.length!=1)throw new IllegalArgumentException("Owner-private properties file required");
  Path configPath=Path.of(args[0]).toAbsolutePath(),root=configPath.getParent();Properties config=new Properties();try(var in=Files.newInputStream(configPath)){config.load(in);}
  Path credentials=Path.of(config.getProperty("credentials.root",root.toString()));
  // Existing keys are mandatory: starting this adapter must not create a new identity.
  if(!Files.isRegularFile(credentials.resolve("identity/peer.key")))throw new IllegalArgumentException("Existing transport identity required");
  var id=FileKeystore.loadOrCreate(credentials.resolve("identity"));PeerId remote=PeerId.of(config.getProperty("remote.peer"));
  var serving=ServingCredential.fromKeyStore(credentials.resolve("channel.p12"),Files.readString(credentials.resolve("channel.password")).trim().toCharArray());
  X509Certificate ca;try(var in=Files.newInputStream(credentials.resolve("ca.crt"))){ca=(X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(in);}
  var trust=ChannelTrust.of(List.of(ca));
  boolean client=config.getProperty("mode").equals("client");if(!client&&!config.getProperty("mode").equals("server"))throw new IllegalArgumentException("client|server required");
  try(var channel=FileChannel.open(root.resolve("relay.lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);var lock=channel.tryLock();
      var quic=new QuicTransport(id,serving,trust);var relay=new NativeTransportRelay(id.peerId(),remote,client)){
   if(lock==null)throw new IllegalStateException("Relay already owned");
   Runtime.getRuntime().addShutdownHook(new Thread(relay::close));
   for(String key:config.stringPropertyNames())if(key.startsWith("target."))relay.target(key.substring(7),Integer.parseInt(config.getProperty(key)));
   for(String key:config.stringPropertyNames())if(key.startsWith("forward.")){
    String name=key.substring(8);String[] route=config.getProperty(key).split(",",-1);String saved=config.getProperty("fallback."+name);Fallback fallback=null;
    if(saved!=null){String[] f=saved.split(",",-1);fallback=new Fallback(f[0],Integer.parseInt(f[1]),f.length==3?f[2]:null);}
    relay.forward(Integer.parseInt(route[0]),route[1],fallback);
   }
   var tls=new TlsTcpTransport(id,serving,trust);var transports=Map.<String,Transport>of("quic",quic,"tls",tls);var servers=new ArrayList<AutoCloseable>();
   if(!client)for(String scheme:List.of("quic","tls")){String address=config.getProperty("listen."+scheme);if(address!=null)servers.add(transports.get(scheme).listen(address,c->relay.attach(c,scheme)));}
   if(client)Thread.startVirtualThread(()->{while(!relay.closed){try{
    if(relay.link==null||relay.link.ended){for(String scheme:List.of("quic","tls")){String address=config.getProperty("seed."+scheme);if(address==null)continue;try{if(relay.attach(transports.get(scheme).dial(address),scheme))break;}catch(IOException ignored){}}}
    Thread.sleep(1000);
   }catch(InterruptedException e){return;}}});
   while(!relay.closed&&!Files.exists(root.resolve("relay.stop"))){relay.publishHealth(root.resolve("relay-health.json"));Thread.sleep(500);}
   relay.close();for(var server:servers)server.close();
  }
 }
}
