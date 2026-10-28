import { CancellationToken } from 'vscode-jsonrpc';
import { ConnectionStatus } from './connectionStatus';
import { ConnectionStatusChangedEventArgs } from './connectionStatusChangedEventArgs';
import { TunnelConnection } from './tunnelConnection';
import { RefreshingTunnelAccessTokenEventArgs } from './refreshingTunnelAccessTokenEventArgs';
import { RetryingTunnelConnectionEventArgs } from './retryingTunnelConnectionEventArgs';
import { ForwardedPortConnectingEventArgs } from '@microsoft/dev-tunnels-ssh-tcp';
import { SshKeepAliveEventArgs } from './sshKeepAliveEventArgs';
/**
 * Tunnel connection base class.
 */
export declare class TunnelConnectionBase implements TunnelConnection {
    /**
     * Gets tunnel access scope for this tunnel session.
     */
    readonly tunnelAccessScope: string;
    private readonly disposeCts;
    private status;
    private error?;
    private readonly refreshingTunnelAccessTokenEmitter;
    private readonly connectionStatusChangedEmitter;
    private readonly retryingTunnelConnectionEmitter;
    private readonly forwardedPortConnectingEmitter;
    private readonly keepAliveFailedEmitter;
    private readonly keepAliveSucceededEmitter;
    protected constructor(
    /**
     * Gets tunnel access scope for this tunnel session.
     */
    tunnelAccessScope: string);
    /**
     * Gets a value indicathing that this tunnel connection session is disposed.
     */
    get isDisposed(): boolean;
    protected get isRefreshingTunnelAccessTokenEventHandled(): boolean;
    /**
     * Gets dispose cancellation token.
     */
    protected get disposeToken(): CancellationToken;
    /**
     * Gets the connection status.
     */
    get connectionStatus(): ConnectionStatus;
    /**
     * Sets the connection status.
     * Throws CancellationError if the session is disposed and the status being set is not ConnectionStatus.Disconnected.
     */
    protected set connectionStatus(value: ConnectionStatus);
    /**
     * Gets the error that caused disconnection.
     * Undefined if not yet connected or disconnection was caused by disposing of this object.
     */
    get disconnectError(): Error | undefined;
    /**
     * Sets the error that caused disconnection.
     */
    protected set disconnectError(e: Error | undefined);
    /**
     * Event for refreshing the tunnel access token.
     * The tunnel client will fire this event when it is not able to use the access token it got from the tunnel.
     */
    readonly refreshingTunnelAccessToken: import("vscode-jsonrpc").Event<RefreshingTunnelAccessTokenEventArgs>;
    /**
     * Connection status changed event.
     */
    readonly connectionStatusChanged: import("vscode-jsonrpc").Event<ConnectionStatusChangedEventArgs>;
    /**
     * Event raised when a tunnel connection attempt failed and is about to be retried.
     *  An event handler can cancel the retry by setting {@link RetryingTunnelConnectionEventArgs.retry} to false.
     */
    readonly retryingTunnelConnection: import("vscode-jsonrpc").Event<RetryingTunnelConnectionEventArgs>;
    /**
     * An event which fires when a connection is made to the forwarded port.
     */
    readonly forwardedPortConnecting: import("vscode-jsonrpc").Event<ForwardedPortConnectingEventArgs>;
    /**
     * Event raised when a keep-alive message response is not received.
     */
    readonly keepAliveFailed: import("vscode-jsonrpc").Event<SshKeepAliveEventArgs>;
    /**
     * Event raised when a keep-alive message response is received.
     */
    readonly keepAliveSucceeded: import("vscode-jsonrpc").Event<SshKeepAliveEventArgs>;
    protected onForwardedPortConnecting(e: ForwardedPortConnectingEventArgs): void;
    /**
     * Raises the keep-alive failed event.
     */
    protected onKeepAliveFailed(count: number): void;
    /**
     * Raises the keep-alive succeeded event.
     */
    protected onKeepAliveSucceeded(count: number): void;
    /**
     * Closes and disposes the tunnel session.
     */
    dispose(): Promise<void>;
    /**
     *  Notifies about a connection retry, giving the relay client a chance to delay or cancel it.
     */
    onRetrying(event: RetryingTunnelConnectionEventArgs): void;
    /**
     * Gets the fresh tunnel access token or undefined if it cannot.
     */
    protected getFreshTunnelAccessToken(cancellation: CancellationToken): Promise<string | null | undefined>;
    /**
     * Event fired when the connection status has changed.
     */
    protected onConnectionStatusChanged(previousStatus: ConnectionStatus, status: ConnectionStatus): void;
    /**
     * Throws CancellationError if the tunnel connection is disposed.
     */
    protected throwIfDisposed(message: string, stack?: string): void;
}
//# sourceMappingURL=tunnelConnectionBase.d.ts.map