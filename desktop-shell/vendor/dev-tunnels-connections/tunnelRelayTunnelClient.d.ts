/// <reference types="node" />
import { Duplex } from 'stream';
import { Tunnel, TunnelConnectionMode, TunnelEndpoint } from '@microsoft/dev-tunnels-contracts';
import { CancellationToken, SshSessionClosedEventArgs, Stream, Trace } from '@microsoft/dev-tunnels-ssh';
import { ForwardedPortConnectingEventArgs, ForwardedPortsCollection } from '@microsoft/dev-tunnels-ssh-tcp';
import { TunnelClient } from './tunnelClient';
import { TunnelManagementClient } from '@microsoft/dev-tunnels-management';
import { TunnelConnectionOptions } from './tunnelConnectionOptions';
import { TunnelConnectionSession } from './tunnelConnectionSession';
import { PortForwardingEventArgs } from './portForwardingEventArgs';
export declare const webSocketSubProtocol = "tunnel-relay-client";
export declare const webSocketSubProtocolv2 = "tunnel-relay-client-v2-dev";
/**
 * Tunnel client implementation that connects via a tunnel relay.
 */
export declare class TunnelRelayTunnelClient extends TunnelConnectionSession implements TunnelClient {
    static readonly webSocketSubProtocol = "tunnel-relay-client";
    static readonly webSocketSubProtocolv2 = "tunnel-relay-client-v2-dev";
    constructor(managementClient?: TunnelManagementClient, trace?: Trace);
    private readonly portForwardingEmitter;
    private readonly sshSessionClosedEmitter;
    private acceptLocalConnectionsForForwardedPortsValue;
    private localForwardingHostAddressValue;
    private hostId?;
    private readonly disconnectedStreams;
    connectionModes: TunnelConnectionMode[];
    /**
     * Tunnel endpoints this client connects to.
     * Depending on implementation, the client may connect to one or more endpoints.
     */
    endpoints?: TunnelEndpoint[];
    /**
     * One or more SSH public keys published by the host with the tunnel endpoint.
     */
    protected hostPublicKeys?: string[];
    protected get isSshSessionActive(): boolean;
    /**
     * Event raised when a port is about to be forwarded to the client.
     *
     * The application may cancel this event to prevent specific port(s) from being
     * forwarded to the client. Cancelling prevents the tunnel client from listening on
     * a local socket for the port, AND prevents use of {@link connectToForwardedPort}
     * to open a direct stream connection to the port.
     */
    readonly portForwarding: import("vscode-jsonrpc").Event<PortForwardingEventArgs>;
    /**
     * Extensibility point and unit test hook.
     * This event fires when the client SSH session is disconnected or closed either by this client or Relay.
     */
    protected readonly sshSessionClosed: import("vscode-jsonrpc").Event<this>;
    /**
     * Get a value indicating if remote port is forwarded and has any channels open on the client,
     * whether used by local tcp listener if {AcceptLocalConnectionsForForwardedPorts} is true, or
     * streamed via <see cref="ConnectToForwardedPortAsync(int, CancellationToken)"/>.
     */
    protected hasForwardedChannels(port: number): boolean;
    /**
     * A value indicating whether local connections for forwarded ports are accepted.
     * Local connections are not accepted if the host is not NodeJS (e.g. browser).
     */
    get acceptLocalConnectionsForForwardedPorts(): boolean;
    set acceptLocalConnectionsForForwardedPorts(value: boolean);
    /**
     * Gets the local network interface address that the tunnel client listens on when
     * accepting connections for forwarded ports.
     */
    get localForwardingHostAddress(): string;
    set localForwardingHostAddress(value: string);
    get forwardedPorts(): ForwardedPortsCollection | undefined;
    connect(tunnel: Tunnel, options?: TunnelConnectionOptions, cancellation?: CancellationToken): Promise<void>;
    protected tunnelChanged(): void;
    private onRequest;
    startSshSession(stream: Stream, cancellation?: CancellationToken): Promise<void>;
    private configurePortForwardingService;
    private onForwardedPortAdded;
    /**
     * Invoked when a forwarded port is connecting. (Only for V2 protocol.)
     */
    protected onForwardedPortConnecting(e: ForwardedPortConnectingEventArgs): void;
    private onSecureStreamDisconnected;
    private onHostAuthenticating;
    private onSshServerAuthenticating;
    connectToForwardedPort(fowardedPort: number, cancellation?: CancellationToken): Promise<Duplex>;
    waitForForwardedPort(forwardedPort: number, cancellation?: CancellationToken): Promise<void>;
    private getSshSessionPfs;
    refreshPorts(): Promise<void>;
    /**
     * SSH session closed event handler.
     */
    protected onSshSessionClosed(e: SshSessionClosedEventArgs): void;
    private onSshSessionDisconnected;
    /**
     * Connect to the tunnel session on the relay service using the given access token for authorization.
     */
    protected connectClientToRelayServer(clientRelayUri: string, accessToken?: string): Promise<void>;
}
//# sourceMappingURL=tunnelRelayTunnelClient.d.ts.map