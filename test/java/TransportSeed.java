import ai.badmonkey.agentspaces.api.ad.GroupAdvertisement;
import ai.badmonkey.agentspaces.api.ad.PeerAdvertisement;
import ai.badmonkey.agentspaces.api.spi.Transport;
import ai.badmonkey.agentspaces.api.spi.TransportConnection;
import ai.badmonkey.agentspaces.api.space.ConflictStrategyType;
import ai.badmonkey.agentspaces.identity.PeerIdentity;
import ai.badmonkey.agentspaces.peering.membership.GroupMembership;
import ai.badmonkey.agentspaces.peering.node.GroupFounding;
import ai.badmonkey.agentspaces.peering.node.PeerNode;
import ai.badmonkey.agentspaces.peering.transport.TcpTransport;
import ai.badmonkey.agentspaces.space.replicated.ReplicatedSpace;
import ai.badmonkey.agentspaces.transport.dtls.DtlsTransport;
import ai.badmonkey.agentspaces.transport.quic.QuicTransport;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import java.io.IOException;

/** Synthetic loopback fixture only. The upstream PeerNode owns every relay,
 * transport, admission and signature; Desktop implements no transport bridge. */
public final class TransportSeed {
 // Accept Desktop clients, but prevent either Java node from dialing a TCP
 // shortcut to the other node. Only the chosen owning UDP binding can join them.
 private static Transport inboundTcp() {
  var tcp=new TcpTransport();
  return new Transport() {
   public String scheme(){return tcp.scheme();}
   public Set<Transport.Capability> capabilities(){return tcp.capabilities();}
   public TransportConnection dial(String address)throws IOException{throw new IOException("Fixture forbids outbound Java TCP");}
   public AutoCloseable listen(String address,Consumer<TransportConnection> accept)throws IOException{return tcp.listen(address,accept);}
  };
 }
 public static void main(String[] args) throws Exception {
  if(args.length!=4 || !List.of("dtls","quic").contains(args[3])) throw new IllegalArgumentException("TCP A, TCP B, UDP port, dtls|quic required");
  var aId=PeerIdentity.generate(); var bId=PeerIdentity.generate();
  var founding=GroupFounding.found(aId,"desktop-040-transport-fixture",GroupAdvertisement.MembershipPolicy.OPEN,
    ConflictStrategyType.LEASE_RACE,GroupAdvertisement.GossipParameters.defaults(),Instant.ofEpochSecond(System.currentTimeMillis()/1000),Duration.ofHours(1));
  var a=PeerNode.builder(aId).build(); var b=PeerNode.builder(bId).build();
  Transport aUdp=args[3].equals("dtls") ? new DtlsTransport(aId) : new QuicTransport(aId);
  Transport bUdp=args[3].equals("dtls") ? new DtlsTransport(bId) : new QuicTransport(bId);
  a.listen(inboundTcp(),"127.0.0.1:"+args[0]);
  a.listen(aUdp,"127.0.0.1:"+args[2]);
  b.listen(inboundTcp(),"127.0.0.1:"+args[1]); b.transport(bUdp);
  var config=new GroupMembership.Config(Duration.ofSeconds(30),Duration.ofSeconds(2),2);
  var atA=a.joinGroup(founding,config,List.of());
  var atB=b.joinGroup(founding,config,List.of(new PeerAdvertisement.Endpoint(args[3],"127.0.0.1:"+args[2],0)));
  var aContext=ReplicatedSpace.builder(atA,"desktop-fixture-context",aId,"seed").build();
  var bContext=ReplicatedSpace.builder(atB,"desktop-fixture-context",bId,"seed").build();
  var aWork=ReplicatedSpace.builder(atA,"desktop-fixture-work",aId,"seed").build();
  var bWork=ReplicatedSpace.builder(atB,"desktop-fixture-work",bId,"seed").build();
  a.startTicking(Duration.ofMillis(100)); b.startTicking(Duration.ofMillis(100));
  Runtime.getRuntime().addShutdownHook(new Thread(()->{
    aContext.close(); bContext.close(); aWork.close(); bWork.close(); a.close(); b.close();
    try { ((AutoCloseable)aUdp).close(); ((AutoCloseable)bUdp).close(); } catch(Exception ignored) {}
  }));
  long deadline=System.nanoTime()+Duration.ofSeconds(15).toNanos();
  while(atA.membership().member(bId.peerId()).isEmpty() || atB.membership().member(aId.peerId()).isEmpty()) {
    if(System.nanoTime()>deadline) throw new IllegalStateException("UDP gateway membership timed out");
    Thread.sleep(50);
  }
  System.out.println("GROUP="+founding.advertisement().group().value()); System.out.flush();
  Thread.currentThread().join();
 }
}
