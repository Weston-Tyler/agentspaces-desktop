import ai.badmonkey.agentspaces.api.ad.GroupAdvertisement;
import ai.badmonkey.agentspaces.api.space.ConflictStrategyType;
import ai.badmonkey.agentspaces.identity.PeerIdentity;
import ai.badmonkey.agentspaces.peering.membership.GroupMembership;
import ai.badmonkey.agentspaces.peering.node.GroupFounding;
import ai.badmonkey.agentspaces.peering.node.PeerNode;
import ai.badmonkey.agentspaces.peering.transport.TcpTransport;
import ai.badmonkey.agentspaces.space.replicated.ReplicatedSpace;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/** Local test seed assembled entirely from the owning upstream runtime. No model, task driver or custom transport. */
public class LoopbackSeed {
 public static void main(String[] args) throws Exception {
  var identity=PeerIdentity.generate();
  var founding=GroupFounding.found(identity,"desktop-local-fixture",GroupAdvertisement.MembershipPolicy.OPEN,
    ConflictStrategyType.LEASE_RACE,GroupAdvertisement.GossipParameters.defaults(),Instant.ofEpochSecond(System.currentTimeMillis()/1000),Duration.ofHours(1));
  var node=PeerNode.builder(identity).build();node.listen(new TcpTransport(),"127.0.0.1:"+args[0]);
  var runtime=node.joinGroup(founding,new GroupMembership.Config(Duration.ofSeconds(30),Duration.ofSeconds(2),2),List.of());
  var context=ReplicatedSpace.builder(runtime,"desktop-fixture-context",identity,"seed").build();
  var work=ReplicatedSpace.builder(runtime,"desktop-fixture-work",identity,"seed").build();
  node.startTicking(Duration.ofMillis(100));
  Runtime.getRuntime().addShutdownHook(new Thread(()->{context.close();work.close();node.close();}));
  System.out.println("GROUP="+founding.advertisement().group().value());System.out.flush();
  Thread.currentThread().join();
 }
}
