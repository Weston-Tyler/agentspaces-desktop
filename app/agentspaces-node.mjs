// Desktop is a Node host. Use the owning Node entry to register TCP and async
// take context, and its OpenSSL crypto port for signed-replica verification.
// The portable core's default remains unchanged for other products/runtimes.
import { installCrypto } from '@agentspaces/client';
import { nodeCrypto } from '@agentspaces/client/node';
installCrypto(nodeCrypto);
export { loadOrCreateIdentity, agentKeys } from '@agentspaces/client/node';
