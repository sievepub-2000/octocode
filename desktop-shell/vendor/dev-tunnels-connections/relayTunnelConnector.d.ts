import { CancellationToken } from '@microsoft/dev-tunnels-ssh';
import { TunnelConnector } from './tunnelConnector';
import { TunnelSession } from './tunnelSession';
import { TunnelConnectionOptions } from './tunnelConnectionOptions';
export declare const maxReconnectDelayMs = 13000;
/**
 * Tunnel connector that connects a tunnel session to a web socket stream in the tunnel Relay service.
 */
export declare class RelayTunnelConnector implements TunnelConnector {
    private readonly tunnelSession;
    constructor(tunnelSession: TunnelSession);
    private get trace();
    /**
     * Connect or reconnect tunnel SSH session.
     * @param isReconnect A value indicating if this is a reconnect (true) or regular connect (false).
     * @param cancellation Cancellation token.
     */
    connectSession(isReconnect: boolean, options?: TunnelConnectionOptions, cancellation?: CancellationToken): Promise<void>;
}
//# sourceMappingURL=relayTunnelConnector.d.ts.map