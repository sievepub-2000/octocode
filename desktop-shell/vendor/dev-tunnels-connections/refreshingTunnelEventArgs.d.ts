import { Tunnel } from '@microsoft/dev-tunnels-contracts';
import { TunnelManagementClient } from '@microsoft/dev-tunnels-management';
import { CancellationToken } from '@microsoft/dev-tunnels-ssh';
/**
 * Event args for tunnel refresh event.
 */
export declare class RefreshingTunnelEventArgs {
    /**
     * Tunnel access scope to get the token for.
     */
    readonly tunnelAccessScope: string;
    /**
     * Tunnel being refreshed.
     */
    readonly tunnel: Tunnel | null;
    /**
     * A value indicating whether ports need to be included into the refreshed tunnel.
     */
    readonly includePorts: boolean;
    /**
     * Management client used for connections.
     */
    readonly managementClient?: TunnelManagementClient | undefined;
    /**
     * Cancellation token that event handler may observe when it asynchronously fetches the tunnel access token.
     */
    readonly cancellation?: CancellationToken | undefined;
    /**
     * Creates a new instance of RefreshingTunnelAccessTokenEventArgs class.
     */
    constructor(
    /**
     * Tunnel access scope to get the token for.
     */
    tunnelAccessScope: string, 
    /**
     * Tunnel being refreshed.
     */
    tunnel: Tunnel | null, 
    /**
     * A value indicating whether ports need to be included into the refreshed tunnel.
     */
    includePorts: boolean, 
    /**
     * Management client used for connections.
     */
    managementClient?: TunnelManagementClient | undefined, 
    /**
     * Cancellation token that event handler may observe when it asynchronously fetches the tunnel access token.
     */
    cancellation?: CancellationToken | undefined);
    /**
     * Tunnel promise the event handler may set to asynchnronously fetch the tunnel.
     * The result of the promise may be a new tunnel or null if it couldn't get the tunnel.
     */
    tunnelPromise?: Promise<Tunnel | null>;
}
//# sourceMappingURL=refreshingTunnelEventArgs.d.ts.map