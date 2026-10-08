import ai.badmonkey.agentspaces.api.ad.GroupAdvertisement;
import ai.badmonkey.agentspaces.api.space.*;
import ai.badmonkey.agentspaces.identity.PeerIdentity;
import ai.badmonkey.agentspaces.peering.membership.GroupMembership;
import ai.badmonkey.agentspaces.peering.node.GroupFounding;
import ai.badmonkey.agentspaces.peering.node.PeerNode;
import ai.badmonkey.agentspaces.peering.transport.TcpTransport;
import ai.badmonkey.agentspaces.space.replicated.ReplicatedSpace;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import java.io.*;

/** Owning signed claims/completions; native execution belongs to the queue adapter. */
public class NativeQueueWorkProof {
  public record Request(String requestId, String target, String nativeThreadId,
                        String question, boolean fixture) {}
  public record Call(String requestId, String requestEntryId, String target, String nativeThreadId) {}
  public record Result(String requestId, String requestEntryId, String target,
                       String nativeThreadId, String nativeTurnId, String queuedSubmissionId,
                       String text, Map<String,Object> usage, boolean fixture) {}
  private static final ObjectMapper JSON = new ObjectMapper();
  private static void emit(String kind, Object value) throws Exception {
    System.out.println(kind + "=" + Base64.getEncoder().encodeToString(JSON.writeValueAsBytes(value)));
    System.out.flush();
  }
  public static void main(String[] args) throws Exception {
    var identity = PeerIdentity.generate();
    var founding = GroupFounding.found(identity, "desktop-native-queue-proof",
      GroupAdvertisement.MembershipPolicy.OPEN, ConflictStrategyType.LEASE_RACE,
      GroupAdvertisement.GossipParameters.defaults(),
      Instant.ofEpochSecond(System.currentTimeMillis()/1000), Duration.ofHours(1));
    var node = PeerNode.builder(identity).build();
    node.listen(new TcpTransport(), "127.0.0.1:" + args[0]);
    var runtime = node.joinGroup(founding,
      new GroupMembership.Config(Duration.ofSeconds(30), Duration.ofSeconds(2), 2), List.of());
    var work = ReplicatedSpace.builder(runtime, "desktop-native-queue-work", identity, "seed").build();
    var other = ReplicatedSpace.builder(runtime, "desktop-native-queue-other", identity, "seed").build();
    var input = new BufferedReader(new InputStreamReader(System.in));
    node.startTicking(Duration.ofMillis(100));
    try {
      System.out.println("GROUP=" + founding.advertisement().group().value()); System.out.flush();
      if (!"RUN".equals(input.readLine())) throw new IllegalStateException("Explicit run signal required");
      var all = Template.of(Request.class);
      var deadline = Instant.now().plusSeconds(15);
      while ((work.readAll(all, 10).size() != 3 || other.readAll(all, 10).size() != 1)
             && Instant.now().isBefore(deadline)) Thread.sleep(100);
      if (work.readAll(all, 10).size() != 3 || other.readAll(all, 10).size() != 1)
        throw new IllegalStateException("Expected bounded requests and other-space distractor");
      for (var id : List.of("native-A-1", "native-B-1", "native-A-2")) {
        String target = id.contains("-A-") ? "targetA" : "targetB";
        var actor = work.as(identity.agentIdentity(target));
        var template = Template.of(Request.class)
          .where("target", Matchers.eq(target)).where("requestId", Matchers.eq(id));
        var taken = actor.take(template, Lease.of(Duration.ofSeconds(240)), Duration.ofSeconds(10)).orElseThrow();
        var request = taken.entry();
        if (request.fixture() || !request.target().equals(target)) throw new IllegalStateException("Wrong work source");
        emit("CALL", new Call(id, taken.entryId().toString(), target, request.nativeThreadId()));
        var line = input.readLine();
        if (line == null || !line.startsWith("RESULT=")) throw new IllegalStateException("Native result missing; no automatic retry");
        var result = JSON.readValue(Base64.getDecoder().decode(line.substring(7)), Result.class);
        if (!result.requestId().equals(id) || !result.requestEntryId().equals(taken.entryId().toString())
            || !result.target().equals(target) || !result.nativeThreadId().equals(request.nativeThreadId())
            || result.fixture() || result.nativeTurnId() == null || result.nativeTurnId().isBlank()
            || result.text() == null || result.text().isBlank()) throw new IllegalStateException("Native result attribution mismatch");
        var completed = actor.complete(taken, result, Lease.of(Duration.ofMinutes(10)));
        emit("COMPLETED", Map.of("requestId", id, "requestEntryId", taken.entryId().toString(),
          "resultEntryId", completed.entryId().toString(), "target", target));
      }
      if (work.take(all, Lease.of(Duration.ofSeconds(10)), Duration.ofMillis(700)).isPresent()
          || other.readAll(all, 10).size() != 1) throw new IllegalStateException("Consumed work or other-space work was retaken");
      System.out.println("DONE=native-queue-signed-results"); System.out.flush();
      input.readLine();
    } finally { other.close(); work.close(); node.close(); }
  }
}
