import { SshDataReader, SshDataWriter } from "@microsoft/dev-tunnels-ssh";
import { PortForwardRequestMessage } from "@microsoft/dev-tunnels-ssh-tcp";
/**
 * Extends port-forward request messagse to include additional properties required
 * by the tunnel relay.
 */
export declare class PortRelayRequestMessage extends PortForwardRequestMessage {
    /**
     * Access token with 'host' scope used to authorize the port-forward request.
     * A long-running host may need to handle the `refreshingTunnelAccessToken` event to
     * refresh the access token before forwarding additional ports.
     */
    accessToken?: string;
    protected onWrite(writer: SshDataWriter): void;
    protected onRead(reader: SshDataReader): void;
}
//# sourceMappingURL=portRelayRequestMessage.d.ts.map