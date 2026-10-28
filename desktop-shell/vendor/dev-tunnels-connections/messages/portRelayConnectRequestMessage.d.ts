import { SshDataReader, SshDataWriter } from "@microsoft/dev-tunnels-ssh";
import { PortForwardChannelOpenMessage } from "@microsoft/dev-tunnels-ssh-tcp";
/**
 * Extends port-forward channel open messages to include additional properties required
 * by the tunnel relay.
 */
export declare class PortRelayConnectRequestMessage extends PortForwardChannelOpenMessage {
    /**
     * Access token with 'connect' scope used to authorize the port connection request.
     * A long-running client may need handle the `RefreshingTunnelAccessToken` event to refresh
     * the access token before opening additional connections (channels) to forwarded ports.
     */
    accessToken?: string;
    /**
     * Gets or sets a value indicating whether end-to-end encryption is requested for the
     * connection.
     * The tunnel relay or tunnel host may enable E2E encryption or not depending on capabilities
     * and policies. The channel open response will indicate whether E2E encryption is actually
     * enabled for the connection.
     */
    isE2EEncryptionRequested: boolean;
    protected onWrite(writer: SshDataWriter): void;
    protected onRead(reader: SshDataReader): void;
}
//# sourceMappingURL=portRelayConnectRequestMessage.d.ts.map