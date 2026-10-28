import { TunnelConnectionMode, Tunnel } from '@microsoft/dev-tunnels-contracts';
import { CancellationToken, SshStream } from '@microsoft/dev-tunnels-ssh';
import { ForwardedPortsCollection } from '@microsoft/dev-tunnels-ssh-tcp';
import { TunnelClient } from './tunnelClient';
import { PortForwardingEventArgs } from './portForwardingEventArgs';
import { TunnelConnectionBase } from './tunnelConnectionBase';
import { TunnelConnectionOptions } from './tunnelConnectionOptions';
import { Event } from 'vscode-jsonrpc';
/**
 * Tunnel client implementation that selects one of multiple available connection modes.
 */
export declare class MultiModeTunnelClient extends TunnelConnectionBase implements TunnelClient {
    forwardedPorts: ForwardedPortsCollection | undefined;
    clients: TunnelClient[];
    connectionModes: TunnelConnectionMode[];
    constructor();
    /**
     * A value indicating whether local connections for forwarded ports are accepted.
     * Local connections are not accepted if the host process is not NodeJS (e.g. browser).
     */
    get acceptLocalConnectionsForForwardedPorts(): boolean;
    set acceptLocalConnectionsForForwardedPorts(value: boolean);
    get localForwardingHostAddress(): string;
    set localForwardingHostAddress(value: string);
    connect(tunnel: Tunnel, options?: TunnelConnectionOptions, cancellation?: CancellationToken): Promise<void>;
    get portForwarding(): Event<PortForwardingEventArgs>;
    connectToForwardedPort(fowardedPort: number, cancellation?: CancellationToken): Promise<SshStream>;
    waitForForwardedPort(forwardedPort: number, cancellation?: CancellationToken): Promise<void>;
    refreshPorts(): Promise<void>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=multiModeTunnelClient.d.ts.map