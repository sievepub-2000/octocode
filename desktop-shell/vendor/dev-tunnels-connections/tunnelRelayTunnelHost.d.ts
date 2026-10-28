import { TunnelPort, Tunnel } from '@microsoft/dev-tunnels-contracts';
import { TunnelManagementClient } from '@microsoft/dev-tunnels-management';
import { KeyPair, Trace } from '@microsoft/dev-tunnels-ssh';
import { ForwardedPortConnectingEventArgs, PortForwardingService, RemotePortForwarder } from '@microsoft/dev-tunnels-ssh-tcp';
import { CancellationToken } from 'vscode-jsonrpc';
import { TunnelHost } from './tunnelHost';
import { TunnelConnectionOptions } from './tunnelConnectionOptions';
import { TunnelConnectionSession } from './tunnelConnectionSession';
/**
 * Tunnel host implementation that uses data-plane relay
 *  to accept client connections.
 */
export declare class TunnelRelayTunnelHost extends TunnelConnectionSession implements TunnelHost {
    static readonly webSocketSubProtocol = "tunnel-relay-host";
    static readonly webSocketSubProtocolv2 = "tunnel-relay-host-v2-dev";
    /**
     * Ssh channel type in host relay ssh session where client session streams are passed.
     */
    static clientStreamChannelType: string;
    private readonly id;
    private readonly hostId;
    private readonly clientSessionPromises;
    private readonly reconnectableSessions;
    /**
     * Port Forwarders between host and clients
     */
    readonly remoteForwarders: Map<string, RemotePortForwarder>;
    /**
     * Private key used for connections.
     */
    hostPrivateKey?: KeyPair;
    /**
     * Public keys used for connections.
     */
    hostPublicKeys?: string[];
    /**
     * Promise task to get private key used for connections.
     */
    hostPrivateKeyPromise?: Promise<KeyPair>;
    private loopbackIp;
    private forwardConnectionsToLocalPortsValue;
    /**
     * Synthetic endpoint signature of the endpoint created when host connects.
     * undefined if the endpoint has not been created yet.
     */
    private endpointSignature?;
    constructor(managementClient: TunnelManagementClient, trace?: Trace);
    protected get connectionId(): string;
    /**
     * A value indicating whether the port-forwarding service forwards connections to local TCP sockets.
     * Forwarded connections are not possible if the host is not NodeJS (e.g. browser).
     * The default value for NodeJS hosts is true.
     */
    get forwardConnectionsToLocalPorts(): boolean;
    set forwardConnectionsToLocalPorts(value: boolean);
    /**
     * Connects to a tunnel as a host and starts accepting incoming connections
     * to local ports as defined on the tunnel.
     * @deprecated Use `connect()` instead.
     */
    start(tunnel: Tunnel): Promise<void>;
    /**
     * Connects to a tunnel as a host and starts accepting incoming connections
     * to local ports as defined on the tunnel.
     */
    connect(tunnel: Tunnel, options?: TunnelConnectionOptions, cancellation?: CancellationToken): Promise<void>;
    /**
     * Connect to the tunnel session with the tunnel connector.
     * @param tunnel Tunnel to use for the connection.
     *     Undefined if the connection information is already known and the tunnel is not needed.
     *     Tunnel object to get the connection information from that tunnel.
     */
    connectTunnelSession(tunnel?: Tunnel, options?: TunnelConnectionOptions, cancellation?: CancellationToken): Promise<void>;
    /**
     * Disposes this tunnel session, closing all client connections, the host SSH session, and deleting the endpoint.
     */
    dispose(): Promise<void>;
    private hostSession_ChannelOpening;
    protected onForwardedPortConnecting(e: ForwardedPortConnectingEventArgs): void;
    private acceptClientSession;
    /**
     * Creates an SSH server session for a client (V1 protocol), runs the session,
     * and waits for it to close.
     */
    private connectAndRunClientSession;
    private onSshClientAuthenticating;
    private onSshClientAuthenticated;
    private startForwardingExistingPorts;
    private onClientSessionRequest;
    private onSshChannelOpening;
    private onClientSessionReconnecting;
    private onClientSessionClosed;
    refreshPorts(cancellation?: CancellationToken): Promise<void>;
    protected forwardPort(pfs: PortForwardingService, port: TunnelPort): Promise<void>;
}
//# sourceMappingURL=tunnelRelayTunnelHost.d.ts.map