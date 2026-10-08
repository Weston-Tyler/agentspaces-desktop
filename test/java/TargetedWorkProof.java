import ai.badmonkey.agentspaces.api.ad.GroupAdvertisement;
import ai.badmonkey.agentspaces.api.space.*;
import ai.badmonkey.agentspaces.identity.PeerIdentity;
import ai.badmonkey.agentspaces.peering.membership.GroupMembership;
import ai.badmonkey.agentspaces.peering.node.GroupFounding;
import ai.badmonkey.agentspaces.peering.node.PeerNode;
import ai.badmonkey.agentspaces.peering.transport.TcpTransport;
import ai.badmonkey.agentspaces.space.replicated.ReplicatedSpace;
import java.time.*;
import java.util.*;
import java.io.*;

/** Real owning-runtime template/claim proof; all work payloads are synthetic. */
public class TargetedWorkProof {
  public record Request(String requestId, String target, boolean fixture) {}
  public record Result(String requestId, String requestEntryId, String target,
                       String nativeTurnId, String result, boolean fixture) {}
  public static void main(String[] args) throws Exception {
    var identity = PeerIdentity.generate();
    var founding = GroupFounding.found(identity, "desktop-target-fixture",
      GroupAdvertisement.MembershipPolicy.OPEN, ConflictStrategyType.LEASE_RACE,
      GroupAdvertisement.GossipParameters.defaults(),
      Instant.ofEpochSecond(System.currentTimeMillis()/1000), Duration.ofHours(1));
    var node = PeerNode.builder(identity).build();
    node.listen(new TcpTransport(), "127.0.0.1:" + args[0]);
    var runtime = node.joinGroup(founding,
      new GroupMembership.Config(Duration.ofSeconds(30), Duration.ofSeconds(2), 2), List.of());
    var work = ReplicatedSpace.builder(runtime, "desktop-target-fixture-work", identity, "seed").build();
    var unrelated = ReplicatedSpace.builder(runtime, "desktop-target-fixture-other", identity, "seed").build();
    node.startTicking(Duration.ofMillis(100));
    try {
      System.out.println("GROUP=" + founding.advertisement().group().value());
      System.out.flush();
      if (!"RUN".equals(new BufferedReader(new InputStreamReader(System.in)).readLine()))
        throw new IllegalStateException("Expected explicit fixture run signal");
      // Ensure both spaces have decoded the same schema, including the distractor.
      var all = Template.of(Request.class);
      var limit = Instant.now().plusSeconds(12);
      while ((work.readAll(all, 10).size() != 3 || unrelated.readAll(all, 10).size() != 1)
             && Instant.now().isBefore(limit)) Thread.sleep(100);
      if (work.readAll(all, 10).size() != 3 || unrelated.readAll(all, 10).size() != 1)
        throw new IllegalStateException("Expected three target requests and one other-space request");
      for (var target : List.of("targetA", "targetB")) {
        var actor = work.as(identity.agentIdentity(target));
        var template = Template.of(Request.class).where("target", Matchers.eq(target));
        int expected = target.equals("targetA") ? 2 : 1;
        for (int i = 0; i < expected; i++) {
          var taken = actor.take(template, Lease.of(Duration.ofSeconds(20)), Duration.ofSeconds(8)).orElseThrow();
          if (!target.equals(taken.entry().target()) || !taken.entry().fixture())
            throw new IllegalStateException("Wrong target or nonfixture payload");
          var request = taken.entry();
          String entry = taken.entryId().toString();
          String turn = "fixture-turn-" + request.requestId();
          var result = actor.complete(taken,
            new Result(request.requestId(), entry, target, turn, "bounded synthetic result", true),
            Lease.of(Duration.ofMinutes(5)));
          System.out.println("RESULT=" + request.requestId() + "|" + entry + "|" + result.entryId() + "|" + target + "|" + turn);
          System.out.flush();
        }
        if (actor.take(template, Lease.of(Duration.ofSeconds(10)), Duration.ofMillis(700)).isPresent())
          throw new IllegalStateException("Consumed target or other-space request was retaken");
      }
      if (unrelated.readAll(all, 10).size() != 1)
        throw new IllegalStateException("Other-space request was consumed");
      System.out.println("DONE=targeted-take-and-other-space-isolation");
      System.out.flush();
      // Let the remote observer acknowledge the signed results/completions before close.
      new BufferedReader(new InputStreamReader(System.in)).readLine();
    } finally { unrelated.close(); work.close(); node.close(); }
  }
}
