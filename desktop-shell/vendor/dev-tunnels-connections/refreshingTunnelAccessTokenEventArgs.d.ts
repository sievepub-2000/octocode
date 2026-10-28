import { CancellationToken } from '@microsoft/dev-tunnels-ssh';
/**
 * Event args for tunnel access token refresh event.
 */
export declare class RefreshingTunnelAccessTokenEventArgs {
    /**
     * Tunnel access scope to get the token for.
     */
    readonly tunnelAccessScope: string;
    /**
     * Cancellation token that event handler may observe when it asynchronously fetches the tunnel access token.
     */
    readonly cancellation: CancellationToken;
    /**
     * Creates a new instance of RefreshingTunnelAccessTokenEventArgs class.
     */
    constructor(
    /**
     * Tunnel access scope to get the token for.
     */
    tunnelAccessScope: string, 
    /**
     * Cancellation token that event handler may observe when it asynchronously fetches the tunnel access token.
     */
    cancellation: CancellationToken);
    /**
     * Token promise the event handler may set to asynchnronously fetch the token.
     * The result of the promise may be a new tunnel access token or null if it couldn't get the token.
     */
    tunnelAccessToken?: Promise<string | null>;
}
//# sourceMappingURL=refreshingTunnelAccessTokenEventArgs.d.ts.map