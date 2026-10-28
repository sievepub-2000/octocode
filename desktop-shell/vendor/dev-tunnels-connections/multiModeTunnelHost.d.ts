import { CancellationToken } from '@microsoft/dev-tunnels-ssh';
import { Tunnel } from '@microsoft/dev-tunnels-contracts';
import { TunnelHost } from '.';
import { TunnelConnectionBase } from './tunnelConnectionBase';
import { TunnelConnectionOptions } from './tunnelConnectionOptions';
/**
 * Aggregation of multiple tunnel hosts.
 */
export declare class MultiModeTunnelHost extends TunnelConnectionBase implements TunnelHost {
    static hostId: string;
    hosts: TunnelHost[];
    constructor();
    /**
     * @deprecated Use `connect()` instead.
     */
    start(tunnel: Tunnel): Promise<void>;
    connect(tunnel: Tunnel, options?: TunnelConnectionOptions, cancellation?: CancellationToken): Promise<void>;
    refreshPorts(): Promise<void>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=multiModeTunnelHost.d.ts.map